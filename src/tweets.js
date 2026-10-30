'use strict';
/**
 * Tweet (X post) lookup with a provider chain:
 *
 *   xapi    — X API v2 (needs X_BEARER_TOKEN; returns full note text + metrics)
 *   oembed  — public publish.twitter.com/oembed endpoint (text + author, no metrics)
 *   mock    — demo mode; the participant pastes the text of their post
 *
 * Every provider returns the same shape:
 *   { id, url, text, author_handle, author_id, author_name, created_at, metrics|null, provider }
 */
const crypto = require('crypto');
const config = require('./config');
const log = require('./log');

class TweetError extends Error {
  constructor(message, code = 'TWEET_ERROR', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ── URL parsing ───────────────────────────────────────────
const TWEET_URL_RE = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15}|i\/web)\/status(?:es)?\/(\d{1,25})(?:[/?#].*)?$/i;

function parseTweetUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  const m = trimmed.match(TWEET_URL_RE);
  if (!m) return null;
  const handle = m[1].toLowerCase() === 'i/web' ? null : m[1];
  return { id: m[2], handle, canonical: `https://x.com/${handle || 'i/web'}/status/${m[2]}` };
}

// ── small fetch helper with timeout ───────────────────────
async function httpJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, headers: res.headers, json, text };
  } catch (e) {
    if (e.name === 'AbortError') throw new TweetError('Timed out talking to X', 'X_TIMEOUT', 504);
    throw new TweetError(`Could not reach X: ${e.message}`, 'X_UNREACHABLE', 502);
  } finally {
    clearTimeout(timer);
  }
}

function pickMetrics(pm) {
  if (!pm) return null;
  return {
    likes: pm.like_count || 0,
    retweets: pm.retweet_count || 0,
    replies: pm.reply_count || 0,
    quotes: pm.quote_count || 0,
    views: pm.impression_count || 0,
  };
}

// ── Provider: X API v2 ────────────────────────────────────
const xapi = {
  name: 'xapi',
  label: 'X API v2',
  metrics: true,
  available: () => Boolean(config.x.bearer),

  async fetchTweet(id) {
    const fields = 'tweet.fields=text,author_id,created_at,public_metrics,note_tweet&expansions=author_id&user.fields=username,name,profile_image_url';
    const res = await httpJson(`${config.x.apiBase}/2/tweets/${id}?${fields}`, {
      headers: { Authorization: `Bearer ${config.x.bearer}` },
    });
    xapiAssert(res);
    const data = res.json && res.json.data;
    if (!data) {
      const err = res.json && res.json.errors && res.json.errors[0];
      throw new TweetError(err ? `X says: ${err.detail || err.title}` : 'Post not found', 'NOT_FOUND', 404);
    }
    const user = ((res.json.includes || {}).users || []).find((u) => u.id === data.author_id) || {};
    const text = (data.note_tweet && data.note_tweet.text) || data.text || '';
    return {
      id: data.id,
      url: `https://x.com/${user.username || 'i/web'}/status/${data.id}`,
      text,
      author_handle: user.username || null,
      author_id: data.author_id || null,
      author_name: user.name || null,
      author_avatar: user.profile_image_url || null,
      created_at: data.created_at || null,
      metrics: pickMetrics(data.public_metrics),
      provider: 'xapi',
    };
  },

  async fetchMetrics(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const res = await httpJson(`${config.x.apiBase}/2/tweets?ids=${batch.join(',')}&tweet.fields=public_metrics`, {
        headers: { Authorization: `Bearer ${config.x.bearer}` },
      });
      xapiAssert(res);
      for (const t of (res.json && res.json.data) || []) out.set(t.id, pickMetrics(t.public_metrics));
    }
    return out;
  },
};

function xapiAssert(res) {
  if (res.ok) return;
  if (res.status === 401) throw new TweetError('X API rejected the bearer token (401). Check X_BEARER_TOKEN.', 'X_AUTH', 502);
  if (res.status === 403) throw new TweetError('X API refused the request (403). Your app tier may not allow post lookup.', 'X_FORBIDDEN', 502);
  if (res.status === 429) {
    const reset = res.headers.get('x-rate-limit-reset');
    const when = reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : 'soon';
    throw new TweetError(`X API rate limit hit. Try again after ${when}.`, 'X_RATE_LIMIT', 503);
  }
  if (res.status === 404) throw new TweetError('Post not found', 'NOT_FOUND', 404);
  throw new TweetError(`X API error ${res.status}: ${(res.text || '').slice(0, 160)}`, 'X_ERROR', 502);
}

// ── Provider: oEmbed (public, no key) ─────────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  ).trim();
}

const oembed = {
  name: 'oembed',
  label: 'X oEmbed (public)',
  metrics: false,
  available: () => true,

  async fetchTweet(id) {
    const target = encodeURIComponent(`https://twitter.com/i/status/${id}`);
    const res = await httpJson(`${config.x.oembedBase}?url=${target}&omit_script=1&dnt=1&lang=en`);
    if (res.status === 404) throw new TweetError('Post not found, deleted, or from a protected account', 'NOT_FOUND', 404);
    if (!res.ok || !res.json) throw new TweetError(`oEmbed lookup failed (${res.status})`, 'X_ERROR', 502);
    const { html = '', author_url = '', author_name = null } = res.json;
    const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const text = p ? htmlToText(p[1]) : '';
    const handleMatch = author_url.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})/i);
    const dateMatch = html.match(/<\/p>[\s\S]*?<a[^>]*>([^<]+)<\/a>\s*<\/blockquote>/i);
    const created = dateMatch ? new Date(dateMatch[1]) : null;
    return {
      id,
      url: `https://x.com/${handleMatch ? handleMatch[1] : 'i/web'}/status/${id}`,
      text,
      author_handle: handleMatch ? handleMatch[1] : null,
      author_id: null,
      author_name,
      author_avatar: null,
      created_at: created && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
      metrics: null,
      provider: 'oembed',
    };
  },

  async fetchMetrics() {
    return new Map();
  },
};

// ── Provider: mock (demo mode) ────────────────────────────
function seeded(id, salt) {
  const h = crypto.createHash('sha256').update(`${id}:${salt}`).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}
function mockMetrics(id, createdAt) {
  const ageHours = Math.max(0, (Date.now() - new Date(createdAt || Date.now()).getTime()) / 3.6e6);
  const growth = 1 + Math.min(ageHours, 72) * 0.08;
  const base = seeded(id, 'base');
  const views = Math.round((400 + base * 12000) * growth);
  return {
    likes: Math.round(views * (0.01 + seeded(id, 'l') * 0.05)),
    retweets: Math.round(views * (0.002 + seeded(id, 'r') * 0.012)),
    replies: Math.round(views * (0.001 + seeded(id, 'c') * 0.008)),
    quotes: Math.round(views * (0.0005 + seeded(id, 'q') * 0.004)),
    views,
  };
}

const mock = {
  name: 'mock',
  label: 'Demo (simulated)',
  metrics: true,
  available: () => true,

  async fetchTweet(id, ctx = {}) {
    const text = String(ctx.text || '').trim();
    if (!text) throw new TweetError('Demo mode: paste the text of your post so it can be checked.', 'DEMO_TEXT_REQUIRED', 400);
    const handle = ctx.handle || 'demo_user';
    const created = ctx.created_at || new Date().toISOString();
    return {
      id,
      url: `https://x.com/${handle}/status/${id}`,
      text,
      author_handle: handle,
      author_id: `demo:${handle.toLowerCase()}`,
      author_name: handle,
      author_avatar: null,
      created_at: created,
      metrics: mockMetrics(id, created),
      provider: 'mock',
    };
  },

  async fetchMetrics(ids, createdAtById = new Map()) {
    const out = new Map();
    for (const id of ids) out.set(id, mockMetrics(id, createdAtById.get(id)));
    return out;
  },
};

// ── Provider selection ────────────────────────────────────
const PROVIDERS = { xapi, oembed, mock };

function activeProvider() {
  const wanted = config.x.provider;
  if (wanted && wanted !== 'auto') {
    const p = PROVIDERS[wanted];
    if (!p) throw new Error(`Unknown TWEET_PROVIDER "${wanted}" (use auto, xapi, oembed or mock)`);
    if (!p.available()) throw new Error(`TWEET_PROVIDER=${wanted} is not available (missing credentials)`);
    return p;
  }
  if (config.demo) return mock;
  if (xapi.available()) return xapi;
  return oembed;
}

const cache = new Map(); // id → { at, tweet }
const CACHE_MS = 60_000;

async function fetchTweet(id, ctx = {}) {
  const provider = activeProvider();
  const key = `${provider.name}:${id}:${ctx.text || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.tweet;
  const tweet = await provider.fetchTweet(id, ctx);
  cache.set(key, { at: Date.now(), tweet });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return tweet;
}

async function fetchMetrics(ids, createdAtById) {
  const provider = activeProvider();
  if (!provider.metrics) return new Map();
  return provider.fetchMetrics(ids, createdAtById);
}

function providerInfo() {
  let p;
  try { p = activeProvider(); } catch (e) { return { name: 'none', label: 'Not configured', metrics: false, error: e.message }; }
  return { name: p.name, label: p.label, metrics: p.metrics };
}

module.exports = { parseTweetUrl, fetchTweet, fetchMetrics, providerInfo, TweetError, _internal: { htmlToText, decodeEntities, mockMetrics } };
if (config.demo) log.info('tweet provider: demo mock');
