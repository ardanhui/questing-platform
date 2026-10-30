'use strict';
/**
 * On-chain payouts from the escrow wallet. Supports native coin and any ERC-20
 * (decimals are read from the contract, never assumed).
 */
const { ethers } = require('ethers');
const config = require('./config');
const log = require('./log');

const CHAINS = {
  base:           { id: 8453,  name: 'Base',             symbol: 'ETH',  rpc: 'https://mainnet.base.org',           explorer: 'https://basescan.org' },
  'base-sepolia': { id: 84532, name: 'Base Sepolia',     symbol: 'ETH',  rpc: 'https://sepolia.base.org',           explorer: 'https://sepolia.basescan.org', testnet: true },
  ethereum:       { id: 1,     name: 'Ethereum',         symbol: 'ETH',  rpc: 'https://eth.llamarpc.com',           explorer: 'https://etherscan.io' },
  sepolia:        { id: 11155111, name: 'Sepolia',       symbol: 'ETH',  rpc: 'https://rpc.sepolia.org',            explorer: 'https://sepolia.etherscan.io', testnet: true },
  arbitrum:       { id: 42161, name: 'Arbitrum One',     symbol: 'ETH',  rpc: 'https://arb1.arbitrum.io/rpc',       explorer: 'https://arbiscan.io' },
  optimism:       { id: 10,    name: 'OP Mainnet',       symbol: 'ETH',  rpc: 'https://mainnet.optimism.io',        explorer: 'https://optimistic.etherscan.io' },
  polygon:        { id: 137,   name: 'Polygon',          symbol: 'POL',  rpc: 'https://polygon-rpc.com',            explorer: 'https://polygonscan.com' },
  bsc:            { id: 56,    name: 'BNB Smart Chain',  symbol: 'BNB',  rpc: 'https://bsc-dataseed.binance.org',   explorer: 'https://bscscan.com' },
  avalanche:      { id: 43114, name: 'Avalanche C-Chain', symbol: 'AVAX', rpc: 'https://api.avax.network/ext/bc/C/rpc', explorer: 'https://snowtrace.io' },
};

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const providers = new Map();
const decimalsCache = new Map();

function chainInfo(chain) {
  return CHAINS[chain] || CHAINS[config.defaultChain] || CHAINS.base;
}

function rpcFor(chain, override) {
  if (override) return override;
  if (config.escrow.rpcUrl && (chain === config.defaultChain || !CHAINS[chain])) return config.escrow.rpcUrl;
  return chainInfo(chain).rpc;
}

function getProvider(chain, rpcOverride) {
  const url = rpcFor(chain, rpcOverride);
  if (!providers.has(url)) providers.set(url, new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true }));
  return providers.get(url);
}

function escrowAddress() {
  if (!config.escrow.privateKey) return null;
  try { return new ethers.Wallet(config.escrow.privateKey).address; } catch { return null; }
}

function escrowSigner(chain, rpcOverride) {
  if (!config.escrow.privateKey) throw new Error('Escrow wallet not configured (ESCROW_PRIVATE_KEY)');
  return new ethers.Wallet(config.escrow.privateKey, getProvider(chain, rpcOverride));
}

function isNative(tokenAddress) {
  return !tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000';
}

async function tokenDecimals(chain, tokenAddress, rpcOverride) {
  const key = `${chain}:${tokenAddress.toLowerCase()}`;
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, getProvider(chain, rpcOverride));
  const d = Number(await c.decimals());
  decimalsCache.set(key, d);
  return d;
}

async function tokenSymbol(chain, tokenAddress, rpcOverride) {
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, getProvider(chain, rpcOverride));
  return c.symbol();
}

function explorerTx(chain, hash) {
  return `${chainInfo(chain).explorer}/tx/${hash}`;
}
function explorerAddress(chain, addr) {
  return `${chainInfo(chain).explorer}/address/${addr}`;
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`), { code: 'TIMEOUT' })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Send `amount` (human units) of native coin or ERC-20 to `to`.
 * `onBroadcast(hash)` fires as soon as the transaction is in the mempool so the
 * caller can persist the hash before waiting on confirmations. If confirmation
 * takes longer than `waitMs` the promise rejects with code TX_PENDING (and the
 * hash) — the transaction may still land, so callers must reconcile, not resend.
 */
async function sendPayment({ chain, rpcUrl, tokenAddress, amount, to, onBroadcast = () => {}, waitMs = 120_000 }) {
  if (!ethers.isAddress(to)) throw new Error(`Invalid recipient address ${to}`);
  const signer = escrowSigner(chain, rpcUrl);
  const amountStr = String(amount);
  let tx;
  if (isNative(tokenAddress)) {
    const value = ethers.parseEther(amountStr);
    const bal = await withTimeout(signer.provider.getBalance(signer.address), 20_000, 'Balance check');
    if (bal < value) throw new Error(`Escrow balance too low on ${chainInfo(chain).name}: has ${ethers.formatEther(bal)}, needs ${amountStr}`);
    tx = await withTimeout(signer.sendTransaction({ to, value }), 60_000, 'Broadcast');
  } else {
    const decimals = await withTimeout(tokenDecimals(chain, tokenAddress, rpcUrl), 20_000, 'Reading token decimals');
    const units = ethers.parseUnits(amountStr, decimals);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const bal = await withTimeout(token.balanceOf(signer.address), 20_000, 'Token balance check');
    if (bal < units) throw new Error(`Escrow token balance too low: has ${ethers.formatUnits(bal, decimals)}, needs ${amountStr}`);
    tx = await withTimeout(token.transfer(to, units), 60_000, 'Broadcast');
  }
  log.info(`payout tx ${tx.hash} → ${to} (${amountStr} on ${chain})`);
  onBroadcast(tx.hash);
  let receipt;
  try {
    receipt = await withTimeout(tx.wait(config.escrow.confirmations), waitMs, 'Confirmation');
  } catch (e) {
    if (e.code === 'TIMEOUT') throw Object.assign(new Error(`Transaction ${tx.hash} broadcast, confirmation pending`), { code: 'TX_PENDING', hash: tx.hash });
    throw e;
  }
  if (!receipt || receipt.status !== 1) throw new Error(`Transaction ${tx.hash} reverted`);
  return tx.hash;
}

/** Receipt for a hash, or null while it is still pending. */
async function getReceipt(chain, rpcUrl, hash) {
  return withTimeout(getProvider(chain, rpcUrl).getTransactionReceipt(hash), 20_000, 'Receipt lookup');
}

/** Native + token balances of the escrow wallet for every (chain, token) pair in use. */
async function escrowBalances(pairs) {
  const address = escrowAddress();
  if (!address) return { configured: false, address: null, balances: [] };
  const balances = [];
  const seen = new Set();
  for (const p of pairs) {
    const key = `${p.chain}:${(p.token_address || 'native').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const info = chainInfo(p.chain);
    const entry = { chain: p.chain, chain_name: info.name, token: p.token || info.symbol, token_address: p.token_address || null, balance: null, error: null, testnet: Boolean(info.testnet) };
    try {
      const provider = getProvider(p.chain, p.rpc_url);
      if (isNative(p.token_address)) {
        entry.balance = parseFloat(ethers.formatEther(await withTimeout(provider.getBalance(address), 8000, 'RPC')));
        entry.token = info.symbol;
      } else {
        const d = await withTimeout(tokenDecimals(p.chain, p.token_address, p.rpc_url), 8000, 'RPC');
        const c = new ethers.Contract(p.token_address, ERC20_ABI, provider);
        entry.balance = parseFloat(ethers.formatUnits(await withTimeout(c.balanceOf(address), 8000, 'RPC'), d));
      }
    } catch (e) {
      entry.error = e.shortMessage || e.message;
    }
    balances.push(entry);
  }
  return { configured: true, address, balances };
}

module.exports = { CHAINS, chainInfo, escrowAddress, sendPayment, getReceipt, escrowBalances, tokenDecimals, tokenSymbol, explorerTx, explorerAddress, isNative };
