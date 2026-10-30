'use strict';
const config = require('./src/config');
const log = require('./src/log');
const db = require('./src/db');
const { createApp } = require('./src/app');
const scheduler = require('./src/scheduler');
const tweets = require('./src/tweets');
const chain = require('./src/chain');
const seed = require('./scripts/seed');

async function main() {
  await db.open();
  if (config.demo) seed.seedIfEmpty();

  const app = createApp();
  const server = app.listen(config.port, () => {
    const provider = tweets.providerInfo();
    console.log('');
    console.log(`  ${config.brand.name} ${config.demo ? '· DEMO MODE' : ''}`);
    console.log(`  ─────────────────────────────────────────────`);
    console.log(`  Board      ${config.baseUrl}/`);
    console.log(`  Admin      ${config.baseUrl}/admin  (password: ${config.adminPassword ? (config.demo ? config.adminPassword : 'set') : 'NOT SET'})`);
    console.log(`  Posts via  ${provider.label}${provider.metrics ? '' : ' — no engagement metrics'}`);
    console.log(`  X sign-in  ${config.features.xOAuth ? 'configured' : config.demo ? 'simulated (demo)' : 'NOT configured (X_CLIENT_ID)'}`);
    console.log(`  Escrow     ${config.features.escrow ? chain.escrowAddress() : config.demo ? 'simulated payouts (demo)' : 'NOT configured (ESCROW_PRIVATE_KEY)'}`);
    if (config.sessionSecretGenerated) console.log('  Warning    SESSION_SECRET not set — sessions reset on restart');
    console.log('');
  });

  scheduler.start();

  const shutdown = (sig) => {
    log.info(`${sig} received — saving database`);
    scheduler.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('Startup failed:', e);
  process.exit(1);
});
