# Questboard

A questing platform for X (Twitter) creator campaigns. A project funds an escrow wallet and posts a quest — the words a post must contain, how long it must be, the window it must land in, and what it pays. Creators link a wallet and their X account, paste the link to their post, and watch it get verified. Fixed-reward quests pay from escrow the moment a post verifies; ranked quests score posts by engagement and pay the top N when the quest closes.

```
npm install
npm run demo        # → http://localhost:3000  (admin: /admin, password admin123)
```

Demo mode needs no API keys, no wallet extension and no funds: posts are checked against text you paste, X linking is a typed handle, and payouts are simulated. Everything else — the verifier, the reward queue, scheduling, ranking, the admin console — runs exactly as in production.

## How it works

```
creator                        server                                 chain / X
───────                        ──────                                 ─────────
connect wallet ──signature──▶  nonce check → session cookie
link X ───────────────────▶    OAuth 2.0 PKCE → one X account per wallet  ◀── x.com
paste post link ──────────▶    1. quest open? caps? pool?                 
                               2. fetch post (X API → oEmbed → demo)  ◀── api.x.com
                               3. run rules: author · window · keywords ·
                                  mentions · banned words · length
                               4. store submission + every check result
                               5. fixed → queue reward, reserve pool
                                  ranked → score, provisional rank
◀── live checklist ──────────  response
                               reward worker: send native / ERC-20     ──▶ escrow tx
◀── paid + tx link ──────────  (decimals read from contract, retries with backoff)

scheduler (every 15 s):  open scheduled quests · close expired ones · refresh engagement
                         for ranked quests · lock rankings · queue winner payouts · drain queue
```

## Production setup

1. Copy `.env.example` to `.env` and set at least `SESSION_SECRET`, `ADMIN_PASSWORD`, `BASE_URL`.
2. **X access**
   - `X_BEARER_TOKEN` — an X API v2 app token with post lookup (Basic tier or above). Gives full post text (including long posts) and engagement metrics.
   - Without a bearer token the server falls back to X's public oEmbed endpoint: text and author only. Fixed-reward quests work; ranked quests cannot score.
   - `X_CLIENT_ID` / `X_CLIENT_SECRET` — an OAuth 2.0 app with the callback `BASE_URL/auth/x/callback`. This is how creators prove they own the account that wrote the post. Scopes requested: `tweet.read users.read offline.access`.
   - If your host cannot reach `api.x.com`, set `X_API_BASE` to a relay you control.
3. **Escrow** — `ESCROW_PRIVATE_KEY` for the paying wallet. Fund it with the reward token and native coin for gas on each chain you use. The treasury page shows balance vs. committed pool per token and flags shortfalls. Built-in chains: Base, Base Sepolia, Ethereum, Sepolia, Arbitrum, OP Mainnet, Polygon, BNB Chain, Avalanche; any other EVM chain works with a per-quest RPC URL.
4. `npm start` (or the Dockerfile). The SQLite database lives in `data/` — mount it as a volume.

Rewards are never sent inside an HTTP request. They go through a queue that sends one transaction at a time, waits for confirmation, and retries with backoff; permanent failures surface on the Payouts page with a retry button.

## Pages

| Path | What it is |
| --- | --- |
| `/` | The board: open, upcoming and closed quests, escrow totals, latest payouts |
| `/quest/:id` | Brief, rules, reward, leaderboard or verified-post feed, and the three-step participate panel with the live verification run |
| `/me` | Everything a wallet has submitted, verified and earned |
| `/admin` | Console: overview with attention items and activity, quests (create/edit/pause/end/fund), submissions with every check, payouts with retry, treasury, system status and a post-lookup tester |

## API sketch

Public: `GET /api/config` · `GET /api/stats` · `GET /api/activity` · `GET /api/quests` · `GET /api/quests/:id` · `GET /api/quests/:id/leaderboard`
Session: `GET /api/auth/nonce` → `POST /api/auth/verify` (wallet signature) · `GET /auth/x/start` → `/auth/x/callback` · `GET /api/me` · `GET /api/me/submissions` · `POST /api/quests/:id/submissions` · `GET /api/submissions/:id`
Admin (`POST /api/admin/login`): quests CRUD + `/status` `/fund` `/refresh-engagement` `/distribute`, `/api/admin/submissions`, `/api/admin/rewards` (+ `/:id/retry`, `/process`), `/api/admin/treasury`, `/api/admin/system`, `/api/admin/test-lookup`

All errors are JSON: `{ "error": "human message", "code": "MACHINE_CODE" }`.

## Project layout

```
server.js            boot: open DB, seed demo data, start HTTP + scheduler
src/config.js        env → config, feature flags
src/db.js            sql.js (SQLite in WASM), migrations, atomic debounced saves
src/tweets.js        post lookup providers (xapi, oembed, mock) + URL parsing
src/verify.js        rules engine → ordered list of checks
src/chain.js         chains, escrow signer, native/ERC-20 payouts, balances
src/auth.js          signed-cookie sessions, wallet sign-in, admin login, X OAuth PKCE
src/quests.js        service layer: quest lifecycle, submission pipeline, reward queue, ranking
src/scheduler.js     background loop
src/routes/*.js      thin Express routes (public, auth, admin)
public/              static front end — app.css design system, app.js helpers, one HTML per page
scripts/seed.js      demo data (auto in demo mode; `npm run seed -- --force` to reset)
test/                node:test suite — `npm test`
```

## Notes on the rules engine

- Keywords match whole words, case-insensitively; `#SpaceWay` and `$SPWAY` count, simple plurals count, and `IDO` does not match `video`.
- Length counts links as 23 characters, like X does.
- "Posted during the quest window" uses the post's own timestamp, so old posts can't be recycled.
- One X account per wallet; one verified post per wallet per quest unless the quest allows more; one post per quest full stop.
