import {
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// Explicit project paths keep unrelated experiments out of the generated archive.
const projects = process.argv.slice(2);
if (!projects.length)
  throw new Error('Pass test-results/stress/flash-test-* project paths');
const root = resolve('test-results/stress');
const destination = resolve('test-results/stress-archive');
const summaries = [],
  manifest = [];
const withoutRecords = (burst) =>
  burst &&
  Object.fromEntries(
    Object.entries(burst).filter(([key]) => key !== 'records'),
  );
for (const project of projects) {
  const source = resolve(project);
  const name = relative(root, source);
  if (!/^flash-test-[0-9a-f-]{36}$/.test(name))
    throw new Error('Expected an isolated stress project');
  for (const scenario of readdirSync(source, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory(),
  )) {
    const directory = join(source, scenario.name);
    const hostFile = join(directory, 'host.json');
    const host = existsSync(hostFile) ? JSON.parse(readFileSync(hostFile)) : {};
    const runnerErrorFile = join(directory, 'runner-error.txt');
    const runnerError = existsSync(runnerErrorFile)
      ? readFileSync(runnerErrorFile, 'utf8')
      : undefined;
    for (const file of readdirSync(directory, { withFileTypes: true }).filter(
      (entry) => entry.isFile(),
    )) {
      const data = readFileSync(join(directory, file.name));
      const output = join(destination, name, scenario.name, `${file.name}.gz`);
      mkdirSync(join(destination, name, scenario.name), { recursive: true });
      writeFileSync(output, gzipSync(data));
      manifest.push({
        path: relative(destination, output),
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      });
      if (file.name === 'result.json') {
        const result = JSON.parse(data);
        summaries.push({
          project: name,
          scenario: scenario.name,
          startedAt: result.startedAt,
          replicas: {
            api: host.apiReplicas ?? 1,
            worker: host.workerReplicas ?? 1,
          },
          settings: result.settings,
          sale: result.sale,
          passed: result.passed && !runnerError,
          runnerError,
          error: result.error,
          burst: withoutRecords(result.burst),
          orders: result.final?.orders.length,
          admissions: result.final?.entries.length,
          invariants: result.final?.invariants,
          orderVisibility: result.orderVisibility,
          observationError: result.observationError,
          queueDrainMs: result.queueDrainMs,
        });
      }
    }
    if (!existsSync(join(directory, 'result.json')))
      summaries.push({
        project: name,
        scenario: scenario.name,
        replicas: {
          api: host.apiReplicas ?? 1,
          worker: host.workerReplicas ?? 1,
        },
        passed: false,
        error: runnerError ?? 'Missing result artifact',
        runStatus: 'invalid_generator_or_setup',
      });
  }
}
summaries.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
writeFileSync(
  join(destination, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
writeFileSync(
  join(destination, 'summary.json'),
  JSON.stringify(summaries, null, 2) + '\n',
);
console.log(
  '| Project | Case | Valid dispatch | Last write ms | Orders | Drain ms | Passed |',
);
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of summaries)
  console.log(
    `| ${r.project} | ${r.scenario} | ${r.burst?.validDispatch === true} | ${r.burst?.dispatchLastMs?.toFixed(1) ?? '—'} | ${r.orders ?? '—'} | ${r.queueDrainMs?.toFixed(1) ?? '—'} | ${r.passed} |`,
  );
