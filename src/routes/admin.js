'use strict';
const express = require('express');
const config = require('../config');
const auth = require('../auth');
const svc = require('../quests');
const chain = require('../chain');
const tweets = require('../tweets');
const db = require('../db');
const scheduler = require('../scheduler');

const router = express.Router();
const { AppError } = svc;

// ── session ───────────────────────────────────────────────
router.post('/api/admin/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  let token;
  try {
    token = auth.adminLogin(ip, (req.body || {}).password);
  } catch (e) {
    throw new AppError(e.message, 401, 'ADMIN_LOGIN');
  }
  auth.setCookie(res, auth.ADMIN_COOKIE, token, { maxAge: auth.ADMIN_TTL });
  res.json({ ok: true });
});
router.post('/api/admin/logout', (req, res) => {
  auth.clearCookie(res, auth.ADMIN_COOKIE);
  res.json({ ok: true });
});
router.get('/api/admin/session', (req, res) => {
  res.json({ admin: req.isAdmin });
});

router.use('/api/admin', auth.requireAdmin);

// ── overview ──────────────────────────────────────────────
router.get('/api/admin/overview', (req, res) => {
  const stats = svc.adminStats();
  const quests = svc.listQuests({ includeAll: true });
  const now = Date.now();
  const attention = [];
  for (const r of svc.listRewards({ status: 'failed', limit: 20 })) {
    attention.push({ level: 'error', type: 'reward_failed', message: `Payout of ${r.amount} ${r.token} to ${svc.maskWallet(r.wallet)} failed: ${r.error}`, reward_id: r.id, quest_id: r.quest_id });
  }
  for (const q of quests) {
    if (q.status === 'active' && q.reward_type === 'fixed' && q.remaining_pool < q.reward_amount) {
      attention.push({ level: 'warn', type: 'pool_empty', message: `"${q.title}" is active but its pool cannot cover another reward`, quest_id: q.id });
    }
    if (q.status === 'active' && q.ends_at && new Date(q.ends_at).getTime() - now < 24 * 3600e3 && new Date(q.ends_at).getTime() > now) {
      attention.push({ level: 'info', type: 'ending_soon', message: `"${q.title}" ends ${new Date(q.ends_at).toUTCString()}`, quest_id: q.id });
    }
    if (q.status === 'completed' && q.reward_type === 'performance' && !q.distributed_at) {
      attention.push({ level: 'warn', type: 'undistributed', message: `"${q.title}" has ended but winner payouts have not been distributed`, quest_id: q.id });
    }
  }
  if (!config.features.escrow) attention.push({ level: config.demo ? 'info' : 'error', type: 'no_escrow', message: config.demo ? 'Demo mode: payouts are simulated (no escrow key configured)' : 'ESCROW_PRIVATE_KEY is not set — payouts will queue until it is' });
  if (!config.demo && !config.features.xOAuth) attention.push({ level: 'error', type: 'no_oauth', message: 'X sign-in is not configured (X_CLIENT_ID) — participants cannot link accounts' });
  if (config.sessionSecretGenerated) attention.push({ level: 'warn', type: 'session_secret', message: 'SESSION_SECRET is not set — sessions reset on every restart' });

  res.json({
    stats,
    attention,
    events: svc.recentEvents(40),
    quests: quests.map((q) => svc.serializeQuest(q, { admin: true })),
  });
});

// ── quests ────────────────────────────────────────────────
router.get('/api/admin/quests', (req, res) => {
  res.json({ quests: svc.listQuests({ includeAll: true, status: req.query.status ? String(req.query.status) : null }).map((q) => svc.serializeQuest(q, { admin: true })) });
});
router.post('/api/admin/quests', (req, res) => {
  const q = svc.createQuest(req.body || {});
  res.status(201).json({ quest: svc.serializeQuest(q, { admin: true }) });
});
router.get('/api/admin/quests/:id', (req, res) => {
  const q = svc.mustGetQuest(req.params.id);
  res.json({
    quest: svc.serializeQuest(q, { admin: true }),
    submissions: svc.questSubmissions(q.id).map((s) => svc.serializeSubmission(s, { admin: true })),
    leaderboard: svc.leaderboard(q, { limit: 200 }),
  });
});
router.patch('/api/admin/quests/:id', (req, res) => {
  const q = svc.updateQuest(req.params.id, req.body || {});
  res.json({ quest: svc.serializeQuest(q, { admin: true }) });
});
router.delete('/api/admin/quests/:id', (req, res) => {
  svc.deleteQuest(req.params.id);
  res.json({ ok: true });
});
router.post('/api/admin/quests/:id/status', async (req, res) => {
  const q = await svc.setQuestStatus(req.params.id, String((req.body || {}).status || ''));
  svc.processRewardQueue().catch(() => {});
  res.json({ quest: svc.serializeQuest(q, { admin: true }) });
});
router.post('/api/admin/quests/:id/fund', (req, res) => {
  const q = svc.fundQuest(req.params.id, (req.body || {}).amount);
  res.json({ quest: svc.serializeQuest(q, { admin: true }) });
});
router.post('/api/admin/quests/:id/refresh-engagement', async (req, res) => {
  const q = svc.mustGetQuest(req.params.id);
  const out = await svc.refreshEngagement(q);
  res.json({ ...out, quest: svc.serializeQuest(svc.getQuest(q.id), { admin: true }), leaderboard: svc.leaderboard(svc.getQuest(q.id), { limit: 200 }) });
});
router.post('/api/admin/quests/:id/distribute', (req, res) => {
  const out = svc.distributeRewards(req.params.id);
  svc.processRewardQueue().catch(() => {});
  res.json({ ...out, quest: svc.serializeQuest(svc.getQuest(req.params.id), { admin: true }) });
});

// ── submissions & rewards ─────────────────────────────────
router.get('/api/admin/submissions', (req, res) => {
  const { status, quest_id, q } = req.query;
  res.json({ submissions: svc.allSubmissions({ status: status ? String(status) : null, quest_id: quest_id ? Number(quest_id) : null, search: q ? String(q) : null }).map((s) => svc.serializeSubmission(s, { admin: true })) });
});
router.get('/api/admin/rewards', (req, res) => {
  res.json({ rewards: svc.listRewards({ status: req.query.status ? String(req.query.status) : null }) });
});
router.post('/api/admin/rewards/:id/retry', (req, res) => {
  const r = svc.retryReward(req.params.id);
  svc.processRewardQueue().catch(() => {});
  res.json({ reward: svc.serializeReward(r) });
});
router.post('/api/admin/rewards/process', async (req, res) => {
  const sent = await svc.processRewardQueue();
  res.json({ sent });
});

// ── treasury ──────────────────────────────────────────────
router.get('/api/admin/treasury', async (req, res) => {
  const pairs = db.all("SELECT DISTINCT reward_chain AS chain, reward_token AS token, reward_token_address AS token_address, rpc_url FROM quests");
  const balances = await chain.escrowBalances(pairs);
  const liabilities = db.all("SELECT reward_chain AS chain, reward_token AS token, reward_token_address AS token_address, SUM(remaining_pool) AS open_pool FROM quests WHERE status IN ('active','scheduled','paused') GROUP BY reward_chain, reward_token, reward_token_address");
  const queued = db.all("SELECT chain, token, token_address, SUM(amount) AS amount, COUNT(*) AS n FROM rewards WHERE status IN ('queued','sending','failed') GROUP BY chain, token, token_address");
  const paid = db.all("SELECT chain, token, SUM(amount) AS amount, COUNT(*) AS n FROM rewards WHERE status IN ('sent','simulated') GROUP BY chain, token");
  res.json({
    configured: balances.configured,
    address: balances.address,
    explorer_url: balances.address ? chain.explorerAddress(config.defaultChain, balances.address) : null,
    balances: balances.balances.map((b) => {
      const key = (x) => `${x.chain}:${(x.token_address || '').toLowerCase()}`;
      const liab = liabilities.find((l) => key(l) === key(b));
      const q = queued.find((l) => key(l) === key(b));
      const open = (liab ? liab.open_pool : 0) + (q ? q.amount : 0);
      return { ...b, committed: open, shortfall: b.balance !== null ? Math.max(0, open - b.balance) : null };
    }),
    liabilities, queued, paid,
    quests: svc.listQuests({ includeAll: true }).map((q) => ({ id: q.id, title: q.title, status: q.status, reward_type: q.reward_type, token: q.reward_token, chain: q.reward_chain, total_pool: q.total_reward_pool, remaining_pool: q.remaining_pool, paid_out: q.paid_out })),
  });
});

// ── system ────────────────────────────────────────────────
router.get('/api/admin/system', (req, res) => {
  res.json({
    mode: config.demo ? 'demo' : 'production',
    base_url: config.baseUrl,
    provider: tweets.providerInfo(),
    x_oauth: { configured: config.features.xOAuth, callback_url: config.x.callbackUrl, api_base: config.x.apiBase },
    escrow: { configured: config.features.escrow, address: chain.escrowAddress(), default_chain: config.defaultChain, confirmations: config.escrow.confirmations },
    scheduler: scheduler.state(),
    session_secret_generated: config.sessionSecretGenerated,
    db_path: config.dbPath,
    node: process.version,
    uptime_s: Math.round(process.uptime()),
  });
});
router.post('/api/admin/test-lookup', async (req, res) => {
  const parsed = tweets.parseTweetUrl(String((req.body || {}).tweet_url || ''));
  if (!parsed) throw new AppError('Not a valid X post URL');
  const t = await tweets.fetchTweet(parsed.id, { text: (req.body || {}).post_text, handle: parsed.handle || 'demo_user' });
  res.json({ tweet: t });
});
router.post('/api/admin/scheduler/tick', async (req, res) => {
  res.json(await scheduler.tick());
});

module.exports = router;
