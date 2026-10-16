import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const runner = resolve('scripts/submission-check.mjs');
function run(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'submission-check-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(directory, '.env.example'), '');
  const stub = `#!${process.execPath}
const { basename } = require('node:path');
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
if (command === 'git' && args[0] === 'status') console.log(process.env.FAKE_DIRTY || '');
else if (command === 'git' && args[0] === 'rev-parse') console.log(args[1] === 'HEAD' ? 'test-commit' : 'test-tree');
else console.log(command + ' ' + args.join(' '));
if (command === 'pnpm' && args[0] === process.env.FAKE_FAIL) process.exit(7);
`;
  for (const command of ['git', 'pnpm', 'docker']) writeFileSync(join(bin, command), stub, { mode: 0o755 });
  mkdirSync(join(directory, 'test-results/stress/project'), { recursive: true });
  writeFileSync(join(directory, 'test-results/stress/project/result.json'), '{"dispatchValid":false}');
  const result = spawnSync(process.execPath, [runner], { cwd: directory, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...overrides } });
  return { directory, result };
}
function receipt(directory) {
  const root = join(directory, 'test-results/submission/test-commit');
  const output = join(root, readdirSync(root)[0]);
  return { output, report: JSON.parse(readFileSync(join(output, 'result.json'))), manifest: JSON.parse(readFileSync(join(output, 'manifest.json'))) };
}

test('refuses dirty source before invoking checks', t => {
  const { result } = run(t, { FAKE_DIRTY: ' M README.md' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Commit all changes/);
  assert.doesNotMatch(result.stdout, /Checking/);
});

test('pins commands, measurement configuration and artifact hashes without claiming human review', t => {
  const { directory, result } = run(t, { STRESS_CONNECTIONS: '1000' });
  assert.equal(result.status, 0, result.stdout + result.stderr + JSON.stringify(receipt(directory).report));
  const { output, report, manifest } = receipt(directory);
  assert.equal(report.commit, 'test-commit');
  assert.equal(report.tree, 'test-tree');
  assert.equal(report.stress.STRESS_CONNECTIONS, '1000');
  assert.equal(report.humanReview, 'pending');
  assert.equal(report.automatedChecksPassed, true);
  assert.equal(report.steps.length, 12);
  assert.deepEqual(report.steps[9].command.slice(2), ['no-oversell', 'duplicates', 'sufficient-stock', 'burst-10s', 'burst-3s', 'burst-1s', 'spike-10k']);
  assert.equal(manifest.serviceArtifacts.length, 1);
  for (const file of manifest.files) {
    assert.equal(file.sha256, createHash('sha256').update(readFileSync(join(output, file.path))).digest('hex'));
  }
});

test('retains failure and runs remaining checks instead of reporting a false pass', t => {
  const { directory, result } = run(t, { FAKE_FAIL: 'test:integration' });
  assert.equal(result.status, 1);
  const { report } = receipt(directory);
  assert.equal(report.automatedChecksPassed, false);
  assert.equal(report.steps[6].exitCode, 7);
  assert.deepEqual(report.steps.at(-1).command, ['git', 'diff', '--check']);
});
