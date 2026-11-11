'use strict';
const fs = require('fs');
async function removeInitialSuperAdminCredential(username, options = {}) {
  if (typeof username !== 'string' || !username) return { ok: false, reason: 'invalid_username' };
  const file = options.file || process.env.INIT_CRED_FILE || '/var/lib/foodflow/initial-credentials.txt';
  const tempFile = file + '.tmp-' + process.pid + '-' + Date.now();
  try {
    let content;
    try { content = await fs.promises.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { ok: true, removed: false }; throw error; }
    const remaining = [];
    let removed = false;
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([^:]+):\s+(\S+)\s+\/\s+(.+)$/);
      if (match && match[1] === 'superAdmin') {
        if (match[2] !== username) return { ok: false, reason: 'username_mismatch' };
        removed = true;
        continue;
      }
      if (line) remaining.push(line);
    }
    if (!removed) return { ok: true, removed: false };
    if (!remaining.length) { await fs.promises.unlink(file); return { ok: true, removed: true }; }
    await fs.promises.writeFile(tempFile, remaining.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    await fs.promises.chmod(tempFile, 0o600);
    await fs.promises.rename(tempFile, file);
    await fs.promises.chmod(file, 0o600);
    return { ok: true, removed: true };
  } catch (_) {
    try { await fs.promises.unlink(tempFile); } catch (_) {}
    return { ok: false, reason: 'filesystem_error' };
  }
}
module.exports = { removeInitialSuperAdminCredential };
