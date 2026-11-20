'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const workflowDir = path.join(__dirname, '..', '.github', 'workflows');

test('Dependabot tracks npm packages and pinned GitHub Actions', () => {
  const dependabot = fs.readFileSync(path.join(__dirname, '..', '.github', 'dependabot.yml'), 'utf8');
  assert.match(dependabot, /package-ecosystem:\s*npm/);
  assert.match(dependabot, /package-ecosystem:\s*github-actions/);
});

test('third-party GitHub Actions are pinned to immutable full commit SHAs', () => {
  const files = fs.readdirSync(workflowDir).filter(file => /\.ya?ml$/i.test(file));
  assert.ok(files.length > 0, 'workflow directory must contain workflow files');

  for (const file of files) {
    const content = fs.readFileSync(path.join(workflowDir, file), 'utf8');
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const match = line.match(/^\s*uses:\s*([^\s#]+)/);
      if (!match) continue;

      const reference = match[1];
      if (reference.startsWith('./')) continue;

      const separator = reference.lastIndexOf('@');
      assert.notEqual(separator, -1, file + ':' + (index + 1) + ' must pin an action ref');
      const sha = reference.slice(separator + 1);
      assert.match(sha, /^[0-9a-f]{40}$/i, file + ':' + (index + 1) + ' must use a full immutable commit SHA');
    }
  }
});
