/**
 * server/middleware/password.js
 * 密码哈希/校验（从 server.js 抽出）
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function hashPassword(pwd) {
  return bcrypt.hashSync(pwd, 8);
}

function verifyPassword(pwd, hash) {
  if (!hash) return false;
  if (hash.startsWith('$2')) {
    return bcrypt.compareSync(pwd, hash);
  }
  return crypto.createHash('sha256').update(pwd).digest('hex') === hash;
}

module.exports = { hashPassword, verifyPassword };
