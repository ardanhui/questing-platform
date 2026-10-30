'use strict';
/**
 * Central configuration. Everything is read once from the environment
 * (and the `--demo` CLI flag) so the rest of the app never touches process.env.
 */
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const env = process.env;
const argv = process.argv.slice(2);

const bool = (v, fallback = false) => {
  if (v === undefined || v === null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
};
const int = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

const root = path.resolve(__dirname, '..');
const demo = argv.includes('--demo') || bool(env.DEMO_MODE);
const port = int(env.PORT, 3000);

let sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
  // In demo mode a stable secret keeps sessions alive across restarts.
  // In production we generate one per boot and warn — set SESSION_SECRET.
  sessionSecret = demo ? 'demo-session-secret-change-me' : crypto.randomBytes(32).toString('hex');
}

const config = {
  root,
  demo,
  port,
  baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  sessionSecret,
  sessionSecretGenerated: !env.SESSION_SECRET && !demo,
  adminPassword: env.ADMIN_PASSWORD || (demo ? 'admin123' : ''),
  dbPath: env.DB_PATH || path.join(root, 'data', 'questing.db'),
  logLevel: env.LOG_LEVEL || 'info',

  brand: {
    name: env.BRAND_NAME || 'Questboard',
    tagline: env.BRAND_TAGLINE || 'Post about the projects you believe in. Get paid on-chain when it checks out.',
  },

  x: {
    // Read access (tweet lookup + metrics). Either name works.
    bearer: env.X_BEARER_TOKEN || env.X_API_BEARER_TOKEN || '',
    clientId: env.X_CLIENT_ID || env.TWITTER_CLIENT_ID || '',
    clientSecret: env.X_CLIENT_SECRET || env.TWITTER_CLIENT_SECRET || '',
    callbackUrl: env.X_CALLBACK_URL || env.TWITTER_CALLBACK_URL || '',
    // Point this at a relay if your host cannot reach api.x.com directly.
    apiBase: (env.X_API_BASE || env.TWITTER_RELAY_URL || 'https://api.x.com').replace(/\/$/, ''),
    authorizeUrl: env.X_AUTHORIZE_URL || 'https://x.com/i/oauth2/authorize',
    // auto | xapi | oembed | mock
    provider: (env.TWEET_PROVIDER || 'auto').toLowerCase(),
    oembedBase: env.X_OEMBED_BASE || 'https://publish.twitter.com/oembed',
  },

  escrow: {
    privateKey: env.ESCROW_PRIVATE_KEY || '',
    rpcUrl: env.ESCROW_RPC_URL || '',
    confirmations: int(env.TX_CONFIRMATIONS, 1),
  },

  defaultChain: env.DEFAULT_CHAIN || 'base',

  scheduler: {
    enabled: !bool(env.DISABLE_SCHEDULER),
    tickMs: int(env.SCHEDULER_TICK_MS, 15000),
    engagementRefreshMinutes: int(env.ENGAGEMENT_REFRESH_MINUTES, 15),
    rewardMaxAttempts: int(env.REWARD_MAX_ATTEMPTS, 5),
  },
};

if (!config.x.callbackUrl) config.x.callbackUrl = `${config.baseUrl}/auth/x/callback`;

config.features = {
  demoWallet: demo,
  demoXLink: demo,
  xOAuth: Boolean(config.x.clientId),
  escrow: Boolean(config.escrow.privateKey),
};

module.exports = config;
