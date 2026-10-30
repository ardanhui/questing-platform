/* Questboard — shared client helpers (no build step, no dependencies). */
(function () {
  'use strict';
  const QB = (window.QB = {});

  // ── API ──────────────────────────────────────────────────
  QB.api = async function (method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data && data.code;
      throw err;
    }
    return data;
  };

  let configPromise = null;
  QB.config = () => (configPromise ||= QB.api('GET', '/api/config'));
  let mePromise = null;
  QB.me = (fresh) => { if (fresh || !mePromise) mePromise = QB.api('GET', '/api/me'); return mePromise; };

  // ── formatting ───────────────────────────────────────────
  QB.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  QB.mask = (w) => (w && w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w || '');
  QB.amount = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v === 0) return '0';
    const abs = Math.abs(v);
    const decimals = abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
    return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
  };
  QB.int = (n) => Number(n || 0).toLocaleString('en-US');
  QB.compact = (n) => {
    const v = Number(n || 0);
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(v));
  };
  QB.date = (iso, opts) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString(undefined, opts || { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  QB.dateShort = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—');
  QB.ago = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
    return QB.dateShort(iso);
  };
  QB.until = (iso) => {
    if (!iso) return null;
    const s = (new Date(iso).getTime() - Date.now()) / 1000;
    if (s <= 0) return 'now';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${Math.max(1, m)}m`;
  };
  QB.tweetIdFrom = (url) => { const m = String(url || '').match(/status(?:es)?\/(\d+)/); return m ? m[1] : null; };

  // ── toast ────────────────────────────────────────────────
  QB.toast = function (msg, kind) {
    let host = document.querySelector('.toast-host');
    if (!host) { host = document.createElement('div'); host.className = 'toast-host'; document.body.appendChild(host); }
    const el = document.createElement('div');
    el.className = `toast ${kind || ''}`;
    el.setAttribute('role', 'status');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 300ms'; setTimeout(() => el.remove(), 320); }, kind === 'err' ? 6000 : 3500);
  };

  // ── wallet sign-in ───────────────────────────────────────
  function toHex(str) {
    return '0x' + Array.from(new TextEncoder().encode(str)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  QB.wallet = {
    hasInjected: () => Boolean(window.ethereum),
    async connectInjected() {
      if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask or open this page in a wallet browser.');
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const address = accounts && accounts[0];
      if (!address) throw new Error('No account selected in your wallet');
      const { nonce, message } = await QB.api('GET', `/api/auth/nonce?address=${address}`);
      const signature = await window.ethereum.request({ method: 'personal_sign', params: [toHex(message), address] });
      const out = await QB.api('POST', '/api/auth/verify', { address, nonce, signature });
      QB.me(true);
      return out.user;
    },
    async connectDemo() {
      const out = await QB.api('POST', '/api/auth/demo-wallet');
      QB.me(true);
      return out.user;
    },
    async logout() {
      await QB.api('POST', '/api/auth/logout');
      QB.me(true);
    },
  };

  /** Opens the wallet chooser. Resolves with the user, or null if dismissed. */
  QB.connect = async function () {
    const cfg = await QB.config();
    const injected = QB.wallet.hasInjected();
    if (!cfg.features.demo_wallet) {
      if (!injected) { QB.toast('No browser wallet found. Install MetaMask or open this page in a wallet browser.', 'err'); return null; }
      return QB.wallet.connectInjected();
    }
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="cw-title">
          <h3 id="cw-title">Connect a wallet</h3>
          <p class="muted small" style="margin:6px 0 16px">Rewards are paid to the wallet you sign in with. Signing in is a signature only — no gas, no approvals.</p>
          <button class="btn btn-block choice" data-choice="injected" ${injected ? '' : 'disabled'}>
            <span class="choice-ic">🦊</span><span class="choice-txt"><b>Browser wallet</b><small>${injected ? 'MetaMask, Rabby, Coinbase Wallet…' : 'No wallet extension detected'}</small></span>
          </button>
          <button class="btn btn-block choice" data-choice="demo">
            <span class="choice-ic">🧪</span><span class="choice-txt"><b>Demo wallet</b><small>A throwaway address, so you can try the whole flow without an extension</small></span>
          </button>
          <button class="btn btn-ghost btn-sm" data-choice="cancel" style="margin-top:10px">Cancel</button>
        </div>`;
      document.body.appendChild(back);
      const close = (v) => { back.remove(); resolve(v); };
      back.addEventListener('click', (e) => { if (e.target === back) close(null); });
      back.querySelectorAll('[data-choice]').forEach((b) => b.addEventListener('click', async () => {
        const c = b.dataset.choice;
        if (c === 'cancel') return close(null);
        b.disabled = true; b.innerHTML = '<span class="spin"></span> Connecting…';
        try {
          const user = c === 'demo' ? await QB.wallet.connectDemo() : await QB.wallet.connectInjected();
          close(user);
        } catch (e) {
          if (e.code === 4001 || /rejected/i.test(e.message)) { close(null); return; }
          QB.toast(e.message, 'err');
          close(null);
        }
      }));
    });
  };

  // ── top bar ──────────────────────────────────────────────
  QB.renderTopbar = async function (active) {
    const host = document.getElementById('topbar');
    if (!host) return;
    const [cfg, me] = await Promise.all([QB.config(), QB.me().catch(() => ({ user: null }))]);
    const user = me.user;
    host.className = 'topbar';
    host.innerHTML = `
      <div class="wrap">
        <a class="brand" href="/"><span class="brand-mark"></span>${QB.esc(cfg.brand.name)}</a>
        <nav class="nav">
          <a href="/" class="${active === 'quests' ? 'active' : ''}">Quests</a>
          <a href="/me" class="${active === 'me' ? 'active' : ''}">My rewards</a>
        </nav>
        <span class="spacer"></span>
        ${cfg.demo ? '<span class="demo-tag" title="Posts and payouts are simulated">Demo</span>' : ''}
        <div id="topbar-wallet"></div>
      </div>`;
    const slot = host.querySelector('#topbar-wallet');
    if (user) {
      slot.innerHTML = `<div class="wallet-pill">
          <a href="/me" class="wallet-addr mono" title="${QB.esc(user.wallet)}">${QB.mask(user.wallet)}</a>
          ${user.x ? `<span class="wallet-x">@${QB.esc(user.x.handle)}</span>` : ''}
          <button class="btn btn-ghost btn-sm" id="tb-logout" title="Sign out">Sign out</button>
        </div>`;
      slot.querySelector('#tb-logout').addEventListener('click', async () => { await QB.wallet.logout(); location.reload(); });
    } else {
      slot.innerHTML = '<button class="btn btn-primary btn-sm" id="tb-connect">Connect wallet</button>';
      slot.querySelector('#tb-connect').addEventListener('click', async () => { const u = await QB.connect(); if (u) location.reload(); });
    }
    document.title = document.title.replace(/Questboard/, cfg.brand.name);
    return { cfg, user };
  };

  // ── live timers ──────────────────────────────────────────
  function tickTimers() {
    document.querySelectorAll('[data-until]').forEach((el) => { el.textContent = QB.until(el.dataset.until) || ''; });
    document.querySelectorAll('[data-ago]').forEach((el) => { el.textContent = QB.ago(el.dataset.ago); });
  }
  QB.tick = tickTimers;
  setInterval(tickTimers, 30000);

  QB.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  QB.reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Shared styles for things app.js renders itself
  const style = document.createElement('style');
  style.textContent = `
    .modal-back{position:fixed;inset:0;background:rgba(5,10,20,.7);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:90;padding:16px}
    .modal{background:var(--ink-800);border:1px solid var(--line-strong);border-radius:14px;padding:22px;width:min(100%,420px);box-shadow:0 30px 80px rgba(0,0,0,.5)}
    .modal h3{font-size:18px}
    .choice{justify-content:flex-start;text-align:left;padding:12px 14px;margin-bottom:8px;gap:12px}
    .choice-ic{font-size:20px;width:28px;text-align:center}
    .choice-txt{display:flex;flex-direction:column;gap:2px}
    .choice-txt small{font-weight:400;color:var(--text-2);font-size:12.5px;white-space:normal}
    .wallet-pill{display:flex;align-items:center;gap:10px;background:var(--ink-800);border:1px solid var(--line);border-radius:999px;padding:4px 6px 4px 12px}
    .wallet-addr{color:var(--text);font-size:13px}
    .wallet-x{color:var(--sky);font-size:13px;font-weight:600}
    @media (max-width:640px){.wallet-x{display:none}}
  `;
  document.head.appendChild(style);
})();
