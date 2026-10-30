'use strict';
const express = require('express');
const crypto = require('crypto');
const { ethers } = require('ethers');
const config = require('../config');
const auth = require('../auth');
const svc = require('../quests');
const log = require('../log');

const router = express.Router();
const { AppError } = svc;

function safeReturnTo(v) {
  const s = String(v || '/');
  return s.startsWith('/') && !s.startsWith('//') ? s : '/';
}

// ── wallet sign-in ────────────────────────────────────────
router.get('/api/auth/nonce', (req, res) => {
  const address = String(req.query.address || '');
  if (!ethers.isAddress(address)) throw new AppError('Invalid wallet address');
  res.json(auth.createNonce(ethers.getAddress(address)));
});

router.post('/api/auth/verify', (req, res) => {
  const { address, nonce, signature } = req.body || {};
  if (!address || !nonce || !signature) throw new AppError('Missing address, nonce or signature');
  let wallet;
  try {
    wallet = auth.verifyWalletSignature({ address, nonce, signature });
  } catch (e) {
    throw new AppError(e.message, 401, 'BAD_SIGNATURE');
  }
  const user = svc.touchUser(wallet);
  auth.issueSession(res, wallet);
  res.json({ user: svc.serializeUser(user) });
});

router.post('/api/auth/demo-wallet', (req, res) => {
  if (!config.features.demoWallet) throw new AppError('Demo wallets are only available in demo mode', 403, 'NOT_DEMO');
  const wallet = ethers.getAddress('0x' + crypto.randomBytes(20).toString('hex'));
  const user = svc.touchUser(wallet);
  auth.issueSession(res, wallet);
  res.json({ user: svc.serializeUser(user), demo: true });
});

router.post('/api/auth/logout', (req, res) => {
  auth.clearCookie(res, auth.SESSION_COOKIE);
  res.json({ ok: true });
});

router.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const user = svc.touchUser(req.user.wallet);
  const subs = svc.userSubmissions(user.wallet);
  const earned = {};
  for (const s of subs) {
    if (s.reward_id && ['sent', 'simulated'].includes(s.reward_status)) {
      earned[s.reward_token_sym] = (earned[s.reward_token_sym] || 0) + s.reward_amount;
    }
  }
  res.json({
    user: svc.serializeUser(user),
    summary: {
      submissions: subs.length,
      verified: subs.filter((s) => s.status === 'verified').length,
      earned: Object.entries(earned).map(([token, total]) => ({ token, total })),
      pending: subs.filter((s) => s.reward_id && ['queued', 'sending'].includes(s.reward_status)).length,
    },
  });
});

router.get('/api/me/submissions', auth.requireUser, (req, res) => {
  res.json({ submissions: svc.userSubmissions(req.user.wallet).map((s) => svc.serializeSubmission(s, { owner: true })) });
});

// ── X account linking ─────────────────────────────────────
router.get('/auth/x/start', (req, res) => {
  if (!req.user) return res.redirect(`${safeReturnTo(req.query.return_to)}?x=error&msg=${encodeURIComponent('Connect your wallet first')}`);
  if (!config.features.xOAuth) return res.redirect(`${safeReturnTo(req.query.return_to)}?x=error&msg=${encodeURIComponent('X sign-in is not configured on this server (X_CLIENT_ID)')}`);
  res.redirect(auth.beginXOAuth(req.user.wallet, safeReturnTo(req.query.return_to)));
});

router.get('/auth/x/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const s = auth.takeXOAuthState(String(state || ''));
  const back = safeReturnTo(s && s.returnTo);
  const fail = (msg) => res.redirect(`${back}${back.includes('?') ? '&' : '?'}x=error&msg=${encodeURIComponent(msg)}`);
  if (error) return fail(String(error_description || error));
  if (!s) return fail('Sign-in session expired — please try again');
  if (!req.user || req.user.wallet !== s.wallet) return fail('Wallet session changed during X sign-in — please try again');
  try {
    const { tokens, profile } = await auth.exchangeXCode(String(code || ''), s.verifier);
    svc.linkX(s.wallet, {
      id: profile.id, handle: profile.username, name: profile.name, avatar: profile.profile_image_url,
      access: tokens.access_token, refresh: tokens.refresh_token || null, expiresIn: tokens.expires_in || null,
    });
    res.redirect(`${back}${back.includes('?') ? '&' : '?'}x=linked`);
  } catch (e) {
    log.warn(`X link failed: ${e.message}`);
    fail(e.message);
  }
});

router.post('/api/auth/x/demo-link', auth.requireUser, (req, res) => {
  if (!config.features.demoXLink) throw new AppError('Demo linking is only available in demo mode', 403, 'NOT_DEMO');
  const handle = String((req.body || {}).handle || '').replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new AppError('Enter a valid X handle (letters, numbers, underscore; up to 15 characters)');
  const user = svc.linkX(req.user.wallet, { id: `demo:${handle.toLowerCase()}`, handle, name: handle });
  res.json({ user: svc.serializeUser(user) });
});

router.post('/api/auth/x/unlink', auth.requireUser, (req, res) => {
  svc.unlinkX(req.user.wallet);
  res.json({ user: svc.serializeUser(svc.getUser(req.user.wallet)) });
});

module.exports = router;
