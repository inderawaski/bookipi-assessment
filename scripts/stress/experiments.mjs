import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function docker(args, tail) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...args, ...tail], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `Docker exit ${code}`)));
  });
}

export async function waitForRedisTime(redis, target) {
  while (true) {
    const time = await redis.sendCommand(['TIME']);
    const now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
    if (now >= target) return now;
    await delay(Math.min(25, target - now));
  }
}

// This task runs concurrently with dispatch, without blocking the generator event loop.
export async function crashWorker(args, events) {
  await delay(200);
  events.push({ event: 'kill_requested', at: new Date().toISOString() });
  try {
    await docker(args, ['kill', '--signal', 'SIGKILL', 'worker']);
    events.push({ event: 'killed', at: new Date().toISOString() });
    await delay(2000);
  } finally {
    await docker(args, ['up', '-d', '--no-deps', '--wait', '--scale', `worker=${process.env.STRESS_WORKER_REPLICAS || 1}`, 'worker']);
    events.push({ event: 'recovered', at: new Date().toISOString() });
  }
  const port = (await docker(args, ['port', '--index', '1', 'worker', '3001'])).split(':').at(-1);
  return `http://127.0.0.1:${port}`;
}

export function pollStatus(base, saleId, records) {
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      const at = new Date().toISOString();
      try {
        const response = await fetch(`${base}/sales/${saleId}/order?identifier=person-0`, { signal: AbortSignal.timeout(5000) });
        records.push({ at, httpStatus: response.status, body: await response.json() });
      } catch (error) { records.push({ at, error: String(error) }); }
      await delay(100);
    }
  })();
  return async () => { stopped = true; await done; };
}
