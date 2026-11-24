'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const workflowDir = path.join(root, '.github', 'workflows');

test('Dependabot tracks npm packages and pinned GitHub Actions', () => {
  const dependabot = fs.readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8');
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

test('development watch mode uses Node built-in and removes vulnerable nodemon dependency', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(packageJson.scripts.dev, 'node --watch server.js');
  assert.equal(packageJson.devDependencies?.nodemon, undefined);
  assert.equal(packageLock.packages[''].devDependencies?.nodemon, undefined);
  assert.equal(packageLock.packages['node_modules/nodemon'], undefined);
  assert.equal(packageLock.packages['node_modules/minimatch'], undefined);
  assert.deepEqual(packageLock.packages[''].devDependencies, packageJson.devDependencies);
});
