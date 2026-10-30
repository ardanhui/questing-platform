'use strict';
const express = require('express');
const config = require('../config');
const auth = require('../auth');
const svc = require('../quests');
const tweets = require('../tweets');
const chain = require('../chain');

const router = express.Router();
const { AppError } = svc;

router.get('/api/config', (req, res) => {
  const provider = tweets.providerInfo();
  res.json({
    brand: config.brand,
    demo: config.demo,
    features: {
      demo_wallet: config.features.demoWallet,
      demo_x_link: config.features.demoXLink,
      x_oauth: config.features.xOAuth,
      escrow: config.features.escrow,
      live_engagement: provider.metrics,
    },
    provider,
    chains: Object.fromEntries(Object.entries(chain.CHAINS).map(([k, v]) => [k, { name: v.name, symbol: v.symbol, explorer: v.explorer, testnet: Boolean(v.testnet) }])),
  });
});

router.get('/api/stats', (req, res) => {
  res.json(svc.publicStats());
});

const PUBLIC_EVENTS = new Set(['reward.sent', 'reward.simulated', 'submission.verified', 'quest.created', 'quest.completed', 'quest.distributed', 'quest.active']);
router.get('/api/activity', (req, res) => {
  const events = svc.recentEvents(120).filter((e) => PUBLIC_EVENTS.has(e.type)).slice(0, Number(req.query.limit) || 20);
  res.json({ events: events.map((e) => ({ id: e.id, type: e.type, quest_id: e.quest_id, message: e.message, created_at: e.created_at })) });
});

router.get('/api/quests', (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !svc.QUEST_STATUSES.includes(status)) throw new AppError('Unknown status filter');
  res.json({ quests: svc.listQuests({ status }).map((q) => svc.serializeQuest(q)) });
});

router.get('/api/quests/:id', (req, res) => {
  const q = svc.mustGetQuest(req.params.id);
  const out = { quest: svc.serializeQuest(q) };
  out.leaderboard = svc.leaderboard(q, { limit: 10 });
  out.recent = svc.questSubmissions(q.id, { status: 'verified', limit: 8 }).map((s) => svc.serializeSubmission(s));
  if (req.user) {
    const user = svc.getUser(req.user.wallet);
    out.me = {
      user: svc.serializeUser(user),
      submissions: svc.userSubmissions(req.user.wallet).filter((s) => s.quest_id === q.id).map((s) => svc.serializeSubmission(s, { owner: true })),
    };
  }
  res.json(out);
});

router.get('/api/quests/:id/leaderboard', (req, res) => {
  const q = svc.mustGetQuest(req.params.id);
  res.json({
    quest_id: q.id,
    reward_type: q.reward_type,
    winner_count: q.winner_count,
    finalized: Boolean(q.finalized_at),
    refreshed_at: q.engagement_refreshed_at,
    entries: svc.leaderboard(q, { limit: Number(req.query.limit) || 100 }),
  });
});

router.post('/api/quests/:id/submissions', auth.requireUser, async (req, res) => {
  const q = svc.mustGetQuest(req.params.id);
  const user = svc.touchUser(req.user.wallet);
  const { tweet_url, post_text } = req.body || {};
  const sub = await svc.submitPost({ quest: q, user, tweetUrl: String(tweet_url || ''), postText: post_text ? String(post_text) : null });
  // kick the reward queue right away so fixed rewards land fast
  svc.processRewardQueue().catch(() => {});
  res.status(sub.status === 'verified' ? 201 : 200).json({ submission: svc.serializeSubmission(sub, { owner: true }) });
});

router.get('/api/submissions/:id', (req, res) => {
  const s = svc.getSubmission(req.params.id);
  if (!s) throw new AppError('Submission not found', 404, 'NOT_FOUND');
  const owner = req.user && req.user.wallet === s.wallet;
  if (!owner && !req.isAdmin) throw new AppError('Not your submission', 403, 'FORBIDDEN');
  res.json({ submission: svc.serializeSubmission(s, { owner: true, admin: req.isAdmin }) });
});

module.exports = router;
