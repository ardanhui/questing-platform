'use strict';
/**
 * Background loop: opens scheduled quests, closes expired ones (ranking and
 * paying winners), refreshes engagement for live performance quests and
 * drains the reward queue.
 */
const config = require('./config');
const db = require('./db');
const log = require('./log');
const svc = require('./quests');
const tweets = require('./tweets');

let timer = null;
let running = false;
const state = { last_tick: null, last_engagement_refresh: null, ticks: 0, errors: 0, last_error: null };

async function tick() {
  if (running) return { skipped: true };
  running = true;
  const out = { opened: 0, closed: 0, refreshed: 0, rewards_sent: 0 };
  try {
    const now = new Date().toISOString();

    for (const q of db.all("SELECT * FROM quests WHERE status = 'scheduled' AND starts_at IS NOT NULL AND starts_at <= ?", now)) {
      await svc.setQuestStatus(q.id, 'active', { reason: 'scheduled start' });
      out.opened++;
    }

    for (const q of db.all("SELECT * FROM quests WHERE status IN ('active','paused') AND ends_at IS NOT NULL AND ends_at <= ?", now)) {
      await svc.endQuest(svc.getQuest(q.id), { reason: 'scheduled end' });
      out.closed++;
    }

    const refreshEvery = config.scheduler.engagementRefreshMinutes * 60_000;
    const due = !state.last_engagement_refresh || Date.now() - state.last_engagement_refresh > refreshEvery;
    if (due && tweets.providerInfo().metrics) {
      for (const q of db.all("SELECT * FROM quests WHERE status = 'active' AND reward_type = 'performance'")) {
        try {
          const r = await svc.refreshEngagement(q);
          out.refreshed += r.updated;
        } catch (e) {
          log.warn(`engagement refresh for quest ${q.id} failed: ${e.message}`);
        }
      }
      state.last_engagement_refresh = Date.now();
    }

    out.rewards_sent = await svc.processRewardQueue();
    state.last_tick = new Date().toISOString();
    state.ticks++;
  } catch (e) {
    state.errors++;
    state.last_error = e.message;
    log.error(`scheduler tick failed: ${e.message}`);
  } finally {
    running = false;
  }
  return out;
}

function start() {
  if (!config.scheduler.enabled || timer) return;
  timer = setInterval(() => { tick(); }, config.scheduler.tickMs);
  timer.unref();
  setTimeout(() => { tick(); }, 1500).unref();
  log.info(`scheduler running every ${config.scheduler.tickMs / 1000}s`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, state: () => ({ ...state, enabled: config.scheduler.enabled, tick_ms: config.scheduler.tickMs, engagement_refresh_minutes: config.scheduler.engagementRefreshMinutes }) };
