'use strict';
process.env.DEMO_MODE = 'true';
process.env.DISABLE_SCHEDULER = 'true';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTweetUrl, _internal } = require('../src/tweets');
const { verifyPost, containsKeyword, countChars } = require('../src/verify');

test('parseTweetUrl accepts the common X link shapes', () => {
  const cases = [
    'https://x.com/jack/status/20',
    'https://twitter.com/jack/status/20?s=20&t=abc',
    'http://mobile.twitter.com/jack/statuses/20/photo/1',
    'x.com/jack/status/20',
    'https://x.com/i/web/status/20',
  ];
  for (const url of cases) {
    const p = parseTweetUrl(url);
    assert.ok(p, url);
    assert.equal(p.id, '20');
  }
  assert.equal(parseTweetUrl('https://x.com/i/web/status/20').handle, null);
  assert.equal(parseTweetUrl('https://x.com/jack/status/20').handle, 'jack');
});

test('parseTweetUrl rejects non-post links', () => {
  for (const bad of ['https://x.com/jack', 'https://example.com/jack/status/20', 'not a url', '', 'https://x.com/jack/status/abc']) {
    assert.equal(parseTweetUrl(bad), null, bad);
  }
});

test('keyword matching is whole-word, case-insensitive and tolerant of #/$ and plurals', () => {
  assert.ok(containsKeyword('The IDO opens soon', 'ido'));
  assert.ok(containsKeyword('Buying $SPWAY today', 'SPWAY'));
  assert.ok(containsKeyword('#SpaceWay to the moon', 'spaceway'));
  assert.ok(containsKeyword('I love these tokens', 'token'));
  assert.ok(!containsKeyword('watch this video', 'ido'), '"video" must not match IDO');
  assert.ok(!containsKeyword('onchainsummer', 'onchain'));
  assert.ok(containsKeyword('the Base Builders program', 'base builders'));
});

test('countChars counts links as 23 like X does', () => {
  assert.equal(countChars('hello'), 5);
  assert.equal(countChars('see https://example.com/some/very/long/path/that/goes/on'), 4 + 23);
  assert.equal(countChars('日本語'), 3);
});

const quest = {
  required_keywords: JSON.stringify(['SpaceWay', 'IDO']),
  keyword_mode: 'all',
  banned_keywords: JSON.stringify(['guaranteed']),
  must_mention: JSON.stringify(['spacewaytokens']),
  min_chars: 40,
  max_chars: 0,
  require_after_start: 1,
  starts_at: '2026-01-01T00:00:00.000Z',
  ends_at: '2026-02-01T00:00:00.000Z',
  created_at: '2025-12-31T00:00:00.000Z',
};

test('verifyPost passes a compliant post', () => {
  const r = verifyPost({ text: 'SpaceWay IDO is live, read the docs @spacewaytokens before you ape in.', author_handle: 'Alice', created_at: '2026-01-10T00:00:00Z' }, quest, { linked_handle: 'alice' });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.checks.map((c) => c.id), ['author', 'timing', 'keywords', 'mentions', 'banned', 'length']);
  assert.deepEqual(r.keywords_found, ['SpaceWay', 'IDO']);
});

test('verifyPost reports every failing rule', () => {
  const r = verifyPost({ text: 'guaranteed gains', author_handle: 'bob', created_at: '2025-12-01T00:00:00Z' }, quest, { linked_handle: 'alice' });
  assert.equal(r.ok, false);
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual(failed, ['author', 'timing', 'keywords', 'mentions', 'banned', 'length']);
  assert.match(r.reason, /Missing: SpaceWay, IDO/);
});

test('verifyPost "any" keyword mode and no linked handle', () => {
  const r = verifyPost({ text: 'Only the IDO is mentioned here, with @spacewaytokens tagged in', author_handle: 'alice', created_at: '2026-01-10T00:00:00Z' }, { ...quest, keyword_mode: 'any' }, { linked_handle: 'alice' });
  assert.equal(r.ok, true, r.reason);
  const r2 = verifyPost({ text: 'anything' }, quest, {});
  assert.equal(r2.checks[0].id, 'author');
  assert.equal(r2.checks[0].ok, false);
});

test('oEmbed html is turned back into post text', () => {
  const html = '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Hello &amp; welcome<br>to <a href="https://twitter.com/hashtag/Base?src=hash">#Base</a> &#8212; it&#39;s live</p>&mdash; Jane (@jane) <a href="https://twitter.com/jane/status/1?ref_src=twsrc%5Etfw">January 2, 2026</a></blockquote>';
  const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)[1];
  assert.equal(_internal.htmlToText(p), "Hello & welcome\nto #Base — it's live");
});

test('mock metrics are deterministic per post id', () => {
  const a = _internal.mockMetrics('123', new Date().toISOString());
  const b = _internal.mockMetrics('123', new Date().toISOString());
  assert.deepEqual(a, b);
  assert.ok(a.views > 0 && a.likes >= 0);
});
