import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus, release, totalmem } from 'node:os';

// Evidence lives outside the commit it identifies: embedding its own SHA in a
// tracked report would change that SHA. Never amend after this final check.
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}
const commit = capture('git', ['rev-parse', 'HEAD']);
if (capture('git', ['status', '--porcelain'])) throw new Error('Commit all changes before the submission check');
const output = resolve('test-results/submission', commit, new Date().toISOString().replaceAll(':', '-'));
mkdirSync(output, { recursive: true });
const report = {
  commit, tree: capture('git', ['rev-parse', 'HEAD^{tree}']), startedAt: new Date().toISOString(),
  host: { platform: process.platform, architecture: process.arch, os: release(), cpu: cpus()[0]?.model, cpus: cpus().length, memoryBytes: totalmem() },
  versions: { node: process.version, pnpm: capture('pnpm', ['--version']), docker: capture('docker', ['version', '--format', '{{json .}}']), compose: capture('docker', ['compose', 'version']) },
  // Record only measurement knobs, never DATABASE_URL or arbitrary environment secrets.
  stress: Object.fromEntries(['STRESS_CONNECTIONS', 'STRESS_MAX_CONNECTIONS', 'STRESS_API_REPLICAS', 'STRESS_WORKER_REPLICAS'].map(key => [key, process.env[key] ?? 'default'])),
  steps: [], humanReview: 'pending',
};
function save() { writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n'); }
save();
const checks = [
  ['pnpm', ['typecheck']], ['pnpm', ['lint']], ['pnpm', ['build']], ['pnpm', ['test']],
  ['docker', ['compose', '--env-file', '.env.example', 'config', '--quiet']],
  ['docker', ['compose', '-f', 'compose.test.yaml', '--profile', 'stress', 'config', '--quiet']],
  ['pnpm', ['test:integration']], ['pnpm', ['test:browser']], ['pnpm', ['test:failure']],
  ['pnpm', ['test:stress', 'no-oversell', 'duplicates', 'sufficient-stock', 'normal-burst', 'aggressive-burst', 'extreme-burst', 'spike-10k']],
  ['git', ['diff', '--check']],
];
for (const [command, args] of checks) {
  const log = `${String(report.steps.length + 1).padStart(2, '0')}-${args[0].replaceAll(':', '-')}.log`;
  console.info(`Checking ${command} ${args.join(' ')} → ${join(output, log)}`);
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  writeFileSync(join(output, log), `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`);
  report.steps.push({ command: [command, ...args], startedAt, endedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal, log });
  save(); // Retain failed checks and continue collecting independent evidence.
}
report.endedAt = new Date().toISOString();
report.sourceUnchanged = capture('git', ['rev-parse', 'HEAD']) === commit && capture('git', ['status', '--porcelain']) === '';
report.automatedChecksPassed = report.sourceUnchanged && report.steps.every(step => step.exitCode === 0);
save();
function hashes(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) return hashes(join(directory, entry.name), relative);
    return [{ path: relative, sha256: createHash('sha256').update(readFileSync(join(directory, entry.name))).digest('hex') }];
  });
}
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ commit, files: hashes(output),
  serviceArtifacts: hashes(resolve('test-results')).filter(file => file.path.startsWith('failure/') || file.path.startsWith('stress/')) }, null, 2) + '\n');
console.info(`Submission evidence: ${output}; automated checks ${report.automatedChecksPassed ? 'passed' : 'failed'}; human review pending`);
process.exitCode = report.automatedChecksPassed ? 0 : 1;
