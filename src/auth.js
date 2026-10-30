'use strict';
/**
 * Sessions are stateless signed tokens (HMAC-SHA256) carried in httpOnly
 * cookies. Wallet sign-in uses a server-issued nonce + personal_sign; the admin
 * console uses a password with per-IP rate limiting.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const config = require('./config');

const SESSION_COOKIE = 'qp_session';
const ADMIN_COOKIE = 'qp_admin';
const SESSION_TTL = 30 * 24 * 3600; // seconds
const ADMIN_TTL = 12 * 3600;

// ── tokens ────────────────────────────────────────────────
function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}
function sign(data) {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
}
function issueToken(payload, ttlSeconds) {
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  return `${body}.${sign(body)}`;
}
function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── cookies ───────────────────────────────────────────────
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, { maxAge, path = '/' } = {}) {
  const secure = config.baseUrl.startsWith('https://') ? '; Secure' : '';
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax' + secure];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  res.setHeader('Set-Cookie', [...list, parts.join('; ')]);
}
function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

// ── wallet sign-in ────────────────────────────────────────
const nonces = new Map(); // nonce → { address, expires }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nonces) if (v.expires < now) nonces.delete(k);
}, 60_000).unref();

function signInMessage(address, nonce, issuedAt) {
  return [
    `${config.brand.name} wants you to sign in with your wallet.`,
    '',
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Issued at: ${issuedAt}`,
    '',
    'This signature only proves you control this wallet. It does not cost gas or approve any transaction.',
  ].join('\n');
}

function createNonce(address) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = new Date().toISOString();
  nonces.set(nonce, { address: address.toLowerCase(), issuedAt, expires: Date.now() + 10 * 60_000 });
  return { nonce, issuedAt, message: signInMessage(address, nonce, issuedAt) };
}

function verifyWalletSignature({ address, nonce, signature }) {
  const entry = nonces.get(nonce);
  if (!entry || entry.expires < Date.now()) throw new Error('Sign-in request expired — try again');
  if (entry.address !== String(address).toLowerCase()) throw new Error('Nonce does not belong to this wallet');
  const message = signInMessage(ethers.getAddress(address), nonce, entry.issuedAt);
  const recovered = ethers.verifyMessage(message, signature);
  if (recovered.toLowerCase() !== entry.address) throw new Error('Signature does not match the wallet');
  nonces.delete(nonce);
  return recovered;
}

function issueSession(res, wallet) {
  const token = issueToken({ t: 'user', wallet: wallet.toLowerCase() }, SESSION_TTL);
  setCookie(res, SESSION_COOKIE, token, { maxAge: SESSION_TTL });
  return token;
}

// ── middleware ────────────────────────────────────────────
function attachUser(req, res, next) {
  const cookies = parseCookies(req);
  let token = cookies[SESSION_COOKIE];
  const authz = req.headers.authorization;
  if (!token && authz && authz.startsWith('Bearer ')) token = authz.slice(7);
  const payload = readToken(token);
  req.user = payload && payload.t === 'user' ? { wallet: payload.wallet } : null;
  const admin = readToken(cookies[ADMIN_COOKIE] || req.headers['x-admin-token']);
  req.isAdmin = Boolean(admin && admin.t === 'admin');
  next();
}
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Connect your wallet first', code: 'NO_SESSION' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(401).json({ error: 'Admin sign-in required', code: 'NO_ADMIN' });
  next();
}

// ── admin login with rate limiting ────────────────────────
const attempts = new Map(); // ip → { count, until }
function adminLogin(ip, password) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  if (a.until > Date.now()) throw new Error(`Too many attempts — try again in ${Math.ceil((a.until - Date.now()) / 60000)} min`);
  if (!config.adminPassword) throw new Error('ADMIN_PASSWORD is not set on the server');
  const given = Buffer.from(String(password || ''));
  const want = Buffer.from(config.adminPassword);
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) {
    a.count += 1;
    if (a.count >= 5) { a.until = Date.now() + 15 * 60_000; a.count = 0; }
    attempts.set(ip, a);
    throw new Error('Wrong password');
  }
  attempts.delete(ip);
  return issueToken({ t: 'admin' }, ADMIN_TTL);
}

// ── X OAuth 2.0 (PKCE) ────────────────────────────────────
const oauthStates = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthStates) if (v.expires < now) oauthStates.delete(k);
}, 60_000).unref();

function beginXOAuth(wallet, returnTo) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(24).toString('base64url');
  oauthStates.set(state, { verifier, wallet, returnTo: returnTo || '/', expires: Date.now() + 10 * 60_000 });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.x.clientId,
    redirect_uri: config.x.callbackUrl,
    scope: 'tweet.read users.read offline.access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${config.x.authorizeUrl}?${params}`;
}

function takeXOAuthState(state) {
  const s = oauthStates.get(state);
  oauthStates.delete(state);
  if (!s || s.expires < Date.now()) return null;
  return s;
}

async function exchangeXCode(code, verifier) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (config.x.clientSecret) {
    headers.Authorization = 'Basic ' + Buffer.from(`${config.x.clientId}:${config.x.clientSecret}`).toString('base64');
  }
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: config.x.clientId,
    redirect_uri: config.x.callbackUrl,
    code_verifier: verifier,
  });
  const res = await fetch(`${config.x.apiBase}/2/oauth2/token`, { method: 'POST', headers, body: body.toString() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  const tokens = JSON.parse(text);
  const me = await fetch(`${config.x.apiBase}/2/users/me?user.fields=name,username,profile_image_url`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const meText = await me.text();
  if (!me.ok) throw new Error(`Could not read X profile (${me.status}): ${meText.slice(0, 200)}`);
  const profile = JSON.parse(meText).data;
  return { tokens, profile };
}

module.exports = {
  SESSION_COOKIE, ADMIN_COOKIE, ADMIN_TTL,
  issueToken, readToken, parseCookies, setCookie, clearCookie,
  createNonce, verifyWalletSignature, issueSession, signInMessage,
  attachUser, requireUser, requireAdmin, adminLogin,
  beginXOAuth, takeXOAuthState, exchangeXCode,
};
