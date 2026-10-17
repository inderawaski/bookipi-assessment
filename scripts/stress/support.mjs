import { setTimeout as delay } from 'node:timers/promises';

export async function waitForRedisTime(redis, target) {
  while (true) {
    const time = await redis.sendCommand(['TIME']);
    const now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
    if (now >= target) return now;
    await delay(Math.min(25, target - now));
  }
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
