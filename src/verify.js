'use strict';
/**
 * Rules engine: turns a fetched post + quest rules into an ordered list of
 * checks. The order here is the order the UI animates through.
 */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean);
  } catch { /* fall through */ }
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/** Whole-word, case-insensitive keyword match; tolerates #/$/@ prefixes and simple plurals. */
function keywordRegex(kw) {
  const core = escapeRe(kw.trim().replace(/\s+/g, ' ')).replace(/ /g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])[#$@]?${core}(?:'s|s|es)?(?![\\p{L}\\p{N}_])`, 'iu');
}
function containsKeyword(text, kw) {
  return keywordRegex(kw).test(text);
}

/** Approximate X character counting: URLs count as 23, everything else per code point. */
function countChars(text) {
  const t = String(text || '').replace(/https?:\/\/\S+/gi, 'x'.repeat(23));
  return Array.from(t).length;
}

function normHandle(h) {
  return String(h || '').replace(/^@/, '').trim().toLowerCase();
}

/**
 * @param {object} post   { text, author_handle, created_at }
 * @param {object} quest  quest row
 * @param {object} ctx    { linked_handle }
 * @returns {{ ok: boolean, checks: Array<{id,label,ok,detail}>, reason: string|null, keywords_found: string[] }}
 */
function verifyPost(post, quest, ctx = {}) {
  const text = String(post.text || '');
  const checks = [];

  // 1. Author must be the linked X account
  const linked = normHandle(ctx.linked_handle);
  const author = normHandle(post.author_handle);
  if (linked) {
    const ok = Boolean(author) && author === linked;
    checks.push({
      id: 'author',
      label: 'Posted by your linked X account',
      ok,
      detail: ok ? `@${post.author_handle}` : author ? `Post is by @${post.author_handle}, but you linked @${ctx.linked_handle}` : 'Could not determine the post author',
    });
  } else {
    checks.push({ id: 'author', label: 'Posted by your linked X account', ok: false, detail: 'Link your X account first' });
  }

  // 2. Timing — posted inside the quest window
  const windowStart = quest.require_after_start ? (quest.starts_at || quest.created_at) : null;
  if (windowStart || quest.ends_at) {
    const created = post.created_at ? new Date(post.created_at) : null;
    let ok = true;
    let detail = 'Posted inside the quest window';
    if (!created || Number.isNaN(created.getTime())) {
      detail = 'Post date unavailable — accepted';
    } else {
      if (windowStart && created < new Date(windowStart)) {
        ok = false;
        detail = `Posted ${created.toISOString().slice(0, 16).replace('T', ' ')} UTC, before the quest opened`;
      }
      if (ok && quest.ends_at && created > new Date(quest.ends_at)) {
        ok = false;
        detail = 'Posted after the quest closed';
      }
    }
    checks.push({ id: 'timing', label: 'Posted during the quest window', ok, detail });
  }

  // 3. Required keywords
  const required = parseList(quest.required_keywords);
  const found = required.filter((k) => containsKeyword(text, k));
  const missing = required.filter((k) => !found.includes(k));
  if (required.length) {
    const mode = quest.keyword_mode === 'any' ? 'any' : 'all';
    const ok = mode === 'any' ? found.length > 0 : missing.length === 0;
    checks.push({
      id: 'keywords',
      label: mode === 'any' ? 'Includes at least one required keyword' : 'Includes every required keyword',
      ok,
      detail: ok ? `Found: ${found.join(', ')}` : `Missing: ${missing.join(', ')}`,
      found,
      missing,
    });
  }

  // 4. Required mentions
  const mentions = parseList(quest.must_mention).map(normHandle).filter(Boolean);
  if (mentions.length) {
    const lower = text.toLowerCase();
    const missingM = mentions.filter((h) => !new RegExp(`@${escapeRe(h)}(?![A-Za-z0-9_])`, 'i').test(lower));
    checks.push({
      id: 'mentions',
      label: `Mentions ${mentions.map((h) => '@' + h).join(', ')}`,
      ok: missingM.length === 0,
      detail: missingM.length ? `Missing: ${missingM.map((h) => '@' + h).join(', ')}` : 'All mentions present',
    });
  }

  // 5. Banned words
  const banned = parseList(quest.banned_keywords);
  if (banned.length) {
    const hits = banned.filter((k) => containsKeyword(text, k));
    checks.push({
      id: 'banned',
      label: 'No banned words',
      ok: hits.length === 0,
      detail: hits.length ? `Contains: ${hits.join(', ')}` : 'Clean',
    });
  }

  // 6. Length
  const chars = countChars(text);
  const min = quest.min_chars || 0;
  const max = quest.max_chars || 0;
  if (min > 0 || max > 0) {
    let ok = true;
    let detail = `${chars} characters`;
    if (min > 0 && chars < min) { ok = false; detail = `${chars} characters — needs at least ${min}`; }
    if (max > 0 && chars > max) { ok = false; detail = `${chars} characters — limit is ${max}`; }
    checks.push({ id: 'length', label: min && max ? `Between ${min} and ${max} characters` : min ? `At least ${min} characters` : `At most ${max} characters`, ok, detail });
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    checks,
    reason: failed.length ? failed.map((c) => c.detail).join(' · ') : null,
    keywords_found: found,
    chars,
  };
}

function scoreOf(metrics, quest) {
  if (!metrics) return 0;
  return (
    (metrics.likes || 0) * (quest.weight_likes ?? 1) +
    (metrics.retweets || 0) * (quest.weight_retweets ?? 2) +
    (metrics.replies || 0) * (quest.weight_replies ?? 1.5) +
    (metrics.quotes || 0) * (quest.weight_quotes ?? 3) +
    (metrics.views || 0) * (quest.weight_views ?? 0.01)
  );
}

module.exports = { verifyPost, scoreOf, parseList, containsKeyword, countChars, normHandle };
