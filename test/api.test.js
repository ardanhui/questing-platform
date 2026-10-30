'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DEMO_MODE = 'true';
process.env.DISABLE_SCHEDULER = 'true';
process.env.ADMIN_PASSWORD = 'test-admin';
process.env.SESSION_SECRET = 'test-secret';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-test-')), 'test.db');
process.env.PORT = '0';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { createApp } = require('../src/app');

let server;
let base;

// tiny cookie-aware client
function client() {
  let cookie = '';
  return async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const kv = c.split(';')[0];
      const k = kv.split('=')[0];
      cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; ');
    }
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json, headers: res.headers };
  };
}

const GOOD = 'SpaceWay is building a settlement layer for in-orbit data and the IDO opens this week on Base. $SPWAY is the fee and staking asset for the relay network; supply is fixed and emissions taper over six years. I have followed @spacewaytokens for months and the hardware partner list was published before the raise, which is rare.';

before(async () => {
  await db.open(process.env.DB_PATH);
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

test('admin can create a quest and the public can read it', async () => {
  const admin = client();
  assert.equal((await admin('GET', '/api/admin/overview')).status, 401);
  assert.equal((await admin('POST', '/api/admin/login', { password: 'wrong' })).status, 401);
  assert.equal((await admin('POST', '/api/admin/login', { password: 'test-admin' })).status, 200);

  const bad = await admin('POST', '/api/admin/quests', { title: 'x', reward_type: 'performance', reward_amount: 1, total_reward_pool: 1, winner_count: 3 });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /cover at least 3/);

  const created = await admin('POST', '/api/admin/quests', {
    title: 'SpaceWay IDO', required_keywords: 'SpaceWay, IDO, SPWAY', must_mention: 'spacewaytokens', banned_keywords: 'guaranteed',
    min_chars: 200, reward_type: 'fixed', reward_amount: 25, reward_token: 'USDC', reward_token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    reward_chain: 'base', total_reward_pool: 50, max_submissions: 0,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const q = created.json.quest;
  assert.equal(q.status, 'active');
  assert.equal(q.reward.remaining_pool, 50);

  const pub = client();
  const list = await pub('GET', '/api/quests');
  assert.equal(list.json.quests.length, 1);
  assert.equal(list.json.quests[0].rules.required_keywords.length, 3);
  assert.equal(list.json.quests[0].rpc_url, undefined, 'admin-only fields are not public');
});

test('submission pipeline: auth, linking, duplicate and caps', async () => {
  const user = client();
  const { json: { quests: [q] } } = await user('GET', '/api/quests');

  let r = await user('POST', `/api/quests/${q.id}/submissions`, { tweet_url: 'https://x.com/a/status/1' });
  assert.equal(r.status, 401);

  r = await user('POST', '/api/auth/demo-wallet');
  assert.equal(r.status, 200);
  const wallet = r.json.user.wallet;

  r = await user('POST', `/api/quests/${q.id}/submissions`, { tweet_url: 'https://x.com/a/status/1' });
  assert.equal(r.json.code, 'X_NOT_LINKED');

  r = await user('POST', '/api/auth/x/demo-link', { handle: 'bad handle!' });
  assert.equal(r.status, 400);
  r = await user('POST', '/api/auth/x/demo-link', { handle: 'alice' });
  assert.equal(r.json.user.x.handle, 'alice');

  // a second wallet cannot take the same X account
  const other = client();
  await other('POST', '/api/auth/demo-wallet');
  r = await other('POST', '/api/auth/x/demo-link', { handle: 'ALICE' });
  assert.equal(r.status, 409);

  r = await user('POST', `/api/quests/${q.id}/submissions`, { tweet_url: 'nope' });
  assert.equal(r.json.code, 'BAD_URL');

  // rejected: too short + missing keyword
  r = await user('POST', `/api/quests/${q.id}/submissions`, { tweet_url: 'https://x.com/alice/status/1001', post_text: 'SpaceWay IDO soon @spacewaytokens' });
  assert.equal(r.status, 200);
  assert.equal(r.json.submission.status, 'rejected');
  const failed = r.json.submission.checks.filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual(failed, ['keywords', 'length']);
  assert.equal(r.json.submission.reward, null);

  // same post id re-submitted with a good text replaces the rejected row
  r = await user('POST', `/api/quests/${q.id}/submissions`, { tweet_url: 'https://x.com/alice/status/1001', post_text: GOOD });
  assert.equal(r.status, 201);
  const sub = r.json.submission;
  assert.equal(sub.status, 'verified');
  assert.equal(sub.wallet, wallet);
  assert.ok(sub.reward, 'fixed quests queue a reward immediately');
  assert.equal(sub.reward.amount, 25);

  // the queue runs asynchronously after the response; poll until simulated
  let polled;
  for (let i = 0; i < 20; i++) {
    polled = await user('GET', `/api/submissions/${sub.id}`);
    if (polled.json.submission.reward.status === 'sent') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(polled.json.submission.reward.status, 'sent');
  assert.equal(polled.json.submission.reward.simulated, true);
  assert.match(polled.json.submission.reward.tx_hash, /^0x[0-9a-f]{64}$/);

  // the pool went down, the wallet cap kicks in, and another wallet cannot reuse the post
  const after1 = await user('GET', `/api/quests/${q.id}`);
  assert.equal(after1.json.quest.reward.remaining_pool, 25);
  assert.equal(after1.json.me.submissions.length, 1);
  r = await user('POST', `/api/quests/${q.id}/submissions`, { tweet_url: 'https://x.com/alice/status/1002', post_text: GOOD });
  assert.equal(r.json.code, 'WALLET_CAP');

  await other('POST', '/api/auth/x/demo-link', { handle: 'bob' });
  r = await other('POST', `/api/quests/${q.id}/submissions`, { tweet_url: 'https://x.com/alice/status/1001', post_text: GOOD });
  assert.equal(r.json.code, 'DUPLICATE');

  // bob's own post drains the pool; a third wallet finds it empty
  r = await other('POST', `/api/quests/${q.id}/submissions`, { tweet_url: 'https://x.com/bob/status/2001', post_text: GOOD });
  assert.equal(r.json.submission.status, 'verified');
  const third = client();
  await third('POST', '/api/auth/demo-wallet');
  await third('POST', '/api/auth/x/demo-link', { handle: 'carol' });
  r = await third('POST', `/api/quests/${q.id}/submissions`, { tweet_url: 'https://x.com/carol/status/3001', post_text: GOOD });
  assert.equal(r.json.code, 'POOL_EMPTY');

  // the other user cannot read alice's submission
  r = await other('GET', `/api/submissions/${sub.id}`);
  assert.equal(r.status, 403);
  // public lists mask wallets
  const pubQuest = await client()('GET', `/api/quests/${q.id}`);
  assert.match(pubQuest.json.recent[0].wallet, /^0x[0-9a-f]{4}…[0-9a-f]{4}$/i);
});

test('performance quest: ranking, closing and winner payouts', async () => {
  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'test-admin' });
  const created = await admin('POST', '/api/admin/quests', {
    title: 'Ranked', required_keywords: 'Base', min_chars: 10, reward_type: 'performance', reward_amount: 0.01, reward_token: 'ETH',
    reward_chain: 'base', total_reward_pool: 0.02, winner_count: 2, auto_distribute: true,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const qid = created.json.quest.id;

  const handles = ['dora', 'eve', 'finn'];
  const users = [];
  for (const h of handles) {
    const c = client();
    await c('POST', '/api/auth/demo-wallet');
    await c('POST', '/api/auth/x/demo-link', { handle: h });
    const r = await c('POST', `/api/quests/${qid}/submissions`, { tweet_url: `https://x.com/${h}/status/${h.length}${Date.now()}`, post_text: `Building on Base is fun, says ${h}` });
    assert.equal(r.json.submission.status, 'verified', JSON.stringify(r.json));
    assert.equal(r.json.submission.reward, null, 'ranked quests do not pay on submit');
    users.push(c);
  }

  let lb = await client()('GET', `/api/quests/${qid}/leaderboard`);
  assert.equal(lb.json.entries.length, 3);
  assert.equal(lb.json.finalized, false);

  const refreshed = await admin('POST', `/api/admin/quests/${qid}/refresh-engagement`);
  assert.equal(refreshed.json.updated, 3);

  const ended = await admin('POST', `/api/admin/quests/${qid}/status`, { status: 'completed' });
  assert.equal(ended.json.quest.status, 'completed');
  assert.ok(ended.json.quest.finalized_at);
  assert.ok(ended.json.quest.distributed_at);

  lb = await client()('GET', `/api/quests/${qid}/leaderboard`);
  assert.equal(lb.json.finalized, true);
  assert.deepEqual(lb.json.entries.map((e) => e.winner), [true, true, false]);
  assert.ok(lb.json.entries[0].engagement.score >= lb.json.entries[1].engagement.score);

  // rewards exist for exactly the two winners
  const rewards = await admin('GET', '/api/admin/rewards');
  const mine = rewards.json.rewards.filter((r) => r.quest_id === qid);
  assert.equal(mine.length, 2);
  const detail = await admin('GET', `/api/admin/quests/${qid}`);
  assert.equal(detail.json.quest.reward.remaining_pool, 0);

  // cannot reopen, cannot delete with submissions
  const reopen = await admin('POST', `/api/admin/quests/${qid}/status`, { status: 'active' });
  assert.equal(reopen.status, 400);
  const del = await admin('DELETE', `/api/admin/quests/${qid}`);
  assert.equal(del.status, 400);

  // submitting to a closed quest fails cleanly
  const late = await users[0]('POST', `/api/quests/${qid}/submissions`, { tweet_url: 'https://x.com/dora/status/999', post_text: 'Base again' });
  assert.equal(late.json.code, 'QUEST_CLOSED');
});

test('scheduled quests open on time and treasury reports liabilities', async () => {
  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'test-admin' });
  const soon = new Date(Date.now() + 60_000).toISOString();
  const created = await admin('POST', '/api/admin/quests', { title: 'Later', required_keywords: 'x', reward_type: 'fixed', reward_amount: 1, total_reward_pool: 3, starts_at: soon });
  assert.equal(created.json.quest.status, 'scheduled');
  const qid = created.json.quest.id;

  // move the start into the past and run a scheduler tick
  db.run("UPDATE quests SET starts_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), qid);
  const tick = await admin('POST', '/api/admin/scheduler/tick');
  assert.equal(tick.json.opened, 1);
  const q = await admin('GET', `/api/admin/quests/${qid}`);
  assert.equal(q.json.quest.status, 'active');

  const t = await admin('GET', '/api/admin/treasury');
  assert.equal(t.json.configured, false);
  assert.ok(t.json.liabilities.length >= 1);

  const sys = await admin('GET', '/api/admin/system');
  assert.equal(sys.json.mode, 'demo');
  assert.equal(sys.json.provider.name, 'mock');
});
