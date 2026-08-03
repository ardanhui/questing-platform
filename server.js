require('dotenv').config();
const express = require('express');
const initSqlJs = require('sql.js');
const { ethers } = require('ethers');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── Database ──────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'questing.db');
let db;

function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}
function loadDb(sql) {
  if (fs.existsSync(DB_PATH)) {
    db = new sql.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new sql.Database();
  }
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  initSchema();
  saveDb();
}
function initSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS quests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kol_handle TEXT NOT NULL DEFAULT '',
    kol_tweet_url TEXT DEFAULT '',
    required_keywords TEXT NOT NULL,
    banned_keywords TEXT DEFAULT '[]',
    min_chars INTEGER DEFAULT 500,
    max_chars INTEGER DEFAULT 0,
    reward_amount REAL NOT NULL,
    reward_token TEXT NOT NULL DEFAULT 'ETH',
    reward_token_address TEXT,
    reward_chain TEXT DEFAULT 'base',
    rpc_url TEXT,
    total_reward_pool REAL NOT NULL,
    remaining_pool REAL NOT NULL,
    reward_type TEXT NOT NULL DEFAULT 'fixed',
    winner_count INTEGER DEFAULT 0,
    max_submissions INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    starts_at TEXT,
    ends_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id INTEGER NOT NULL,
    user_wallet TEXT NOT NULL,
    user_x_handle TEXT,
    tweet_url TEXT NOT NULL,
    tweet_id TEXT NOT NULL,
    tweet_text TEXT,
    tweet_author TEXT,
    tweet_chars INTEGER,
    keywords_found TEXT,
    verified INTEGER DEFAULT 0,
    reject_reason TEXT,
    reward_sent INTEGER DEFAULT 0,
    reward_tx_hash TEXT,
    reward_amount_sent REAL,
    engagement_score REAL DEFAULT 0,
    engagement_likes INTEGER DEFAULT 0,
    engagement_retweets INTEGER DEFAULT 0,
    engagement_replies INTEGER DEFAULT 0,
    engagement_quotes INTEGER DEFAULT 0,
    engagement_views INTEGER DEFAULT 0,
    rank INTEGER,
    submitted_at TEXT DEFAULT (datetime('now')),
    verified_at TEXT,
    rewarded_at TEXT,
    claimed INTEGER DEFAULT 0,
    FOREIGN KEY (quest_id) REFERENCES quests(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS performance_config (
    quest_id INTEGER PRIMARY KEY,
    weight_likes REAL DEFAULT 1,
    weight_retweets REAL DEFAULT 2,
    weight_replies REAL DEFAULT 1.5,
    weight_quotes REAL DEFAULT 3,
    weight_views REAL DEFAULT 0.01,
    FOREIGN KEY (quest_id) REFERENCES quests(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    twitter_id TEXT,
    twitter_handle TEXT,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(wallet_address)
  )`);
  const existing = queryOne("SELECT id FROM admins LIMIT 1");
  if (!existing) {
    run("INSERT INTO admins (username, password_hash) VALUES ('admin', 'admin123')");
  }
}

// sql.js wrappers
function query(sql, ...args) {
  const stmt = db.prepare(sql);
  if (args.length) stmt.bind(args.map(a => a === undefined ? null : a));
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function queryOne(sql, ...args) {
  const rows = query(sql, ...args);
  return rows[0] || null;
}
function run(sql, ...args) {
  db.run(sql, args.map(a => a === undefined ? null : a));
}

// ── X API ─────────────────────────────────────────────────
const X_BEARER = process.env.X_API_BEARER_TOKEN || '';
const TEST_MODE = process.env.TEST_MODE === 'true';

async function xApiGet(path, params = '') {
  // Test mode: fake responses for local development
  if (TEST_MODE && path.startsWith('tweets/')) {
    const tweetId = path.split('/')[1]?.split('?')[0];
    return {
      data: {
        id: tweetId,
        text: 'IDO and SPWAY are leading the charge in crypto innovation. The future of blockchain depends on platforms like these. Decentralized finance is reshaping how we think about money and ownership. Crypto future is bright.',
        author_id: 'test123',
        created_at: new Date().toISOString(),
        public_metrics: { like_count: 10, retweet_count: 3, reply_count: 2, quote_count: 1, impression_count: 100 }
      },
      includes: { users: [{ id: 'test123', username: 'ardanhui' }] }
    };
  }

  const fullPath = `/2/${path}${params ? '?' + params : ''}`;
  // Use the caller's auth header if provided, otherwise app Bearer Token
  const res = await twitterFetch(fullPath, {
    headers: { Authorization: `Bearer ${X_BEARER}` }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`X API ${res.status}: ${err.substring(0, 200)}`);
  }
  return res.json();
}

// Fetch tweet using either user's OAuth token (preferred) or app Bearer Token
async function fetchTweetWithAuth(tweetId, userToken) {
  const authToken = userToken || X_BEARER;
  const fullPath = `/2/tweets/${tweetId}?tweet.fields=text,author_id,created_at,public_metrics&expansions=author_id&user.fields=username`;
  const res = await twitterFetch(fullPath, {
    headers: { Authorization: `Bearer ${authToken}` }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`X API ${res.status}: ${err.substring(0, 200)}`);
  }
  const data = await res.json();
  if (!data.data) throw new Error('Tweet not found');
  const user = (data.includes?.users || []).find(u => u.id === data.data.author_id);
  return {
    id: data.data.id,
    text: data.data.text,
    author_id: data.data.author_id,
    author_handle: user?.username || null,
    created_at: data.data.created_at,
    metrics: data.data.public_metrics || null
  };
}

async function fetchTweet(tweetId, userToken) {
  if (TEST_MODE && tweetId) {
    return {
      id: tweetId,
      text: 'IDO and SPWAY are leading the charge in crypto innovation. The future of blockchain depends on platforms like these. Decentralized finance is reshaping how we think about money and ownership. Crypto future is bright.',
      author_id: 'test123',
      author_handle: 'ardanhui',
      created_at: new Date().toISOString(),
      metrics: { like_count: 10, retweet_count: 3, reply_count: 2, quote_count: 1, impression_count: 100 }
    };
  }
  return fetchTweetWithAuth(tweetId, userToken);
}
async function fetchEngagement(tweetId, userToken) {
  if (TEST_MODE) {
    return { like_count: 10, retweet_count: 3, reply_count: 2, quote_count: 1, impression_count: 100 };
  }
  const authToken = userToken || X_BEARER;
  const data = await twitterFetch(`/2/tweets/${tweetId}?tweet.fields=public_metrics`, {
    headers: { Authorization: `Bearer ${authToken}` }
  });
  if (!data.ok) return null;
  const json = await data.json();
  return json.data?.public_metrics || null;
}
function parseTweetUrl(url) {
  const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
  return match ? match[1] : null;
}
function verifyTweetContent(text, requiredKeywords, bannedKeywords, minChars, maxChars) {
  const lower = text.toLowerCase();
  const found = requiredKeywords.filter(kw => lower.includes(kw.toLowerCase()));
  const missing = requiredKeywords.filter(kw => !lower.includes(kw.toLowerCase()));
  const banned = bannedKeywords.filter(kw => lower.includes(kw.toLowerCase()));
  const charCount = text.length;
  const errors = [];
  if (missing.length > 0) errors.push(`Missing keywords: ${missing.join(', ')}`);
  if (banned.length > 0) errors.push(`Contains banned words: ${banned.join(', ')}`);
  if (charCount < minChars) errors.push(`Tweet too short: ${charCount}/${minChars} chars`);
  if (maxChars > 0 && charCount > maxChars) errors.push(`Tweet too long: ${charCount}/${maxChars} chars`);
  return { valid: errors.length === 0, found, missing, banned, charCount, errors };
}

// ── Twitter API DNS workaround ───────────────────────────
// Route all Twitter API calls through Cloudflare Worker relay
const TWITTER_RELAY = process.env.TWITTER_RELAY_URL || '';
async function twitterFetch(path, options = {}) {
  const baseUrl = TWITTER_RELAY || 'https://api.twitter.com';
  const url = baseUrl + path;

  let body = options.body || null;
  if (body instanceof URLSearchParams) body = body.toString();

  const fetchRes = await fetch(url, {
    method: options.method || 'GET',
    headers: { ...options.headers },
    body
  });
  const text = await fetchRes.text();
  return {
    ok: fetchRes.ok,
    status: fetchRes.status,
    json: () => JSON.parse(text),
    text: () => text
  };
}

// ── PKCE OAuth State ─────────────────────────────────────
const oauthStates = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of oauthStates) {
    if (val.expires < now) oauthStates.delete(key);
  }
}, 300_000);

function base64URL(input) {
  return Buffer.isBuffer(input) ? input.toString('base64url') : input;
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}
function randomBytes(n) {
  return crypto.randomBytes(n).toString('base64url');
}

// ── Twitter OAuth 2.0 ─────────────────────────────────────
const TWITTER_CLIENT_ID = process.env.TWITTER_CLIENT_ID || '';
const TWITTER_CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET || '';
const TWITTER_CALLBACK = process.env.TWITTER_CALLBACK_URL || 'http://localhost:3000/auth/twitter/callback';

app.get('/auth/twitter', (req, res) => {
  if (!TWITTER_CLIENT_ID) {
    return res.status(500).send('Twitter OAuth not configured. Set TWITTER_CLIENT_ID in .env');
  }
  const { wallet, return_to } = req.query;
  if (!wallet) return res.status(400).send('Missing wallet address');

  const codeVerifier = randomBytes(96);
  const codeChallenge = base64URL(sha256(codeVerifier));
  const state = randomBytes(32);

  oauthStates.set(state, {
    codeVerifier,
    wallet,
    returnTo: return_to || '/',
    expires: Date.now() + 600_000
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: TWITTER_CLIENT_ID,
    redirect_uri: TWITTER_CALLBACK,
    scope: 'tweet.read users.read offline.access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  res.redirect(`https://twitter.com/i/oauth2/authorize?${params}`);
});

app.get('/auth/twitter/callback', (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    const msg = String(error_description || error).replace(/</g, '&lt;');
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Auth Denied</title><style>body{font-family:sans-serif;padding:40px;text-align:center;background:#0a0a0f;color:#e0e0e0}a{color:#1d9bf0}</style></head><body><h2>Authorization Denied</h2><p>'+msg+'</p><a href="/">Back to quests</a></body></html>');
  }

  const session = oauthStates.get(state);
  if (!session || session.expires < Date.now()) {
    oauthStates.delete(state);
    return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Expired</title><style>body{font-family:sans-serif;padding:40px;text-align:center;background:#0a0a0f;color:#e0e0e0}a{color:#1d9bf0}</style></head><body><h2>Session Expired</h2><p>Please try again.</p><a href="/">Back to quests</a></body></html>');
  }
  oauthStates.delete(state);

  // Browser calls our server proxy, which reaches api.twitter.com via DNS workaround
  const esc = (v) => JSON.stringify(v);

  const js = 'var code='+esc(code)+';var cv='+esc(session.codeVerifier)+';var wallet='+esc(session.wallet)+';var rt='+esc(session.returnTo)+';' +
    '(function(){var s=document.getElementById("s");s.textContent="Completing authorization...";' +
    'fetch("/api/auth/twitter-exchange",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:code,code_verifier:cv,wallet:wallet})}).then(function(r){if(!r.ok)return r.text().then(function(e){try{var j=JSON.parse(e);throw new Error(j.error||e)}catch(_){throw new Error(e.substring(0,200))}});return r.json()}).then(function(d){' +
    'var sep=rt.indexOf("?")>=0?"&":"?";window.location.href=rt+sep+"wallet="+encodeURIComponent(wallet)+"&x_auth=1&x_handle="+encodeURIComponent(d.handle)})' +
    '.catch(function(e){s.innerHTML="Error: "+e.message+\'<br><br><a href="\'+rt+\'" style="color:#1d9bf0">Try again</a>\';document.querySelector(".spinner").style.display="none"})})();';

  const page = '<!DOCTYPE html>\n<html><head><meta charset="UTF-8"><title>Completing X Auth...</title>\n<style>body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e0e0e0;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;text-align:center}.spinner{border:3px solid #333;border-top:3px solid #1d9bf0;border-radius:50%;width:40px;height:40px;animation:spin .8s linear infinite;margin:0 auto 16px}@keyframes spin{to{transform:rotate(360deg)}}</style></head>\n<body><div><div class="spinner"></div><p id="s">Completing X authorization...</p></div>\n<script>'+js+'\n</script></body></html>';
  res.send(page);
});

// Server-side token exchange via DNS-bypassed fetch
app.post('/api/auth/twitter-exchange', async (req, res) => {
  const { code, code_verifier, wallet } = req.body;
  if (!code || !code_verifier || !wallet) {
    return res.status(400).json({ error: 'Missing code, code_verifier, or wallet' });
  }
  try {
    // Exchange code for token
    const tokenRes = await twitterFetch('/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(TWITTER_CLIENT_ID + ':' + TWITTER_CLIENT_SECRET).toString('base64')
      },
      body: new URLSearchParams({
        code, grant_type: 'authorization_code',
        client_id: TWITTER_CLIENT_ID,
        redirect_uri: TWITTER_CALLBACK,
        code_verifier
      })
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error('Token exchange failed: ' + errText.substring(0, 200));
    }
    const tokens = await tokenRes.json();

    // Fetch user profile
    const userRes = await twitterFetch('/2/users/me', {
      headers: { Authorization: 'Bearer ' + tokens.access_token }
    });
    if (!userRes.ok) throw new Error('Failed to fetch user profile');
    const userData = await userRes.json();

    const twitterId = userData.data.id;
    const twitterHandle = userData.data.username;

    // Store in DB
    run(`INSERT OR REPLACE INTO user_sessions (wallet_address, twitter_id, twitter_handle, access_token, refresh_token, token_expires_at) VALUES (?,?,?,?,?, datetime('now', ? || ' seconds'))`,
      wallet, twitterId, twitterHandle,
      tokens.access_token, tokens.refresh_token || null,
      String(tokens.expires_in || 7200));
    saveDb();

    res.json({ ok: true, handle: twitterHandle });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/status', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.json({ connected: false, wallet: false, twitter: false });
  const user = queryOne('SELECT wallet_address, twitter_handle, token_expires_at FROM user_sessions WHERE wallet_address = ?', wallet);
  res.json({
    wallet: true,
    twitter: !!user && new Date(user.token_expires_at + 'Z') > new Date(),
    twitter_handle: user?.twitter_handle || null
  });
});

app.post('/api/auth/verify-wallet', (req, res) => {
  const { address, signature, message } = req.body;
  if (!address || !signature || !message) {
    return res.status(400).json({ error: 'Missing address, signature, or message' });
  }
  try {
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return res.status(400).json({ error: 'Signature verification failed' });
    }
    res.json({ verified: true, address: recovered });
  } catch (err) {
    res.status(400).json({ error: `Invalid signature: ${err.message}` });
  }
});

// ── Auth ──────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.admin_password || '';
  if (pw !== (process.env.ADMIN_PASSWORD || 'admin123'))
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Public API ────────────────────────────────────────────
app.get('/api/quests', (req, res) => {
  const quests = query(`SELECT q.*,
    (SELECT COUNT(*) FROM submissions WHERE quest_id = q.id AND verified = 1) as verified_count,
    (SELECT COUNT(*) FROM submissions WHERE quest_id = q.id) as total_submissions
    FROM quests q WHERE status = 'active' ORDER BY created_at DESC`);
  res.json(quests);
});

app.get('/api/quests/:id', (req, res) => {
  const quest = queryOne(`SELECT q.*,
    (SELECT COUNT(*) FROM submissions WHERE quest_id = q.id AND verified = 1) as verified_count,
    (SELECT COUNT(*) FROM submissions WHERE quest_id = q.id) as total_submissions
    FROM quests q WHERE id = ?`, parseInt(req.params.id));
  if (!quest) return res.status(404).json({ error: 'Quest not found' });
  res.json(quest);
});

app.post('/api/submissions', async (req, res) => {
  const { quest_id, tweet_url, wallet_address, x_handle } = req.body;
  if (!quest_id || !tweet_url || !wallet_address)
    return res.status(400).json({ error: 'Missing quest_id, tweet_url, or wallet_address' });

  const quest = queryOne('SELECT * FROM quests WHERE id = ?', parseInt(quest_id));
  if (!quest) return res.status(404).json({ error: 'Quest not found' });
  if (quest.status !== 'active') return res.status(400).json({ error: 'Quest is not active' });

  if (quest.max_submissions > 0) {
    const row = queryOne('SELECT COUNT(*) as c FROM submissions WHERE quest_id = ? AND verified = 1', quest.id);
    if (row.c >= quest.max_submissions)
      return res.status(400).json({ error: 'Quest has reached maximum submissions' });
  }

  if (quest.reward_type === 'fixed' && quest.remaining_pool < quest.reward_amount)
    return res.status(400).json({ error: 'Quest reward pool exhausted' });

  const existing = queryOne(
    'SELECT id FROM submissions WHERE quest_id = ? AND user_wallet = ? AND verified = 1',
    quest.id, wallet_address);
  if (existing) return res.status(400).json({ error: 'This wallet has already completed this quest' });

  const tweetId = parseTweetUrl(tweet_url);
  if (!tweetId) return res.status(400).json({ error: 'Invalid tweet URL. Use https://x.com/user/status/12345' });

  // Get user's OAuth token for tweet verification (preferred over Bearer Token)
  const authUser = queryOne('SELECT twitter_handle, twitter_id, access_token FROM user_sessions WHERE wallet_address = ?', wallet_address);
  const userToken = authUser?.access_token || null;
  // Manual handle or OAuth handle to verify against
  const claimedHandle = (x_handle || authUser?.twitter_handle || '').toLowerCase();

  try {
    const tweet = await fetchTweet(tweetId, userToken);

    if (claimedHandle && !TEST_MODE && tweet.author_handle?.toLowerCase() !== claimedHandle) {
      return res.status(400).json({
        error: `Tweet author @${tweet.author_handle} doesn't match your claimed X account @${claimedHandle}`
      });
    }

    const requiredKeywords = JSON.parse(quest.required_keywords);
    const bannedKeywords = JSON.parse(quest.banned_keywords || '[]');
    const result = verifyTweetContent(tweet.text, requiredKeywords, bannedKeywords, quest.min_chars, quest.max_chars);

    const isFixed = quest.reward_type === 'fixed';
    const m = tweet.metrics || {};
    run(`INSERT INTO submissions
      (quest_id, user_wallet, tweet_url, tweet_id, tweet_text, tweet_author, tweet_chars,
       keywords_found, verified, reject_reason, engagement_likes, engagement_retweets,
       engagement_replies, engagement_quotes, engagement_views, verified_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`,
      quest.id, wallet_address, tweet_url, tweetId, tweet.text, tweet.author_handle,
      tweet.text.length, JSON.stringify(result.found), result.valid ? 1 : -1,
      result.valid ? null : result.errors.join('; '),
      m.like_count || 0, m.retweet_count || 0, m.reply_count || 0,
      m.quote_count || 0, m.impression_count || 0);
    saveDb();

    if (!result.valid) {
      return res.json({
        status: 'rejected',
        tweet: { text: tweet.text, author: tweet.author_handle, chars: tweet.text.length },
        errors: result.errors
      });
    }

    if (isFixed) {
      try {
        const txHash = await sendReward(quest, wallet_address);
        run(`UPDATE submissions SET reward_sent = 1, reward_tx_hash = ?, reward_amount_sent = ?, rewarded_at = datetime('now')
          WHERE tweet_id = ? AND quest_id = ?`, txHash, quest.reward_amount, tweetId, quest.id);
        run('UPDATE quests SET remaining_pool = remaining_pool - ? WHERE id = ?', quest.reward_amount, quest.id);
        saveDb();
        return res.json({
          status: 'verified_and_rewarded',
          reward_type: 'fixed',
          tweet: { text: tweet.text, author: tweet.author_handle, chars: tweet.text.length },
          keywords_found: result.found,
          reward: { amount: quest.reward_amount, token: quest.reward_token, tx_hash: txHash }
        });
      } catch (rewardErr) {
        return res.json({
          status: 'verified_reward_pending',
          reward_type: 'fixed',
          tweet: { text: tweet.text, author: tweet.author_handle, chars: tweet.text.length },
          keywords_found: result.found,
          reward_error: rewardErr.message
        });
      }
    }

    return res.json({
      status: 'verified_pending_ranking',
      reward_type: 'performance',
      tweet: { text: tweet.text, author: tweet.author_handle, chars: tweet.text.length },
      keywords_found: result.found,
      message: 'Your tweet is verified. Rewards will be distributed after the campaign ends based on engagement ranking.'
    });

  } catch (err) {
    return res.status(500).json({ error: `Verification failed: ${err.message}` });
  }
});

app.get('/api/submissions/:wallet', (req, res) => {
  const subs = query(`SELECT s.*, q.title as quest_title, q.reward_token, q.reward_type,
    q.status as quest_status, q.ends_at
    FROM submissions s JOIN quests q ON s.quest_id = q.id
    WHERE s.user_wallet = ? ORDER BY s.submitted_at DESC`, req.params.wallet);
  res.json(subs);
});

app.post('/api/claim', async (req, res) => {
  const { submission_id, wallet_address } = req.body;
  const sub = queryOne(`SELECT s.*, q.reward_amount, q.reward_token, q.reward_token_address,
    q.reward_chain, q.rpc_url, q.status as quest_status, q.reward_type
    FROM submissions s JOIN quests q ON s.quest_id = q.id
    WHERE s.id = ? AND s.user_wallet = ?`, parseInt(submission_id), wallet_address);

  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  if (sub.reward_type !== 'performance') return res.status(400).json({ error: 'This quest uses fixed rewards, not claimable' });
  if (sub.quest_status !== 'completed') return res.status(400).json({ error: 'Campaign not yet ended' });
  if (sub.verified !== 1) return res.status(400).json({ error: 'Submission not verified' });
  if (sub.claimed === 1) return res.status(400).json({ error: 'Already claimed' });
  if (!sub.rank || sub.rank > (sub.winner_count || 0)) return res.status(400).json({ error: 'Not a winner. Your rank: ' + (sub.rank || 'unranked') });

  try {
    const txHash = await sendReward(sub, wallet_address);
    run(`UPDATE submissions SET reward_sent = 1, reward_tx_hash = ?, reward_amount_sent = ?,
      rewarded_at = datetime('now'), claimed = 1 WHERE id = ?`,
      txHash, sub.reward_amount, parseInt(submission_id));
    saveDb();
    res.json({ status: 'claimed', reward: { amount: sub.reward_amount, token: sub.reward_token, tx_hash: txHash } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/quests/:id/leaderboard', (req, res) => {
  const quest = queryOne('SELECT * FROM quests WHERE id = ?', parseInt(req.params.id));
  if (!quest) return res.status(404).json({ error: 'Quest not found' });

  if (quest.reward_type === 'performance' && quest.status !== 'completed') {
    return res.json({ status: 'pending', message: 'Leaderboard available after campaign ends', rankings: [] });
  }

  const subs = query(`SELECT id, user_wallet, tweet_author, tweet_url, engagement_score,
    engagement_likes, engagement_retweets, engagement_replies, engagement_quotes,
    engagement_views, rank, reward_sent
    FROM submissions WHERE quest_id = ? AND verified = 1
    ORDER BY rank ASC NULLS LAST, engagement_score DESC`, quest.id);

  res.json({ status: 'ready', reward_type: quest.reward_type, winner_count: quest.winner_count, rankings: subs });
});

// ── Deposit / Escrow ──────────────────────────────────────
function getEscrowAddress() {
  const privateKey = process.env.ESCROW_PRIVATE_KEY;
  if (!privateKey) return null;
  try {
    return new ethers.Wallet(privateKey).address;
  } catch { return null; }
}

app.get('/api/admin/escrow', adminAuth, async (req, res) => {
  const address = getEscrowAddress();
  if (!address) {
    return res.json({ configured: false, address: null, balance: null, token_balances: [] });
  }

  try {
    // Get all unique chains + tokens used in quests
    const quests = query('SELECT DISTINCT reward_chain, rpc_url, reward_token, reward_token_address FROM quests');

    const chainBalances = {};
    for (const q of quests) {
      const chain = q.reward_chain || 'base';
      const rpcUrl = q.rpc_url ||
        { base: 'https://mainnet.base.org', ethereum: 'https://eth.llamarpc.com', bsc: 'https://bsc-dataseed.binance.org', polygon: 'https://polygon-rpc.com', arbitrum: 'https://arb1.arbitrum.io/rpc', optimism: 'https://mainnet.optimism.io', avalanche: 'https://api.avax.network/ext/bc/C/rpc', fantom: 'https://rpc.fantom.network', solana: null }[chain] ||
        'https://mainnet.base.org';

      if (!rpcUrl || chain === 'solana') continue;

      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const balance = await provider.getBalance(address);
        const ethBal = parseFloat(ethers.formatEther(balance));

        if (!chainBalances[chain]) {
          chainBalances[chain] = { rpc_url: rpcUrl, native: { symbol: chain === 'bsc' ? 'BNB' : chain === 'polygon' ? 'MATIC' : chain === 'avalanche' ? 'AVAX' : chain === 'fantom' ? 'FTM' : 'ETH', balance: 0 }, tokens: {} };
        }
        chainBalances[chain].native.balance += ethBal;
      } catch (e) {
        if (!chainBalances[chain]) {
          chainBalances[chain] = { rpc_url: rpcUrl, native: { symbol: 'ETH', balance: null }, tokens: {}, error: e.message };
        }
      }
    }

    // Summarize quest funding status
    const fundingStatus = query(`SELECT id, title, reward_type, reward_token, total_reward_pool, remaining_pool,
      (SELECT COALESCE(SUM(reward_amount_sent),0) FROM submissions WHERE quest_id = quests.id AND reward_sent = 1) as total_sent
      FROM quests`);

    res.json({
      configured: true,
      address,
      chains: chainBalances,
      quest_funding: fundingStatus
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/deposit', adminAuth, (req, res) => {
  const { quest_id, amount } = req.body;
  if (!quest_id || amount === undefined) {
    return res.status(400).json({ error: 'Missing quest_id or amount' });
  }

  const quest = queryOne('SELECT * FROM quests WHERE id = ?', parseInt(quest_id));
  if (!quest) return res.status(404).json({ error: 'Quest not found' });

  const newRemaining = quest.remaining_pool + parseFloat(amount);
  const newTotal = quest.total_reward_pool + parseFloat(amount);

  run('UPDATE quests SET remaining_pool = ?, total_reward_pool = ? WHERE id = ?',
    newRemaining, newTotal, quest.id);
  saveDb();

  res.json({
    status: 'ok',
    quest_id: quest.id,
    deposited: parseFloat(amount),
    new_remaining_pool: newRemaining,
    new_total_pool: newTotal
  });
});

app.post('/api/admin/sync-balance', adminAuth, async (req, res) => {
  const address = getEscrowAddress();
  if (!address) return res.status(400).json({ error: 'Escrow wallet not configured' });

  const { quest_id } = req.body;
  const quest = queryOne('SELECT * FROM quests WHERE id = ?', parseInt(quest_id));
  if (!quest) return res.status(404).json({ error: 'Quest not found' });

  const chain = quest.reward_chain || 'base';
  const rpcUrl = quest.rpc_url || {
    base: 'https://mainnet.base.org', ethereum: 'https://eth.llamarpc.com',
    bsc: 'https://bsc-dataseed.binance.org', polygon: 'https://polygon-rpc.com',
    arbitrum: 'https://arb1.arbitrum.io/rpc', optimism: 'https://mainnet.optimism.io',
    avalanche: 'https://api.avax.network/ext/bc/C/rpc', fantom: 'https://rpc.fantom.network'
  }[chain] || 'https://mainnet.base.org';

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const nativeBalance = parseFloat(ethers.formatEther(await provider.getBalance(address)));

    let tokenBalance = -1;
    if (quest.reward_token_address) {
      const erc20 = new ethers.Contract(quest.reward_token_address, ['function balanceOf(address) view returns (uint256)'], provider);
      tokenBalance = parseFloat(ethers.formatUnits(await erc20.balanceOf(address), 18));
    }

    res.json({
      chain, rpc_url: rpcUrl, address,
      native_balance: nativeBalance,
      token_balance: tokenBalance,
      quest: { id: quest.id, remaining_pool: quest.remaining_pool, total_pool: quest.total_reward_pool }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin API ─────────────────────────────────────────────
app.get('/api/admin/quests', adminAuth, (req, res) => {
  const status = req.query.status || 'all';
  const quests = status === 'all'
    ? query(`SELECT q.*, (SELECT COUNT(*) FROM submissions WHERE quest_id = q.id) as sub_count
        FROM quests q ORDER BY created_at DESC`)
    : query(`SELECT q.*, (SELECT COUNT(*) FROM submissions WHERE quest_id = q.id) as sub_count
        FROM quests q WHERE status = ? ORDER BY created_at DESC`, status);
  res.json(quests);
});

app.post('/api/admin/quests', adminAuth, (req, res) => {
  const {
    title, description, kol_handle, kol_tweet_url,
    required_keywords, banned_keywords, min_chars, max_chars,
    reward_amount, reward_token, reward_token_address, reward_chain,
    rpc_url, total_reward_pool, max_submissions,
    reward_type, winner_count, starts_at, ends_at,
    weight_likes, weight_retweets, weight_replies, weight_quotes, weight_views
  } = req.body;

  if (!title || !required_keywords || !reward_amount || !total_reward_pool || !reward_type)
    return res.status(400).json({ error: 'Missing required fields' });
  if (!['fixed', 'performance'].includes(reward_type))
    return res.status(400).json({ error: 'reward_type must be "fixed" or "performance"' });
  if (reward_type === 'performance' && !winner_count)
    return res.status(400).json({ error: 'winner_count required for performance quests' });

  run(`INSERT INTO quests
    (title, description, kol_handle, kol_tweet_url, required_keywords, banned_keywords,
     min_chars, max_chars, reward_amount, reward_token, reward_token_address, reward_chain,
     rpc_url, total_reward_pool, remaining_pool, reward_type, winner_count, max_submissions,
     starts_at, ends_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    title, description || '', kol_handle || '', kol_tweet_url || '',
    JSON.stringify(required_keywords), JSON.stringify(banned_keywords || []),
    min_chars || 500, max_chars || 0, reward_amount, reward_token || 'ETH',
    reward_token_address || null, reward_chain || 'base', rpc_url || null,
    total_reward_pool, total_reward_pool, reward_type, winner_count || 0,
    max_submissions || 0, starts_at || null, ends_at || null);
  saveDb();

  const row = queryOne('SELECT MAX(id) as id FROM quests');

  if (reward_type === 'performance') {
    run(`INSERT OR REPLACE INTO performance_config
      (quest_id, weight_likes, weight_retweets, weight_replies, weight_quotes, weight_views)
      VALUES (?,?,?,?,?,?)`,
      row.id,
      weight_likes ?? 1, weight_retweets ?? 2, weight_replies ?? 1.5,
      weight_quotes ?? 3, weight_views ?? 0.01);
    saveDb();
  }

  res.json({ id: row.id, message: 'Quest created' });
});

app.patch('/api/admin/quests/:id', adminAuth, (req, res) => {
  const { status } = req.body;
  if (!['active', 'paused', 'completed'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  run('UPDATE quests SET status = ? WHERE id = ?', status, parseInt(req.params.id));
  saveDb();
  res.json({ message: 'Quest updated' });
});

app.get('/api/admin/submissions', adminAuth, (req, res) => {
  const questId = req.query.quest_id;
  const subs = questId
    ? query(`SELECT s.*, q.title as quest_title, q.reward_type FROM submissions s
        JOIN quests q ON s.quest_id = q.id WHERE s.quest_id = ? ORDER BY s.submitted_at DESC`, parseInt(questId))
    : query(`SELECT s.*, q.title as quest_title, q.reward_type FROM submissions s
        JOIN quests q ON s.quest_id = q.id ORDER BY s.submitted_at DESC LIMIT 200`);
  res.json(subs);
});

app.post('/api/admin/calculate-rankings', adminAuth, async (req, res) => {
  const { quest_id } = req.body;
  const quest = queryOne('SELECT * FROM quests WHERE id = ?', parseInt(quest_id));
  if (!quest) return res.status(404).json({ error: 'Quest not found' });
  if (quest.reward_type !== 'performance')
    return res.status(400).json({ error: 'Only for performance-based quests' });

  const config = queryOne('SELECT * FROM performance_config WHERE quest_id = ?', quest.id) || {
    weight_likes: 1, weight_retweets: 2, weight_replies: 1.5, weight_quotes: 3, weight_views: 0.01
  };

  const subs = query(
    'SELECT id, tweet_id FROM submissions WHERE quest_id = ? AND verified = 1', quest.id);

  if (!subs.length) return res.json({ status: 'ok', message: 'No verified submissions', ranked: 0 });

  const results = [];
  for (const sub of subs) {
    try {
      const metrics = await fetchEngagement(sub.tweet_id);
      if (metrics) {
        const score =
          (metrics.like_count || 0) * config.weight_likes +
          (metrics.retweet_count || 0) * config.weight_retweets +
          (metrics.reply_count || 0) * config.weight_replies +
          (metrics.quote_count || 0) * config.weight_quotes +
          (metrics.impression_count || 0) * config.weight_views;
        results.push({
          id: sub.id, score,
          likes: metrics.like_count || 0,
          retweets: metrics.retweet_count || 0,
          replies: metrics.reply_count || 0,
          quotes: metrics.quote_count || 0,
          views: metrics.impression_count || 0
        });
      }
    } catch (e) {
      console.error(`Failed to fetch engagement for tweet ${sub.tweet_id}: ${e.message}`);
    }
  }

  results.sort((a, b) => b.score - a.score);
  for (let i = 0; i < results.length; i++) {
    run(`UPDATE submissions SET
      engagement_score = ?, engagement_likes = ?, engagement_retweets = ?,
      engagement_replies = ?, engagement_quotes = ?, engagement_views = ?, rank = ?
      WHERE id = ?`,
      results[i].score, results[i].likes, results[i].retweets,
      results[i].replies, results[i].quotes, results[i].views,
      i + 1, results[i].id);
  }
  saveDb();

  const winnerCount = quest.winner_count;
  res.json({
    status: 'ok',
    ranked: results.length,
    winners: results.slice(0, winnerCount).map((r, i) => ({
      rank: i + 1, submission_id: r.id, score: r.score,
      likes: r.likes, retweets: r.retweets, replies: r.replies, quotes: r.quotes, views: r.views
    }))
  });
});

app.post('/api/admin/retry-reward', adminAuth, async (req, res) => {
  const { submission_id } = req.body;
  const sub = queryOne(`SELECT s.*, q.reward_amount, q.reward_token, q.reward_token_address,
    q.rpc_url, q.reward_chain FROM submissions s JOIN quests q ON s.quest_id = q.id
    WHERE s.id = ? AND s.verified = 1 AND s.reward_sent = 0`, parseInt(submission_id));
  if (!sub) return res.status(404).json({ error: 'Not found or already rewarded' });

  try {
    const txHash = await sendReward(sub, sub.user_wallet);
    run(`UPDATE submissions SET reward_sent = 1, reward_tx_hash = ?, reward_amount_sent = ?,
      rewarded_at = datetime('now') WHERE id = ?`, txHash, sub.reward_amount, parseInt(submission_id));
    saveDb();
    res.json({ status: 'rewarded', tx_hash: txHash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const t = queryOne('SELECT COALESCE(SUM(total_reward_pool),0) as a, COALESCE(SUM(remaining_pool),0) as b FROM quests');
  res.json({
    total_quests: queryOne('SELECT COUNT(*) as c FROM quests').c,
    active_quests: queryOne("SELECT COUNT(*) as c FROM quests WHERE status = 'active'").c,
    total_submissions: queryOne('SELECT COUNT(*) as c FROM submissions').c,
    verified: queryOne('SELECT COUNT(*) as c FROM submissions WHERE verified = 1').c,
    rejected: queryOne('SELECT COUNT(*) as c FROM submissions WHERE verified = -1').c,
    rewards_sent: queryOne('SELECT COUNT(*) as c FROM submissions WHERE reward_sent = 1').c,
    total_rewarded: (t.a || 0) - (t.b || 0)
  });
});

// ── Reward Distribution ───────────────────────────────────
async function sendReward(quest, walletAddress) {
  const privateKey = process.env.ESCROW_PRIVATE_KEY;
  if (!privateKey) throw new Error('ESCROW_PRIVATE_KEY not configured');
  const rpcUrl = quest.rpc_url || process.env.ESCROW_RPC_URL || 'https://mainnet.base.org';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  if (!quest.reward_token_address || quest.reward_token === 'ETH') {
    const tx = await wallet.sendTransaction({
      to: walletAddress,
      value: ethers.parseEther(quest.reward_amount.toString())
    });
    await tx.wait();
    return tx.hash;
  }

  const erc20Abi = ['function transfer(address to, uint256 amount) returns (bool)'];
  const token = new ethers.Contract(quest.reward_token_address, erc20Abi, wallet);
  const amount = ethers.parseUnits(quest.reward_amount.toString(), 18);
  const tx = await token.transfer(walletAddress, amount);
  await tx.wait();
  return tx.hash;
}

// ── Frontend ──────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/quest/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'quest.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ─────────────────────────────────────────────────
async function start() {
  const sql = await initSqlJs();
  loadDb(sql);
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Questing Platform — http://localhost:${PORT}`);
    console.log(`📊 Admin: http://localhost:${PORT}/admin`);
    console.log(`🐦 X OAuth: ${TWITTER_CLIENT_ID ? '✓' : '✗ NOT configured'}`);
    console.log(`💰 Escrow: ${process.env.ESCROW_PRIVATE_KEY ? '✓' : '✗ NOT configured'}`);
  });
}
start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
