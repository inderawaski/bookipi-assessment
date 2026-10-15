import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const suite = process.argv[2];
if (!['integration', 'failure', 'stress'].includes(suite)) throw new Error('Expected integration, failure or stress');
const project = `flash-test-${randomUUID()}`;
const args = ['compose', '-f', 'compose.test.yaml', '-p', project];
function docker(tail, capture = false) {
  const result = spawnSync('docker', [...args, ...tail], { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`Docker command failed: ${tail[0]}`);
  return result.stdout?.trim();
}
const daemon = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
if (daemon.status !== 0) {
  console.error('Docker daemon is unavailable. Start Docker before running service tests.');
  process.exit(1);
}
try {
  docker(['up', '-d', '--wait', 'postgres', 'redis']);
  if (suite === 'stress') {
    docker(['--profile', 'stress', 'run', '--build', '--rm', 'k6']);
  } else {
    const pg = docker(['port', 'postgres', '5432'], true).split(':').at(-1);
    const redis = docker(['port', 'redis', '6379'], true).split(':').at(-1);
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.services.config.ts', ...process.argv.slice(3)], {
      stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test', TEST_SUITE: suite, TEST_PROJECT: project,
        TEST_DATABASE_URL: `postgresql://flash_test:test_only@127.0.0.1:${pg}/flash_test`, TEST_REDIS_URL: `redis://127.0.0.1:${redis}` },
    });
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Service test runner failed');
  process.exitCode = 1;
} finally {
  // Only the randomly generated project owned by this invocation can be removed.
  try { docker(['down', '--volumes', '--remove-orphans']); }
  catch { console.error(`Cleanup failed for isolated project ${project}`); process.exitCode = 1; }
}
