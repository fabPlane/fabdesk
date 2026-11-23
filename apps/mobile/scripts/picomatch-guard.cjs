const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync, realpathSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const hashes = require('./picomatch-hashes.json');

function findPicomatches(root) {
  const visited = new Set();
  const found = new Set();
  function modules(directory) {
    if (!existsSync(directory)) return;
    const real = realpathSync(directory);
    if (visited.has(real)) return;
    visited.add(real);
    function visitPackage(directory) {
      const manifest = join(directory, 'package.json');
      if (!existsSync(manifest)) return;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.name === 'picomatch') found.add(realpathSync(directory));
      modules(join(directory, 'node_modules'));
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const candidate = join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(candidate)) visitPackage(join(candidate, scoped));
      } else visitPackage(candidate);
    }
  }
  modules(join(root, 'node_modules'));
  return [...found];
}

function verifyPatchedFiles(paths) {
  const versions = new Set();
  if (!paths.length) throw new Error('No installed picomatch copies found');
  for (const directory of paths) {
    const version = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version;
    const actual = createHash('sha256').update(readFileSync(join(directory, 'lib/parse.js'))).digest('hex');
    if (!hashes[version] || actual !== hashes[version]) {
      throw new Error(`Unverified picomatch ${version} at ${directory}; refusing patched-advisory treatment`);
    }
    versions.add(version);
  }
  for (const version of Object.keys(hashes)) {
    if (!versions.has(version)) throw new Error(`Expected picomatch ${version} missing; review patch coverage`);
  }
}

// Run the actual generated regexes under Node/V8, not only Bun's regex engine.
// A vulnerable regexp must time out this child instead of hanging the CI process.
function testMatching(directory) {
  const result = spawnSync('node', ['-e', `
    const assert = require('node:assert/strict');
    const pm = require(process.argv[1]);
    const patterns = ['+(*)b', '+(*a)b', '*(a*)b', '+(*?)b', '+(*a|b)c', '+(@(*a))b'];
    for (const options of [{}, { fastpaths: false }, { capture: true }, { dot: true }, { windows: true }]) {
      for (const pattern of patterns) {
        const re = pm.makeRe(pattern, options);
        assert.equal(re.test('a'.repeat(64) + '!'), false, pattern);
        assert.equal(pm.isMatch(pattern, pattern, options), true, 'risky extglob is literal: ' + pattern);
      }
    }
    for (const [pattern, yes, no] of [
      ['src/**/*.{js,ts}', 'src/lib/index.ts', 'src/index.css'],
      ['+(foo|bar).js', 'foobar.js', 'baz.js'],
      ['+([ab]).js', 'abba.js', 'abc.js'],
      ['+([*]).js', '***.js', 'a.js'],
      ['src/!(*.test).ts', 'src/index.ts', 'src/index.test.ts']
    ]) {
      assert.equal(pm.isMatch(yes, pattern), true, pattern);
      assert.equal(pm.isMatch(no, pattern), false, pattern);
    }
  `, directory], { encoding: 'utf8', timeout: 3000 });
  if (result.error || result.status !== 0) {
    throw new Error(`picomatch matching regression failed at ${directory}: ${result.error?.message || result.stderr}`);
  }
}

function verifyInstallation(root) {
  const paths = findPicomatches(root);
  verifyPatchedFiles(paths);
  for (const directory of paths) testMatching(directory);
  return paths.length;
}

module.exports = { findPicomatches, verifyPatchedFiles, testMatching, verifyInstallation };
if (require.main === module) console.log(`Verified ${verifyInstallation(join(__dirname, '..'))} patched picomatch copies under Node`);
