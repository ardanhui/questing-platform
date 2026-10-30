'use strict';
/**
 * Service layer: quest lifecycle, the submission pipeline, engagement
 * ranking and the reward queue. Routes stay thin and call into here.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const db = require('./db');
const config = require('./config');
const log = require('./log');
const chain = require('./chain');
const tweets = require('./tweets');
const { verifyPost, scoreOf, parseList, normHandle } = require('./verify');

class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const QUEST_STATUSES = ['scheduled', 'active', 'paused', 'completed'];

// ── serialization ─────────────────────────────────────────
function serializeQuest(q, { admin = false } = {}) {
  if (!q) return null;
  const info = chain.chainInfo(q.reward_chain);
  const isPerf = q.reward_type === 'performance';
  const out = {
    id: q.id,
    title: q.title,
    description: q.description,
    kol_handle: q.kol_handle,
    kol_tweet_url: q.kol_tweet_url,
    cover: q.cover,
    rules: {
      required_keywords: parseList(q.required_keywords),
      keyword_mode: q.keyword_mode,
      banned_keywords: parseList(q.banned_keywords),
      must_mention: parseList(q.must_mention),
      min_chars: q.min_chars,
      max_chars: q.max_chars,
      require_after_start: Boolean(q.require_after_start),
    },
    reward: {
      type: q.reward_type,
      amount: q.reward_amount,
      token: q.reward_token,
      token_address: q.reward_token_address,
      chain: q.reward_chain,
      chain_name: info.name,
      testnet: Boolean(info.testnet),
      total_pool: q.total_reward_pool,
      remaining_pool: q.remaining_pool,
      winner_count: q.winner_count,
      weights: isPerf ? {
        likes: q.weight_likes, retweets: q.weight_retweets, replies: q.weight_replies, quotes: q.weight_quotes, views: q.weight_views,
      } : null,
    },
    limits: { max_submissions: q.max_submissions, max_per_wallet: q.max_per_wallet },
    status: q.status,
    starts_at: q.starts_at,
    ends_at: q.ends_at,
    finalized_at: q.finalized_at,
    distributed_at: q.distributed_at,
    engagement_refreshed_at: q.engagement_refreshed_at,
    created_at: q.created_at,
    stats: {
      verified: q.verified_count ?? 0,
      rejected: q.rejected_count ?? 0,
      participants: q.participant_count ?? 0,
      paid_out: q.paid_out ?? 0,
    },
  };
  if (admin) {
    out.rpc_url = q.rpc_url;
    out.auto_distribute = Boolean(q.auto_distribute);
    out.token_decimals = q.token_decimals;
    out.updated_at = q.updated_at;
  }
  return out;
}

function serializeReward(r) {
  if (!r) return null;
  const simulated = r.status === 'simulated';
  return {
    id: r.id,
    status: simulated ? 'sent' : r.status,
    simulated,
    amount: r.amount,
    token: r.token,
    chain: r.chain,
    chain_name: chain.chainInfo(r.chain).name,
    tx_hash: r.tx_hash,
    explorer_url: r.tx_hash && !simulated ? chain.explorerTx(r.chain, r.tx_hash) : null,
    error: r.status === 'failed' || (r.status === 'queued' && r.error) ? r.error : null,
    attempts: r.attempts,
    created_at: r.created_at,
    sent_at: r.sent_at,
  };
}

function serializeSubmission(s, { admin = false, owner = false } = {}) {
  if (!s) return null;
  const out = {
    id: s.id,
    quest_id: s.quest_id,
    quest_title: s.quest_title,
    reward_type: s.reward_type,
    wallet: admin || owner ? s.wallet : maskWallet(s.wallet),
    x_handle: s.x_handle,
    tweet_url: s.tweet_url,
    tweet_id: s.tweet_id,
    tweet_text: s.tweet_text,
    tweet_author: s.tweet_author,
    tweet_created_at: s.tweet_created_at,
    tweet_chars: s.tweet_chars,
    provider: s.provider,
    checks: safeJson(s.checks, []),
    status: s.status,
    reject_reason: s.reject_reason,
    engagement: { likes: s.likes, retweets: s.retweets, replies: s.replies, quotes: s.quotes, views: s.views, score: s.score, updated_at: s.engagement_updated_at },
    rank: s.rank,
    created_at: s.created_at,
    verified_at: s.verified_at,
    reward: s.reward_id ? serializeReward({
      id: s.reward_id, status: s.reward_status, amount: s.reward_amount, token: s.reward_token_sym, chain: s.reward_chain_name || s.reward_chain,
      tx_hash: s.reward_tx_hash, error: s.reward_error, attempts: s.reward_attempts, created_at: s.reward_created_at, sent_at: s.reward_sent_at,
    }) : null,
  };
  return out;
}

function maskWallet(w) {
  if (!w) return '';
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}
function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

const QUEST_SELECT = `
  SELECT q.*,
    (SELECT COUNT(*) FROM submissions s WHERE s.quest_id = q.id AND s.status = 'verified') AS verified_count,
    (SELECT COUNT(*) FROM submissions s WHERE s.quest_id = q.id AND s.status = 'rejected') AS rejected_count,
    (SELECT COUNT(DISTINCT wallet) FROM submissions s WHERE s.quest_id = q.id AND s.status = 'verified') AS participant_count,
    (SELECT COALESCE(SUM(amount),0) FROM rewards r WHERE r.quest_id = q.id AND r.status IN ('sent','simulated')) AS paid_out
  FROM quests q`;

const SUB_SELECT = `
  SELECT s.*, q.title AS quest_title, q.reward_type, q.reward_chain AS reward_chain_name,
    r.id AS reward_id, r.status AS reward_status, r.amount AS reward_amount, r.token AS reward_token_sym,
    r.chain AS reward_chain, r.tx_hash AS reward_tx_hash, r.error AS reward_error, r.attempts AS reward_attempts,
    r.created_at AS reward_created_at, r.sent_at AS reward_sent_at
  FROM submissions s
  JOIN quests q ON q.id = s.quest_id
  LEFT JOIN rewards r ON r.submission_id = s.id`;

// ── quests ────────────────────────────────────────────────
function listQuests({ status = null, includeAll = false } = {}) {
  let sql = QUEST_SELECT;
  const args = [];
  if (status) { sql += ' WHERE q.status = ?'; args.push(status); }
  else if (!includeAll) sql += " WHERE q.status IN ('scheduled','active','paused','completed')";
  sql += ` ORDER BY CASE q.status WHEN 'active' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, q.created_at DESC`;
  return db.all(sql, ...args);
}

function getQuest(id) {
  return db.get(`${QUEST_SELECT} WHERE q.id = ?`, Number(id));
}

function mustGetQuest(id) {
  const q = getQuest(id);
  if (!q) throw new AppError('Quest not found', 404, 'NOT_FOUND');
  return q;
}

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
/** Round token amounts to 12 decimals so repeated subtraction never drifts below a payable amount. */
const money = (v) => Math.round(Number(v) * 1e12) / 1e12;
const covers = (pool, amount) => money(pool) + 1e-9 >= money(amount);
const isoOrNull = (v) => {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError(`Invalid date: ${v}`);
  return d.toISOString();
};

function validateQuestInput(input, existing = null) {
  const q = {};
  q.title = String(input.title ?? existing?.title ?? '').trim();
  if (!q.title) throw new AppError('Title is required');
  if (q.title.length > 120) throw new AppError('Title must be 120 characters or fewer');
  q.description = String(input.description ?? existing?.description ?? '').trim();
  q.kol_handle = normHandle(input.kol_handle ?? existing?.kol_handle ?? '');
  q.kol_tweet_url = String(input.kol_tweet_url ?? existing?.kol_tweet_url ?? '').trim();
  if (q.kol_tweet_url && !tweets.parseTweetUrl(q.kol_tweet_url)) throw new AppError('KOL post URL is not a valid X post link');
  q.cover = String(input.cover ?? existing?.cover ?? '').trim().slice(0, 8);

  q.required_keywords = JSON.stringify(parseList(input.required_keywords ?? existing?.required_keywords ?? []));
  q.keyword_mode = (input.keyword_mode ?? existing?.keyword_mode) === 'any' ? 'any' : 'all';
  q.banned_keywords = JSON.stringify(parseList(input.banned_keywords ?? existing?.banned_keywords ?? []));
  q.must_mention = JSON.stringify(parseList(input.must_mention ?? existing?.must_mention ?? []).map(normHandle).filter(Boolean));
  q.min_chars = Math.max(0, Math.floor(num(input.min_chars ?? existing?.min_chars, 0)));
  q.max_chars = Math.max(0, Math.floor(num(input.max_chars ?? existing?.max_chars, 0)));
  if (q.max_chars && q.min_chars > q.max_chars) throw new AppError('Minimum length cannot exceed maximum length');
  q.require_after_start = (input.require_after_start ?? existing?.require_after_start ?? 1) ? 1 : 0;

  q.reward_type = input.reward_type ?? existing?.reward_type ?? 'fixed';
  if (!['fixed', 'performance'].includes(q.reward_type)) throw new AppError('reward_type must be "fixed" or "performance"');
  q.reward_amount = num(input.reward_amount ?? existing?.reward_amount, 0);
  if (!(q.reward_amount > 0)) throw new AppError('Reward amount must be greater than zero');
  q.reward_token = String(input.reward_token ?? existing?.reward_token ?? '').trim().toUpperCase().slice(0, 12);
  q.reward_token_address = String(input.reward_token_address ?? existing?.reward_token_address ?? '').trim() || null;
  if (q.reward_token_address && !ethers.isAddress(q.reward_token_address)) throw new AppError('Token contract address is not a valid address');
  q.reward_chain = String(input.reward_chain ?? existing?.reward_chain ?? config.defaultChain).trim().toLowerCase();
  q.rpc_url = String(input.rpc_url ?? existing?.rpc_url ?? '').trim() || null;
  if (!chain.CHAINS[q.reward_chain] && !q.rpc_url) throw new AppError(`Unknown chain "${q.reward_chain}" — pick a supported chain or provide an RPC URL`);
  if (!q.reward_token) q.reward_token = q.reward_token_address ? 'TOKEN' : chain.chainInfo(q.reward_chain).symbol;

  q.winner_count = Math.max(0, Math.floor(num(input.winner_count ?? existing?.winner_count, 0)));
  if (q.reward_type === 'performance' && q.winner_count < 1) throw new AppError('Performance quests need at least one winner');
  q.total_reward_pool = num(input.total_reward_pool ?? existing?.total_reward_pool, 0);
  const minPool = q.reward_type === 'performance' ? q.reward_amount * q.winner_count : q.reward_amount;
  if (q.total_reward_pool < minPool) throw new AppError(`Reward pool must cover at least ${minPool} ${q.reward_token}`);
  q.max_submissions = Math.max(0, Math.floor(num(input.max_submissions ?? existing?.max_submissions, 0)));
  q.max_per_wallet = Math.max(1, Math.floor(num(input.max_per_wallet ?? existing?.max_per_wallet, 1)));

  for (const w of ['likes', 'retweets', 'replies', 'quotes', 'views']) {
    const key = `weight_${w}`;
    const defaults = { likes: 1, retweets: 2, replies: 1.5, quotes: 3, views: 0.01 };
    q[key] = Math.max(0, num(input[key] ?? existing?.[key], defaults[w]));
  }
  q.auto_distribute = (input.auto_distribute ?? existing?.auto_distribute ?? 1) ? 1 : 0;

  q.starts_at = isoOrNull(input.starts_at ?? existing?.starts_at);
  q.ends_at = isoOrNull(input.ends_at ?? existing?.ends_at);
  if (q.starts_at && q.ends_at && q.ends_at <= q.starts_at) throw new AppError('End time must be after start time');
  return q;
}

function createQuest(input) {
  const q = validateQuestInput(input);
  const now = new Date().toISOString();
  let status = 'active';
  if (q.starts_at && q.starts_at > now) status = 'scheduled';
  if (input.status === 'paused') status = 'paused';
  const cols = Object.keys(q);
  const { lastId } = db.run(
    `INSERT INTO quests (${cols.join(',')}, remaining_pool, status) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`,
    ...cols.map((c) => q[c]), q.total_reward_pool, status,
  );
  db.event('quest.created', { quest_id: lastId, message: `Quest "${q.title}" created (${status})` });
  return getQuest(lastId);
}

function updateQuest(id, input) {
  const existing = mustGetQuest(id);
  const q = validateQuestInput(input, existing);
  // keep remaining pool consistent when the total pool changes
  const delta = q.total_reward_pool - existing.total_reward_pool;
  const remaining = money(existing.remaining_pool + delta);
  if (remaining < 0) throw new AppError('Cannot shrink the pool below what has already been paid or reserved');
  const cols = Object.keys(q);
  db.run(
    `UPDATE quests SET ${cols.map((c) => `${c} = ?`).join(', ')}, remaining_pool = ?, updated_at = ? WHERE id = ?`,
    ...cols.map((c) => q[c]), remaining, new Date().toISOString(), existing.id,
  );
  if (existing.status === 'scheduled' && (!q.starts_at || q.starts_at <= new Date().toISOString())) {
    db.run("UPDATE quests SET status = 'active' WHERE id = ?", existing.id);
  }
  db.event('quest.updated', { quest_id: existing.id, message: `Quest "${q.title}" updated` });
  return getQuest(existing.id);
}

function fundQuest(id, amount) {
  const q = mustGetQuest(id);
  const amt = num(amount, 0);
  if (!(amt > 0)) throw new AppError('Amount must be greater than zero');
  db.run('UPDATE quests SET total_reward_pool = ROUND(total_reward_pool + ?, 12), remaining_pool = ROUND(remaining_pool + ?, 12), updated_at = ? WHERE id = ?',
    amt, amt, new Date().toISOString(), q.id);
  db.event('quest.funded', { quest_id: q.id, message: `Pool for "${q.title}" topped up by ${amt} ${q.reward_token}` });
  return getQuest(q.id);
}

async function setQuestStatus(id, status, { reason = 'admin' } = {}) {
  const q = mustGetQuest(id);
  if (!QUEST_STATUSES.includes(status)) throw new AppError('Invalid status');
  if (q.status === 'completed') throw new AppError('Completed quests cannot be reopened');
  if (status === 'completed') return endQuest(q, { reason });
  if (status === 'scheduled') throw new AppError('Set a future start time to schedule a quest');
  db.run('UPDATE quests SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), q.id);
  db.event(`quest.${status}`, { quest_id: q.id, message: `Quest "${q.title}" ${status === 'active' ? 'activated' : status} (${reason})` });
  return getQuest(q.id);
}

async function endQuest(q, { reason = 'admin' } = {}) {
  if (q.reward_type === 'performance') {
    try { await refreshEngagement(q); } catch (e) { log.warn(`engagement refresh before finalizing quest ${q.id} failed: ${e.message}`); }
    finalizeRankings(q.id);
  }
  db.run("UPDATE quests SET status = 'completed', updated_at = ? WHERE id = ?", new Date().toISOString(), q.id);
  db.event('quest.completed', { quest_id: q.id, message: `Quest "${q.title}" ended (${reason})` });
  if (q.reward_type === 'performance' && q.auto_distribute) distributeRewards(q.id);
  return getQuest(q.id);
}

function deleteQuest(id) {
  const q = mustGetQuest(id);
  const subs = db.get('SELECT COUNT(*) AS c FROM submissions WHERE quest_id = ?', q.id).c;
  if (subs > 0) throw new AppError('Quests with submissions cannot be deleted — end them instead');
  db.run('DELETE FROM quests WHERE id = ?', q.id);
  db.event('quest.deleted', { quest_id: q.id, message: `Quest "${q.title}" deleted` });
}

// ── users ─────────────────────────────────────────────────
function getUser(wallet) {
  return db.get('SELECT * FROM users WHERE wallet = ?', wallet.toLowerCase());
}
function touchUser(wallet) {
  const w = wallet.toLowerCase();
  const now = new Date().toISOString();
  if (getUser(w)) db.run('UPDATE users SET last_seen_at = ? WHERE wallet = ?', now, w);
  else db.run('INSERT INTO users (wallet) VALUES (?)', w);
  return getUser(w);
}
function linkX(wallet, { id, handle, name = null, avatar = null, access = null, refresh = null, expiresIn = null }) {
  const w = wallet.toLowerCase();
  touchUser(w);
  const other = db.get('SELECT wallet FROM users WHERE x_user_id = ? AND wallet <> ?', id, w);
  if (other) throw new AppError(`@${handle} is already linked to another wallet (${maskWallet(other.wallet)})`, 409, 'X_ALREADY_LINKED');
  const exp = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
  db.run(`UPDATE users SET x_user_id = ?, x_handle = ?, x_name = ?, x_avatar = ?, x_access_token = ?, x_refresh_token = ?, x_token_expires_at = ?, x_linked_at = ? WHERE wallet = ?`,
    id, handle, name, avatar, access, refresh, exp, new Date().toISOString(), w);
  db.event('x.linked', { wallet: w, message: `@${handle} linked to ${maskWallet(w)}` });
  return getUser(w);
}
function unlinkX(wallet) {
  db.run('UPDATE users SET x_user_id = NULL, x_handle = NULL, x_name = NULL, x_avatar = NULL, x_access_token = NULL, x_refresh_token = NULL, x_token_expires_at = NULL, x_linked_at = NULL WHERE wallet = ?', wallet.toLowerCase());
}
function serializeUser(u) {
  if (!u) return null;
  return {
    wallet: u.wallet,
    x: u.x_handle ? { handle: u.x_handle, name: u.x_name, avatar: u.x_avatar, linked_at: u.x_linked_at } : null,
    created_at: u.created_at,
  };
}

// ── submissions ───────────────────────────────────────────
function userSubmissions(wallet) {
  return db.all(`${SUB_SELECT} WHERE s.wallet = ? ORDER BY s.created_at DESC`, wallet.toLowerCase());
}
function getSubmission(id) {
  return db.get(`${SUB_SELECT} WHERE s.id = ?`, Number(id));
}
function questSubmissions(questId, { status = null, limit = 500 } = {}) {
  let sql = `${SUB_SELECT} WHERE s.quest_id = ?`;
  const args = [Number(questId)];
  if (status) { sql += ' AND s.status = ?'; args.push(status); }
  sql += ' ORDER BY s.created_at DESC LIMIT ?';
  args.push(limit);
  return db.all(sql, ...args);
}
function allSubmissions({ status = null, quest_id = null, search = null, limit = 300 } = {}) {
  let sql = `${SUB_SELECT} WHERE 1=1`;
  const args = [];
  if (status) { sql += ' AND s.status = ?'; args.push(status); }
  if (quest_id) { sql += ' AND s.quest_id = ?'; args.push(Number(quest_id)); }
  if (search) { sql += ' AND (s.wallet LIKE ? OR s.x_handle LIKE ? OR s.tweet_text LIKE ?)'; const l = `%${search}%`; args.push(l, l, l); }
  sql += ' ORDER BY s.created_at DESC LIMIT ?';
  args.push(limit);
  return db.all(sql, ...args);
}

/** The pipeline. Returns { submission, reward } or throws AppError. */
async function submitPost({ quest, user, tweetUrl, postText = null }) {
  const now = new Date().toISOString();
  if (quest.status !== 'active') throw new AppError(quest.status === 'scheduled' ? 'This quest has not opened yet' : quest.status === 'paused' ? 'This quest is paused' : 'This quest has ended', 400, 'QUEST_CLOSED');
  if (quest.starts_at && quest.starts_at > now) throw new AppError('This quest has not opened yet', 400, 'QUEST_CLOSED');
  if (quest.ends_at && quest.ends_at <= now) throw new AppError('This quest has ended', 400, 'QUEST_CLOSED');
  if (!user || !user.x_handle) throw new AppError('Link your X account before submitting', 400, 'X_NOT_LINKED');

  const parsed = tweets.parseTweetUrl(tweetUrl);
  if (!parsed) throw new AppError('That does not look like an X post link. Expected https://x.com/you/status/1234…', 400, 'BAD_URL');

  const wallet = user.wallet.toLowerCase();
  const dupe = db.get('SELECT id, wallet, status FROM submissions WHERE quest_id = ? AND tweet_id = ?', quest.id, parsed.id);
  if (dupe && dupe.status === 'verified') {
    throw new AppError(dupe.wallet === wallet ? 'You already submitted this post' : 'This post has already been used by another participant', 409, 'DUPLICATE');
  }
  const mine = db.get("SELECT COUNT(*) AS c FROM submissions WHERE quest_id = ? AND wallet = ? AND status = 'verified'", quest.id, wallet).c;
  if (mine >= (quest.max_per_wallet || 1)) throw new AppError(`You have already completed this quest${quest.max_per_wallet > 1 ? ` (${quest.max_per_wallet} posts max)` : ''}`, 400, 'WALLET_CAP');
  if (quest.max_submissions > 0 && quest.verified_count >= quest.max_submissions) throw new AppError('This quest is full — all submission slots are taken', 400, 'QUEST_FULL');
  if (quest.reward_type === 'fixed' && !covers(quest.remaining_pool, quest.reward_amount)) throw new AppError('The reward pool for this quest is exhausted', 400, 'POOL_EMPTY');

  // Fetch the post (demo: text comes from the participant)
  const tweet = await tweets.fetchTweet(parsed.id, { text: postText, handle: user.x_handle });
  const result = verifyPost(tweet, quest, { linked_handle: user.x_handle });

  const m = tweet.metrics || {};
  const score = result.ok ? scoreOf(m, quest) : 0;
  const fields = {
    quest_id: quest.id, wallet, x_handle: user.x_handle, x_user_id: user.x_user_id,
    tweet_url: tweet.url || parsed.canonical, tweet_id: parsed.id, tweet_text: tweet.text, tweet_author: tweet.author_handle,
    tweet_author_id: tweet.author_id, tweet_created_at: tweet.created_at, tweet_chars: result.chars, provider: tweet.provider,
    checks: JSON.stringify(result.checks), status: result.ok ? 'verified' : 'rejected', reject_reason: result.reason,
    likes: m.likes || 0, retweets: m.retweets || 0, replies: m.replies || 0, quotes: m.quotes || 0, views: m.views || 0,
    score, engagement_updated_at: tweet.metrics ? now : null, verified_at: result.ok ? now : null,
  };

  let submissionId;
  db.transaction(() => {
    if (dupe) {
      if (dupe.wallet !== wallet) throw new AppError('This post was already submitted by another participant', 409, 'DUPLICATE');
      const cols = Object.keys(fields);
      db.run(`UPDATE submissions SET ${cols.map((c) => `${c} = ?`).join(', ')}, created_at = ? WHERE id = ?`, ...cols.map((c) => fields[c]), now, dupe.id);
      submissionId = dupe.id;
    } else {
      const cols = Object.keys(fields);
      submissionId = db.run(`INSERT INTO submissions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => fields[c])).lastId;
    }
    if (result.ok && quest.reward_type === 'fixed') {
      queueReward({ submissionId, quest, wallet, amount: quest.reward_amount });
    }
  });

  db.event(result.ok ? 'submission.verified' : 'submission.rejected', {
    quest_id: quest.id, submission_id: submissionId, wallet,
    message: result.ok ? `@${user.x_handle} verified for "${quest.title}"` : `@${user.x_handle} rejected for "${quest.title}": ${result.reason}`,
  });

  return getSubmission(submissionId);
}

// ── rewards ───────────────────────────────────────────────
function queueReward({ submissionId, quest, wallet, amount }) {
  const exists = db.get('SELECT id FROM rewards WHERE submission_id = ?', submissionId);
  if (exists) return exists.id;
  if (!covers(quest.remaining_pool, amount)) throw new AppError('Reward pool exhausted', 400, 'POOL_EMPTY');
  const { lastId } = db.run(
    'INSERT INTO rewards (submission_id, quest_id, wallet, amount, token, token_address, chain) VALUES (?,?,?,?,?,?,?)',
    submissionId, quest.id, wallet, amount, quest.reward_token, quest.reward_token_address, quest.reward_chain,
  );
  db.run('UPDATE quests SET remaining_pool = ROUND(remaining_pool - ?, 12) WHERE id = ?', amount, quest.id);
  quest.remaining_pool = money(quest.remaining_pool - amount);
  return lastId;
}

let processing = false;
const PENDING_GRACE_MS = 10 * 60_000;      // 'sending' with no hash → assume broadcast never happened
const UNMINED_GIVEUP_MS = 2 * 3600_000;    // broadcast but never mined → stop waiting, flag for review

function markSent(r, hash) {
  db.run("UPDATE rewards SET status = 'sent', tx_hash = ?, error = NULL, sent_at = ? WHERE id = ?", hash, new Date().toISOString(), r.id);
  db.event('reward.sent', { quest_id: r.quest_id, submission_id: r.submission_id, wallet: r.wallet, message: `Paid ${r.amount} ${r.token} to ${maskWallet(r.wallet)} · ${hash.slice(0, 12)}…` });
}

function markFailure(r, message, { permanent = false } = {}) {
  const attempts = r.attempts;
  const giveUp = permanent || attempts >= config.scheduler.rewardMaxAttempts;
  const backoffMin = Math.min(60, 2 ** attempts);
  const next = new Date(Date.now() + backoffMin * 60_000).toISOString();
  db.run('UPDATE rewards SET status = ?, error = ?, next_attempt_at = ?, tx_hash = NULL WHERE id = ?', giveUp ? 'failed' : 'queued', String(message).slice(0, 300), giveUp ? null : next, r.id);
  db.event(giveUp ? 'reward.failed' : 'reward.retry', { quest_id: r.quest_id, submission_id: r.submission_id, wallet: r.wallet, message: `Payout to ${maskWallet(r.wallet)} ${giveUp ? 'failed' : `failed, retrying in ${backoffMin} min`}: ${String(message).slice(0, 120)}` });
  log.warn(`reward ${r.id} ${giveUp ? 'failed' : 'will retry'} (attempt ${attempts}): ${message}`);
  return giveUp;
}

/** Rewards stuck in 'sending' (slow RPC, crash mid-send) are settled by receipt — never re-sent blindly. */
async function reconcileInFlight() {
  const rows = db.all("SELECT r.*, q.rpc_url FROM rewards r JOIN quests q ON q.id = r.quest_id WHERE r.status = 'sending'");
  for (const r of rows) {
    const age = Date.now() - new Date(r.sent_at || r.created_at).getTime();
    if (!r.tx_hash) {
      if (age > PENDING_GRACE_MS) {
        db.run("UPDATE rewards SET status = 'queued', next_attempt_at = NULL, error = 'Send interrupted before broadcast — re-queued' WHERE id = ?", r.id);
      }
      continue;
    }
    try {
      const receipt = await chain.getReceipt(r.chain, r.rpc_url, r.tx_hash);
      if (receipt && receipt.status === 1) markSent(r, r.tx_hash);
      else if (receipt) markFailure(r, `Transaction ${r.tx_hash} reverted on-chain`);
      else if (age > UNMINED_GIVEUP_MS) markFailure(r, `Transaction ${r.tx_hash} was broadcast but not mined after 2 h — check the explorer before retrying`, { permanent: true });
    } catch (e) {
      log.warn(`could not check receipt for reward ${r.id}: ${e.message}`);
    }
  }
}

async function processRewardQueue() {
  if (processing) return 0;
  processing = true;
  let sent = 0;
  try {
    if (config.features.escrow) await reconcileInFlight();
    for (;;) {
      const now = new Date().toISOString();
      const r = db.get("SELECT r.*, q.rpc_url FROM rewards r JOIN quests q ON q.id = r.quest_id WHERE r.status = 'queued' AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ?) ORDER BY r.id LIMIT 1", now);
      if (!r) break;
      db.run("UPDATE rewards SET status = 'sending', attempts = attempts + 1, sent_at = ? WHERE id = ?", now, r.id);
      r.attempts += 1;
      if (!config.features.escrow) {
        if (config.demo) {
          const fake = '0x' + crypto.createHash('sha256').update(`demo:${r.id}:${r.wallet}`).digest('hex');
          db.run("UPDATE rewards SET status = 'simulated', tx_hash = ?, error = NULL, sent_at = ? WHERE id = ?", fake, new Date().toISOString(), r.id);
          db.event('reward.simulated', { quest_id: r.quest_id, submission_id: r.submission_id, wallet: r.wallet, message: `Simulated payout of ${r.amount} ${r.token} to ${maskWallet(r.wallet)}` });
          sent++;
          continue;
        }
        markFailure(r, 'Escrow wallet not configured (ESCROW_PRIVATE_KEY)');
        break;
      }
      let broadcastHash = null;
      try {
        const hash = await chain.sendPayment({
          chain: r.chain, rpcUrl: r.rpc_url, tokenAddress: r.token_address, amount: r.amount, to: r.wallet,
          onBroadcast: (h) => { broadcastHash = h; db.run("UPDATE rewards SET tx_hash = ? WHERE id = ?", h, r.id); },
        });
        markSent(r, hash);
        sent++;
      } catch (e) {
        if (e.code === 'TX_PENDING' || broadcastHash) {
          // broadcast happened; leave it in 'sending' and let reconcileInFlight settle it by receipt
          db.run("UPDATE rewards SET error = ? WHERE id = ?", `Waiting for confirmation of ${broadcastHash || e.hash}`, r.id);
          log.warn(`reward ${r.id} broadcast as ${broadcastHash || e.hash}, confirmation pending`);
          break;
        }
        const giveUp = markFailure(r, e.shortMessage || e.message || String(e));
        if (!giveUp) break; // respect the backoff before touching the next one
      }
    }
  } finally {
    processing = false;
  }
  return sent;
}

function retryReward(id) {
  const r = db.get('SELECT * FROM rewards WHERE id = ?', Number(id));
  if (!r) throw new AppError('Reward not found', 404, 'NOT_FOUND');
  if (['sent', 'simulated'].includes(r.status)) throw new AppError('This reward was already paid');
  if (r.status === 'sending' && r.tx_hash) throw new AppError(`This payout was already broadcast as ${r.tx_hash.slice(0, 14)}… and is waiting for confirmation. Check the explorer; it will settle on the next tick.`);
  db.run("UPDATE rewards SET status = 'queued', next_attempt_at = NULL, error = NULL, tx_hash = NULL WHERE id = ?", r.id);
  db.event('reward.requeued', { quest_id: r.quest_id, submission_id: r.submission_id, wallet: r.wallet, message: `Payout to ${maskWallet(r.wallet)} re-queued by admin` });
  return db.get('SELECT * FROM rewards WHERE id = ?', r.id);
}

function listRewards({ status = null, limit = 200 } = {}) {
  let sql = 'SELECT r.*, q.title AS quest_title, s.x_handle, s.tweet_url FROM rewards r JOIN quests q ON q.id = r.quest_id JOIN submissions s ON s.id = r.submission_id';
  const args = [];
  if (status) { sql += ' WHERE r.status = ?'; args.push(status); }
  sql += ' ORDER BY r.id DESC LIMIT ?';
  args.push(limit);
  return db.all(sql, ...args).map((r) => ({ ...serializeReward(r), quest_id: r.quest_id, quest_title: r.quest_title, submission_id: r.submission_id, wallet: r.wallet, x_handle: r.x_handle, tweet_url: r.tweet_url, raw_status: r.status }));
}

// ── engagement & ranking ──────────────────────────────────
async function refreshEngagement(quest) {
  const subs = db.all("SELECT id, tweet_id, tweet_created_at FROM submissions WHERE quest_id = ? AND status = 'verified'", quest.id);
  if (!subs.length) return { updated: 0 };
  const createdAt = new Map(subs.map((s) => [s.tweet_id, s.tweet_created_at]));
  const metrics = await tweets.fetchMetrics(subs.map((s) => s.tweet_id), createdAt);
  const now = new Date().toISOString();
  let updated = 0;
  db.transaction(() => {
    for (const s of subs) {
      const m = metrics.get(s.tweet_id);
      if (!m) continue;
      db.run('UPDATE submissions SET likes = ?, retweets = ?, replies = ?, quotes = ?, views = ?, score = ?, engagement_updated_at = ? WHERE id = ?',
        m.likes, m.retweets, m.replies, m.quotes, m.views, scoreOf(m, quest), now, s.id);
      updated++;
    }
    db.run('UPDATE quests SET engagement_refreshed_at = ? WHERE id = ?', now, quest.id);
    if (!quest.finalized_at) rankSubmissions(quest.id);
  });
  return { updated, provider_has_metrics: metrics.size > 0 };
}

function rankSubmissions(questId) {
  const rows = db.all("SELECT id FROM submissions WHERE quest_id = ? AND status = 'verified' ORDER BY score DESC, verified_at ASC, id ASC", questId);
  rows.forEach((r, i) => db.run('UPDATE submissions SET rank = ? WHERE id = ?', i + 1, r.id));
  return rows.length;
}

function finalizeRankings(questId) {
  const n = rankSubmissions(questId);
  db.run('UPDATE quests SET finalized_at = ? WHERE id = ?', new Date().toISOString(), questId);
  db.event('quest.finalized', { quest_id: questId, message: `Rankings locked for quest #${questId} (${n} verified posts)` });
  return n;
}

function distributeRewards(questId) {
  const q = mustGetQuest(questId);
  if (q.reward_type !== 'performance') throw new AppError('Only performance quests distribute by rank');
  if (q.status !== 'completed') throw new AppError('End the quest before distributing rewards');
  if (!q.finalized_at) finalizeRankings(q.id);
  const winners = db.all("SELECT id, wallet, rank FROM submissions WHERE quest_id = ? AND status = 'verified' AND rank IS NOT NULL AND rank <= ? ORDER BY rank", q.id, q.winner_count);
  let queued = 0;
  db.transaction(() => {
    for (const w of winners) {
      if (!covers(q.remaining_pool, q.reward_amount)) break;
      const before = db.get('SELECT id FROM rewards WHERE submission_id = ?', w.id);
      if (before) continue;
      queueReward({ submissionId: w.id, quest: q, wallet: w.wallet, amount: q.reward_amount });
      queued++;
    }
    db.run('UPDATE quests SET distributed_at = ? WHERE id = ?', new Date().toISOString(), q.id);
  });
  db.event('quest.distributed', { quest_id: q.id, message: `${queued} winner payout${queued === 1 ? '' : 's'} queued for "${q.title}"` });
  return { queued, winners: winners.length };
}

function leaderboard(quest, { limit = 100 } = {}) {
  const order = quest.reward_type === 'performance'
    ? 'CASE WHEN s.rank IS NULL THEN 1 ELSE 0 END, s.rank ASC, s.score DESC, s.verified_at ASC'
    : 's.verified_at DESC, s.id DESC';
  const rows = db.all(`${SUB_SELECT} WHERE s.quest_id = ? AND s.status = 'verified' ORDER BY ${order} LIMIT ?`, quest.id, limit);
  return rows.map((s, i) => ({
    position: s.rank || i + 1,
    submission_id: s.id,
    wallet: maskWallet(s.wallet),
    x_handle: s.x_handle,
    tweet_url: s.tweet_url,
    engagement: { likes: s.likes, retweets: s.retweets, replies: s.replies, quotes: s.quotes, views: s.views, score: s.score },
    verified_at: s.verified_at,
    winner: quest.reward_type === 'performance' && Boolean(quest.finalized_at) && s.rank !== null && s.rank <= quest.winner_count,
    reward: s.reward_id ? { status: s.reward_status === 'simulated' ? 'sent' : s.reward_status, amount: s.reward_amount, token: s.reward_token_sym, tx_hash: s.reward_tx_hash } : null,
  }));
}

// ── stats ─────────────────────────────────────────────────
function publicStats() {
  const paid = db.all("SELECT token, SUM(amount) AS total, COUNT(*) AS n FROM rewards WHERE status IN ('sent','simulated') GROUP BY token ORDER BY total DESC");
  return {
    active_quests: db.get("SELECT COUNT(*) AS c FROM quests WHERE status = 'active'").c,
    total_quests: db.get('SELECT COUNT(*) AS c FROM quests').c,
    participants: db.get("SELECT COUNT(DISTINCT wallet) AS c FROM submissions WHERE status = 'verified'").c,
    verified_posts: db.get("SELECT COUNT(*) AS c FROM submissions WHERE status = 'verified'").c,
    rewards_paid: paid.reduce((a, r) => a + r.n, 0),
    paid_by_token: paid.map((r) => ({ token: r.token, total: r.total, count: r.n })),
    open_pool: db.all("SELECT reward_token AS token, SUM(remaining_pool) AS total FROM quests WHERE status IN ('active','scheduled','paused') GROUP BY reward_token ORDER BY total DESC"),
  };
}

function adminStats() {
  const s = publicStats();
  return {
    ...s,
    rejected_posts: db.get("SELECT COUNT(*) AS c FROM submissions WHERE status = 'rejected'").c,
    rewards_queued: db.get("SELECT COUNT(*) AS c FROM rewards WHERE status IN ('queued','sending')").c,
    rewards_failed: db.get("SELECT COUNT(*) AS c FROM rewards WHERE status = 'failed'").c,
    linked_x_accounts: db.get('SELECT COUNT(*) AS c FROM users WHERE x_handle IS NOT NULL').c,
    users: db.get('SELECT COUNT(*) AS c FROM users').c,
  };
}

function recentEvents(limit = 40) {
  return db.all('SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?', limit);
}

module.exports = {
  AppError, QUEST_STATUSES,
  serializeQuest, serializeSubmission, serializeReward, serializeUser, maskWallet,
  listQuests, getQuest, mustGetQuest, createQuest, updateQuest, fundQuest, setQuestStatus, endQuest, deleteQuest,
  getUser, touchUser, linkX, unlinkX,
  userSubmissions, getSubmission, questSubmissions, allSubmissions, submitPost,
  queueReward, processRewardQueue, retryReward, listRewards,
  refreshEngagement, rankSubmissions, finalizeRankings, distributeRewards, leaderboard,
  publicStats, adminStats, recentEvents,
};
