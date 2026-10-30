'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const auth = require('./auth');
const log = require('./log');
const { AppError } = require('./quests');
const { TweetError } = require('./tweets');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));
  app.use(auth.attachUser);

  // basic hardening headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  const pub = path.join(config.root, 'public');
  app.use(express.static(pub, { extensions: ['html'], index: false, maxAge: config.demo ? 0 : '1h' }));

  app.use(require('./routes/auth'));
  app.use(require('./routes/public'));
  app.use(require('./routes/admin'));

  // pages
  const page = (file) => (req, res) => res.sendFile(path.join(pub, file));
  app.get('/', page('index.html'));
  app.get('/quest/:id', page('quest.html'));
  app.get('/me', page('me.html'));
  app.get('/admin', page('admin.html'));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }));

  // error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError || err instanceof TweetError) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code });
    }
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body', code: 'BAD_JSON' });
    log.error(`unhandled error on ${req.method} ${req.path}: ${err && err.stack ? err.stack : err}`);
    res.status(500).json({ error: 'Something went wrong on the server', code: 'INTERNAL' });
  });

  return app;
}

module.exports = { createApp };
