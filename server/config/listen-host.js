'use strict';

function resolveListenHost(value) {
  if (typeof value !== 'string' || value.trim() === '') return '127.0.0.1';
  return value.trim();
}

module.exports = { resolveListenHost };
