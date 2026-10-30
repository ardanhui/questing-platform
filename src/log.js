'use strict';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const level = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function fmt(lvl, args) {
  const ts = new Date().toISOString().slice(11, 19);
  return [`${ts} ${lvl.toUpperCase().padEnd(5)}`, ...args];
}

module.exports = {
  debug: (...a) => level <= LEVELS.debug && console.log(...fmt('debug', a)),
  info: (...a) => level <= LEVELS.info && console.log(...fmt('info', a)),
  warn: (...a) => level <= LEVELS.warn && console.warn(...fmt('warn', a)),
  error: (...a) => level <= LEVELS.error && console.error(...fmt('error', a)),
};
