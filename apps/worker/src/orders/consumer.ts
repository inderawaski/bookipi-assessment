import { randomUUID } from 'node:crypto';
import { persistOrder, OrderConflictError, type createDatabase } from '@flash/database';
import { admissionKeys, createRedisConnection, DurableAdmission, saleKey, finishAttempt, claimAttempt, delayAttempt, defaultRetryPolicy, type RetryPolicy } from '@flash/redis';

export const orderGroup = 'orders';
// Far above the 3s durability deadline and bounded DB statements. Correctness still relies
// on PostgreSQL uniqueness if a paused original resumes after reclamation.
export const reclaimIdleMs = 60000;
type Connection = ReturnType<typeof createRedisConnection>;
export interface StreamOrder { id: string; message: Record<string, string> }

export async function processOrder(database: ReturnType<typeof createDatabase>, redis: Connection,
  admission: DurableAdmission, saleId: string, entry: StreamOrder) {
  const fields = entry.message;
  const quarantine = `${saleKey(saleId)}:quarantine`;
  if (await redis.hExists(quarantine, entry.id)) return;
  try {
    if (fields.sale_id !== saleId || !fields.identifier || !fields.request_key ||
      !/^\d+$/.test(fields.admitted_at_ms ?? '') || !Number.isSafeInteger(Number(fields.admitted_at_ms))) {
      throw new OrderConflictError('Invalid stream identity metadata');
    }
    const confirmation = await admission.lookup(saleId, fields.identifier);
    if (confirmation.status !== 'durable') throw new Error('Admission durability unavailable');
    const reservation = confirmation.reservation;
    if (reservation.requestKey !== fields.request_key || reservation.streamId !== entry.id) {
      throw new OrderConflictError('Conflicting admission identity');
    }
    if (reservation.admittedAtMs !== Number(fields.admitted_at_ms)) throw new OrderConflictError('Conflicting admission timestamp');
    const orderId = await persistOrder(database, { saleId, identifier: fields.identifier, admittedAtMs: reservation.admittedAtMs });
    // Both operations may repeat after a crash; neither removes the stream entry.
    await redis.hSet(`${saleKey(saleId)}:completed`, fields.identifier, orderId);
    await redis.xAck(admissionKeys(saleId)[4], orderGroup, entry.id);
  } catch (error) {
    if (!(error instanceof OrderConflictError)) throw error;
    // Retain pending work and its raw stream data for operator investigation.
    await redis.hSet(quarantine, entry.id, error.message);
  }
}

export async function createOrderConsumer(url: string, database: ReturnType<typeof createDatabase>,
  admission: DurableAdmission, sales: () => Promise<string[]>, report: (error: unknown) => void, policy: RetryPolicy = defaultRetryPolicy) {
  const blocking = createRedisConnection(url, 'blocking-consumer');
  const commands = createRedisConnection(url, 'commands');
  try { await Promise.all([blocking.connect(), commands.connect()]); }
  catch (error) {
    if (blocking.isOpen) blocking.destroy();
    if (commands.isOpen) commands.destroy();
    throw error;
  }
  let stopped = false;
  const consumer = randomUUID();
  const cursors = new Map<string, string>();
  const handle = async (saleId: string, entry: StreamOrder) => {
    if (await commands.hExists(`${saleKey(saleId)}:quarantine`, entry.id)) {
      await commands.zRem(`${saleKey(saleId)}:retry_due`, entry.id);
      return;
    }
    const attempt = await claimAttempt(commands, saleId, entry.id, policy);
    if (!attempt) return;
    try {
      await processOrder(database, commands, admission, saleId, entry);
      if (await commands.hExists(`${saleKey(saleId)}:quarantine`, entry.id)) {
        await commands.zRem(`${saleKey(saleId)}:retry_due`, entry.id);
      } else await finishAttempt(commands, saleId, entry.id, attempt);
    }
    catch {
      await delayAttempt(commands, saleId, entry.id, attempt, policy);
      report(new Error('Order delayed; allocation retained'));
    }
  };
  const run = (async () => {
    while (!stopped) {
      try {
        if (!commands.isReady) await commands.connect();
        if (!blocking.isReady) await blocking.connect();
        const ids = await sales();
        if (!ids.length) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
        for (const saleId of ids) {
          const stream = admissionKeys(saleId)[4];
          try { await commands.xGroupCreate(stream, orderGroup, '0', { MKSTREAM: true }); }
          catch (error) { if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error; }
          const claimed = await commands.xAutoClaim(stream, orderGroup, consumer, reclaimIdleMs, cursors.get(saleId) ?? '0-0', { COUNT: 10 });
          cursors.set(saleId, claimed.nextId);
          for (const entry of claimed.messages) if (entry) await handle(saleId, entry);
          const clock = await commands.sendCommand(['TIME']) as string[];
          const now = Number(clock[0]) * 1000 + Math.floor(Number(clock[1]) / 1000);
          const due = await commands.zRangeByScore(`${saleKey(saleId)}:retry_due`, 0, now, { LIMIT: { offset: 0, count: 10 } });
          for (const id of due) {
            const entries = await commands.xRange(stream, id, id);
            if (entries?.[0]) await handle(saleId, entries[0]);
            const raw = await commands.hGet(`${saleKey(saleId)}:retries`, id);
            if (raw && JSON.parse(raw).exhausted) await commands.zRem(`${saleKey(saleId)}:retry_due`, id);
          }
          const batches = await blocking.xReadGroup(orderGroup, consumer, { key: stream, id: '>' }, { COUNT: 10, BLOCK: 250 });
          for (const batch of batches ?? []) for (const entry of batch.messages) await handle(saleId, entry);
        }
      } catch (error) {
        if (!stopped) { report(error); await new Promise(resolve => setTimeout(resolve, 1000 + Math.floor(Math.random() * 1000))); }
      }
    }
  })();
  return async () => {
    stopped = true;
    if (blocking.isOpen) blocking.destroy();
    await run;
    if (commands.isOpen) commands.destroy();
  };
}
