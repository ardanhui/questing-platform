'use strict';
/**
 * Demo seed: a handful of quests plus simulated participants so the board,
 * leaderboards and admin console have something to show. Runs automatically
 * in demo mode when the database is empty; `node scripts/seed.js --force`
 * wipes and reseeds.
 */
const path = require('path');
const crypto = require('crypto');

function hours(h) { return new Date(Date.now() + h * 3600e3).toISOString(); }

const PARTICIPANTS = [
  'cryptokate', '0xmaru', 'defi_dana', 'basebuilder', 'satoshi_jr', 'nftnadia', 'onchain_oli', 'yieldyara',
  'tokentom', 'ser_lumen', 'gm_gwen', 'alpha_arjun', 'web3wren', 'pixel_pau', 'chainchloe',
];

const QUESTS = [
  {
    title: 'SpaceWay IDO — launch thread',
    cover: '🚀',
    kol_handle: 'spacewaytokens',
    kol_tweet_url: 'https://x.com/spacewaytokens/status/1848371920384712345',
    description: 'SpaceWay opens its IDO on Base this week. Write an original post explaining what SpaceWay does, why the $SPWAY token matters to the launch, and tag the team. Threads welcome — the first post is what gets checked.',
    required_keywords: ['SpaceWay', 'IDO', 'SPWAY'],
    must_mention: ['spacewaytokens'],
    banned_keywords: ['guaranteed', 'risk-free'],
    min_chars: 280,
    reward_type: 'fixed',
    reward_amount: 25,
    reward_token: 'USDC',
    reward_token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    reward_chain: 'base',
    total_reward_pool: 2500,
    max_submissions: 100,
    ends_at: hours(5 * 24 + 7),
  },
  {
    title: 'Base Builders Spotlight',
    cover: '🔵',
    kol_handle: 'base',
    description: 'Tell the story of something you built, used or loved onchain this month. The ten posts with the most engagement when the quest closes split the pool.',
    required_keywords: ['Base', 'onchain'],
    keyword_mode: 'all',
    min_chars: 200,
    reward_type: 'performance',
    reward_amount: 0.05,
    reward_token: 'ETH',
    reward_chain: 'base',
    total_reward_pool: 0.5,
    winner_count: 10,
    weight_likes: 1, weight_retweets: 2.5, weight_replies: 1.5, weight_quotes: 3, weight_views: 0.01,
    ends_at: hours(3 * 24 + 2),
  },
  {
    title: 'Aurora Protocol mainnet recap',
    cover: '🌅',
    kol_handle: 'aurora_fi',
    description: 'Aurora ships mainnet on Monday. Once the quest opens, post a recap of the launch — what shipped, what it means for users — and mention the team.',
    required_keywords: ['Aurora', 'mainnet'],
    must_mention: ['aurora_fi'],
    min_chars: 240,
    max_chars: 2000,
    reward_type: 'fixed',
    reward_amount: 15,
    reward_token: 'USDC',
    reward_token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    reward_chain: 'base',
    total_reward_pool: 900,
    max_submissions: 60,
    starts_at: hours(2 * 24),
    ends_at: hours(9 * 24),
  },
  {
    title: 'Genesis Week — early supporters',
    cover: '🏁',
    kol_handle: 'questboard',
    description: 'Our launch quest. Participants posted about Questboard during genesis week; the top five by engagement were paid from the escrow wallet.',
    required_keywords: ['Questboard'],
    min_chars: 120,
    reward_type: 'performance',
    reward_amount: 0.02,
    reward_token: 'ETH',
    reward_chain: 'base',
    total_reward_pool: 0.1,
    winner_count: 5,
    _complete: true,
  },
];

const POSTS = {
  spaceway: [
    "SpaceWay is building a settlement layer for in-orbit data — satellites paying each other for bandwidth and compute without a ground station in the loop. The IDO on Base opens this week and $SPWAY is the fee and staking asset for the whole network. Been following @spacewaytokens for months; this is the first space-economy project with a working testnet and real hardware partners. Doing my own research, and the token design holds up.",
    "Quick explainer on the SpaceWay IDO: $SPWAY is what satellites stake to join the relay network and what they earn for serving data. Supply is fixed, emissions taper over 6 years, and the IDO allocation is 8% with a 12-month linear unlock. The thing I like most: @spacewaytokens published the hardware partner list before the raise, not after. Not financial advice, just a thread from someone who reads whitepapers for fun.",
    "SpaceWay just announced the IDO date and I think most people are sleeping on it. Space data is a $20B market with zero crypto rails today. $SPWAY gives the relay nodes a reason to stay honest and gives users a way to pay per-megabyte from orbit. @spacewaytokens has been shipping quietly — the ground-station simulator alone is worth a look.",
  ],
  base: [
    "Spent the weekend moving my whole DeFi stack to Base and the difference is wild. Swaps settle in two seconds, fees are a rounding error, and every onchain app I use now talks to the same wallet. Built a tiny tipping bot for my group chat on top of it — took an afternoon. Base is the first chain where being onchain feels like using a normal app.",
    "Shipped my first onchain game this month on Base: a daily word puzzle where streaks are NFTs. 1,200 players in week one. What surprised me: nobody asked about gas, nobody got stuck on bridging, people just played. If you are building consumer apps, Base is the obvious home right now.",
    "Three things I loved onchain on Base this month: a lending market that actually explains its risk, a music drop that paid the artist in seconds, and a DAO vote that took ninety seconds end to end. Base keeps getting rid of the boring parts of crypto until only the useful parts are left.",
    "Honest review after 30 days building on Base: the tooling is excellent, the docs are better than most L2s, and onchain data is easy to index. My only gripe is RPC rate limits on the free tier. Still the best place I have found to ship something people actually use.",
    "Base has quietly become where my friends who do not care about crypto end up onchain. They mint a thing, tip a creator, join a group — and only later realise there is a wallet involved. That is what mass adoption looks like: boring, cheap, invisible.",
  ],
  genesis: [
    "Questboard just went live and the model is clever: KOL campaigns where the post is verified against the actual X API and the reward hits your wallet from escrow in one transaction. No forms, no DMs, no waiting two weeks for a spreadsheet payout. This is how creator campaigns should work.",
    "Tried Questboard during genesis week. Linked my X, pasted the post link, watched it check keywords and author in real time, got paid on Base before I closed the tab. Small thing, but the live verification stepper is the best onboarding I have seen in a crypto app.",
    "Questboard turns 'post about us' into an onchain contract with a verifier in the middle. Brands fund escrow, creators post, the platform checks the post and pays. Genesis week was tiny but the mechanics are right.",
  ],
  rejected: [
    { text: 'gm! Loving what SpaceWay is building. The IDO is going to be huge, this is a guaranteed win for early supporters. @spacewaytokens', why: 'banned word + too short' },
    { text: 'Big week for crypto. Base is cooking, onchain summer never ended, and I am here for all of it.', why: 'too short' },
    { text: "SpaceWay is building a settlement layer for in-orbit data. The IDO on Base opens this week and the token is the fee and staking asset for the whole network. I've been following the team for months; this is the first space-economy project with a working testnet and real hardware partners. Doing my own research, and the design holds up well.", why: 'missing SPWAY + mention' },
  ],
};

function fakeTweetUrl(handle) {
  const id = (1_800_000_000_000_000_000n + BigInt('0x' + crypto.randomBytes(7).toString('hex'))).toString();
  return `https://x.com/${handle}/status/${id}`;
}

async function seed({ force = false } = {}) {
  const db = require('../src/db');
  const svc = require('../src/quests');
  const { ethers } = require('ethers');
  const log = require('../src/log');

  if (force) {
    for (const t of ['events', 'rewards', 'submissions', 'users', 'quests']) db.run(`DELETE FROM ${t}`);
  }
  if (db.get('SELECT COUNT(*) AS c FROM quests').c > 0) return false;

  log.info('seeding demo data');
  const created = [];
  for (const q of QUESTS) {
    const { _complete, ...input } = q;
    created.push({ row: svc.createQuest(input), complete: _complete });
  }

  const users = PARTICIPANTS.map((handle) => {
    const wallet = ethers.getAddress('0x' + crypto.createHash('sha256').update(`demo-wallet:${handle}`).digest('hex').slice(0, 40));
    svc.touchUser(wallet);
    return svc.linkX(wallet, { id: `demo:${handle}`, handle, name: handle });
  });

  const [spaceway, base, , genesis] = created.map((c) => c.row);

  const submit = async (quest, user, text, ageHours) => {
    const sub = await svc.submitPost({ quest: svc.getQuest(quest.id), user, tweetUrl: fakeTweetUrl(user.x_handle), postText: text });
    const when = new Date(Date.now() - ageHours * 3600e3).toISOString();
    db.run('UPDATE submissions SET created_at = ?, verified_at = CASE WHEN verified_at IS NULL THEN NULL ELSE ? END, tweet_created_at = ? WHERE id = ?', when, when, when, sub.id);
    db.run('UPDATE events SET created_at = ? WHERE submission_id = ?', when, sub.id);
    db.run('UPDATE rewards SET created_at = ?, sent_at = ? WHERE submission_id = ?', when, when, sub.id);
    return sub;
  };

  // Genesis week — completed performance quest with winners
  for (let i = 0; i < 8; i++) {
    await submit(genesis, users[i], POSTS.genesis[i % POSTS.genesis.length], 9 * 24 + i * 5);
  }
  db.run('UPDATE quests SET created_at = ?, starts_at = ?, ends_at = ? WHERE id = ?', hours(-14 * 24), hours(-14 * 24), hours(-7 * 24), genesis.id);
  await svc.endQuest(svc.getQuest(genesis.id), { reason: 'seed' });
  await svc.processRewardQueue();
  db.run('UPDATE quests SET finalized_at = ?, distributed_at = ?, updated_at = ? WHERE id = ?', hours(-7 * 24), hours(-7 * 24), hours(-7 * 24), genesis.id);

  // SpaceWay — fixed rewards, some verified, some rejected
  db.run('UPDATE quests SET created_at = ? WHERE id = ?', hours(-2 * 24), spaceway.id);
  for (let i = 0; i < 7; i++) {
    await submit(spaceway, users[i + 2], POSTS.spaceway[i % POSTS.spaceway.length], 40 - i * 5);
  }
  await submit(spaceway, users[10], POSTS.rejected[0].text, 12);
  await submit(spaceway, users[11], POSTS.rejected[2].text, 6);
  await svc.processRewardQueue();

  // Base Builders — live performance quest
  db.run('UPDATE quests SET created_at = ? WHERE id = ?', hours(-36), base.id);
  for (let i = 0; i < 9; i++) {
    await submit(base, users[(i + 4) % users.length], POSTS.base[i % POSTS.base.length], 30 - i * 3);
  }
  await submit(base, users[13], POSTS.rejected[1].text, 4);
  await svc.refreshEngagement(svc.getQuest(base.id));

  // Payout events and timestamps should line up with their (backdated) submissions
  db.run("UPDATE rewards SET created_at = (SELECT created_at FROM submissions WHERE id = rewards.submission_id), sent_at = (SELECT created_at FROM submissions WHERE id = rewards.submission_id) WHERE quest_id <> ?", genesis.id);
  db.run("UPDATE events SET created_at = (SELECT created_at FROM submissions WHERE id = events.submission_id) WHERE type LIKE 'reward.%' AND submission_id IS NOT NULL AND quest_id <> ?", genesis.id);
  db.run("UPDATE events SET created_at = ? WHERE quest_id = ? AND type LIKE 'reward.%'", hours(-7 * 24), genesis.id);
  db.run('UPDATE rewards SET created_at = ?, sent_at = ? WHERE quest_id = ?', hours(-7 * 24), hours(-7 * 24), genesis.id);
  db.run("UPDATE events SET created_at = ? WHERE type IN ('quest.created','x.linked') AND created_at > ?", hours(-3 * 24), hours(-1));

  db.saveNow();
  log.info('demo data ready');
  return true;
}

function seedIfEmpty() {
  return seed({ force: false });
}

module.exports = { seed, seedIfEmpty, QUESTS, PARTICIPANTS };

if (require.main === module) {
  (async () => {
    process.env.DEMO_MODE = process.env.DEMO_MODE || 'true';
    const db = require(path.join(__dirname, '..', 'src', 'db'));
    await db.open();
    const did = await seed({ force: process.argv.includes('--force') });
    console.log(did ? 'Seeded demo data.' : 'Database already has quests — use --force to wipe and reseed.');
    db.close();
  })().catch((e) => { console.error(e); process.exit(1); });
}
