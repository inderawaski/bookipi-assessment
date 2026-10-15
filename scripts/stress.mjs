import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus, totalmem, platform, release } from 'node:os';
import { createInterface } from 'node:readline';
import { scenarios, resourceSample } from './stress/accounting.mjs';

const selected = process.argv.slice(2);
const maxConnections = Number(process.env.STRESS_MAX_CONNECTIONS || 30000);
if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 30000) throw new Error('Maximum connections must be 1..30000');
const requestedConnections = Number(process.env.STRESS_CONNECTIONS || Math.min(10000, maxConnections));
if (!Number.isInteger(requestedConnections) || requestedConnections < 1 || requestedConnections > maxConnections) throw new Error('Connections must be 1..STRESS_MAX_CONNECTIONS');
const apiReplicas = Number(process.env.STRESS_API_REPLICAS || 1);
const workerReplicas = Number(process.env.STRESS_WORKER_REPLICAS || 1);
if (![apiReplicas, workerReplicas].every(n => Number.isInteger(n) && n >= 1 && n <= 8)) throw new Error('Replica counts must be 1..8');
if (selected.some(name => !scenarios.some(s => s.name === name))) throw new Error('Unknown scenario');
const build = spawnSync('pnpm', ['--filter', './packages/**', 'build'], { stdio: 'inherit' });
if (build.status !== 0) throw new Error('Build failed');
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout;
const jobs = scenarios.filter(s => !selected.length || selected.includes(s.name)).map(scenario => ({ scenario, connections: Math.min(scenario.requests, requestedConnections) }));
for (const { scenario, connections } of jobs) {
  const project = `flash-test-${randomUUID()}`;
  const output = resolve(`test-results/stress/${project}/${scenario.name}`);
  mkdirSync(output, { recursive: true });
  const args = ['compose', '-f', 'compose.test.yaml', '-f', 'compose.stress.yaml', '-p', project, '--profile', 'stress'];
  function docker(tail) {
    const result = spawnSync('docker', [...args, ...tail], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr || 'Docker failed');
    return result.stdout.trim();
  }
  let sampler;
  try {
    docker(['up', '-d', '--build', '--wait', '--scale', `api=${apiReplicas}`, '--scale', `worker=${workerReplicas}`, 'postgres', 'redis', 'api', 'worker', 'proxy']);
    writeFileSync(`${output}/compose.yaml`, docker(['config']));
    const sources = ['scripts/stress.mjs', 'scripts/stress/case.mjs', 'scripts/stress/generator.mjs', 'scripts/stress/accounting.mjs', 'scripts/stress/experiments.mjs', 'compose.test.yaml', 'compose.stress.yaml', 'deploy/stress-proxy.conf'];
    writeFileSync(`${output}/sources.json`, JSON.stringify(Object.fromEntries(sources.map(path => [path, readFileSync(path, 'utf8')])), null, 2));
    writeFileSync(`${output}/host.json`, JSON.stringify({ commit, dirty, node: process.version, platform: platform(), release: release(), cpus: cpus(), memoryBytes: totalmem(), apiReplicas, workerReplicas, runningContainers: spawnSync('docker', ['ps', '--format', '{{.Names}} {{.Status}}'], { encoding: 'utf8' }).stdout, dockerVersion: spawnSync('docker', ['version'], { encoding: 'utf8' }).stdout, dockerInfo: spawnSync('docker', ['info'], { encoding: 'utf8' }).stdout,
      limits: spawnSync('sh', ['-c', 'ulimit -a'], { encoding: 'utf8' }).stdout,
      socketLimits: spawnSync('sysctl', ['net.inet.ip.portrange.first', 'net.inet.ip.portrange.last', 'kern.maxfilesperproc', 'kern.maxfiles'], { encoding: 'utf8' }).stdout || 'Unavailable on this platform; inspect host port limits before larger experiments',
      network: spawnSync('netstat', ['-s'], { encoding: 'utf8' }).stdout }, null, 2));
    const ids = docker(['ps', '-q']).split('\n');
    // Continuous samples are retained independently of the load generator's event loop.
    sampler = spawn('docker', ['stats', '--format', '{{json .}}', ...ids], { stdio: ['ignore', 'pipe', 'pipe'] });
    sampler.on('error', error => writeFileSync(`${output}/resources-errors.log`, String(error)));
    createInterface({ input: sampler.stdout }).on('line', line => {
      try {
        const sample = resourceSample(line);
        if (sample) appendFileSync(`${output}/resources.jsonl`, JSON.stringify(sample) + '\n');
      } catch (error) { appendFileSync(`${output}/resources-errors.log`, String(error) + '\n'); }
    });
    sampler.stderr.on('data', chunk => appendFileSync(`${output}/resources-errors.log`, chunk));
    const port = (service, internal, index = 1) => docker(['port', '--index', String(index), service, internal]).split(':').at(-1);
    const child = spawn(process.execPath, ['scripts/stress/case.mjs', scenario.name], { stdio: 'inherit', env: { ...process.env,
      TEST_PROJECT: project, TEST_DATABASE_URL: `postgresql://flash_test:test_only@127.0.0.1:${port('postgres', '5432')}/flash_test`,
      TEST_REDIS_URL: `redis://127.0.0.1:${port('redis', '6379')}`, STRESS_API: `http://127.0.0.1:${port('proxy', '80')}`,
      STRESS_API_ENDPOINTS: JSON.stringify(Array.from({ length: apiReplicas }, (_, i) => `http://127.0.0.1:${port('api', '3000', i + 1)}`)),
      STRESS_COMPOSE_ARGS: JSON.stringify(args), STRESS_WORKER: `http://127.0.0.1:${port('worker', '3001')}`, STRESS_COMMIT: commit, STRESS_OUTPUT: output, STRESS_CONNECTIONS: String(connections) } });
    const code = await new Promise(resolve => { child.once('error', () => resolve(1)); child.once('exit', code => resolve(code)); });
    const result = JSON.parse(readFileSync(`${output}/result.json`, 'utf8'));
    const resourceSamples = existsSync(`${output}/resources.jsonl`) ? readFileSync(`${output}/resources.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    if (!resourceSamples.length) throw new Error(`Missing resource samples; case error: ${result.error ?? 'none'}`);
    const validDispatch = result.burst?.validDispatch && (result.repeatedBursts ?? []).every(burst => burst.validDispatch);
    if (!validDispatch && connections < Math.min(scenario.requests, maxConnections)) {
      const increased = Math.min(connections * 2, scenario.requests, maxConnections);
      console.info(`Invalid dispatch: rerunning with ${increased} preconnected sockets in a fresh project`);
      jobs.push({ scenario, connections: increased });
    }
    else if (code !== 0) process.exitCode = 1;
    console.info(`${scenario.name}: ${output}/result.json`);
  } catch (error) {
    writeFileSync(`${output}/runner-error.txt`, String(error));
    console.error(String(error)); process.exitCode = 1;
  } finally {
    sampler?.kill();
    writeFileSync(`${output}/network-after.txt`, spawnSync('netstat', ['-s'], { encoding: 'utf8' }).stdout ?? 'unavailable');
    try { writeFileSync(`${output}/services.log`, docker(['logs', '--no-color'])); }
    catch { process.exitCode = 1; }
    try { docker(['down', '--volumes', '--remove-orphans']); }
    catch { console.error(`Cleanup failed: ${project}`); process.exitCode = 1; }
  }
}
