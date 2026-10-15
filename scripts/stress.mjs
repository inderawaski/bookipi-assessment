import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus, totalmem, platform, release } from 'node:os';
import { createInterface } from 'node:readline';
import { scenarios, resourceSample } from './stress/accounting.mjs';

const selected = process.argv.slice(2);
if (selected.some(name => !scenarios.some(s => s.name === name))) throw new Error('Unknown scenario');
const build = spawnSync('pnpm', ['--filter', './packages/**', 'build'], { stdio: 'inherit' });
if (build.status !== 0) throw new Error('Build failed');
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout;
const jobs = scenarios.filter(s => !selected.length || selected.includes(s.name)).map(scenario => ({ scenario, connections: Number(process.env.STRESS_CONNECTIONS || Math.min(scenario.requests, 10000)) }));
for (const { scenario, connections } of jobs) {
  const project = `flash-test-${randomUUID()}`;
  const output = resolve(`test-results/stress/${project}/${scenario.name}`);
  mkdirSync(output, { recursive: true });
  const args = ['compose', '-f', 'compose.test.yaml', '-f', 'compose.stress.yaml', '-p', project];
  function docker(tail) {
    const result = spawnSync('docker', [...args, ...tail], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr || 'Docker failed');
    return result.stdout.trim();
  }
  let sampler;
  try {
    docker(['--profile', 'stress', 'up', '-d', '--build', '--wait', 'postgres', 'redis', 'api', 'worker']);
    writeFileSync(`${output}/compose.yaml`, docker(['config']));
    writeFileSync(`${output}/host.json`, JSON.stringify({ commit, dirty, node: process.version, platform: platform(), release: release(), cpus: cpus(), memoryBytes: totalmem(),
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
    const port = (service, internal) => docker(['port', service, internal]).split(':').at(-1);
    const child = spawn(process.execPath, ['scripts/stress/case.mjs', scenario.name], { stdio: 'inherit', env: { ...process.env,
      TEST_PROJECT: project, TEST_DATABASE_URL: `postgresql://flash_test:test_only@127.0.0.1:${port('postgres', '5432')}/flash_test`,
      TEST_REDIS_URL: `redis://127.0.0.1:${port('redis', '6379')}`, STRESS_API: `http://127.0.0.1:${port('api', '3000')}`,
      STRESS_WORKER: `http://127.0.0.1:${port('worker', '3001')}`, STRESS_COMMIT: commit, STRESS_OUTPUT: output, STRESS_CONNECTIONS: String(connections) } });
    const code = await new Promise(resolve => { child.once('error', () => resolve(1)); child.once('exit', code => resolve(code)); });
    const resourceSamples = readFileSync(`${output}/resources.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (!resourceSamples.length) throw new Error('Missing resource samples');
    const result = JSON.parse(readFileSync(`${output}/result.json`, 'utf8'));
    if (!result.burst?.validDispatch && connections < Math.min(scenario.requests, 30000)) {
      const increased = Math.min(connections * 2, scenario.requests, 30000);
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
