import { expect, it, vi } from 'vitest';
import { createDatabase, persistOrder } from '@flash/database';
import {
  createRedisConnection,
  RedisAdmission,
  type ValidatedReservation,
} from '@flash/redis';
import { processOrder } from './consumer.js';

vi.mock('@flash/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  persistOrder: vi.fn(),
}));

it('does not publish or acknowledge before a successful commit; completion and ack failures replay safely', async () => {
  const database = createDatabase('postgresql://unused', 1, 100);
  const redis = createRedisConnection('redis://unused', 'commands');
  const gate = new RedisAdmission('redis://unused');

  vi.spyOn(redis, 'hExists').mockResolvedValue(0);

  const status = vi.spyOn(redis, 'hSet').mockResolvedValue(1);
  const ack = vi.spyOn(redis, 'xAck').mockResolvedValue(1);
  const lookup = vi.spyOn(gate, 'lookup').mockResolvedValue({
    status: 'confirming',
    diagnostic: 'admission_unavailable',
  });
  const entry = {
    id: '1-0',
    message: {
      sale_id: 'sale',
      identifier: 'person',
      request_key: 'key',
      admitted_at_ms: '1234',
    },
  };

  try {
    await expect(
      processOrder(database, redis, gate, 'sale', entry),
    ).rejects.toThrow('validation');
    expect(persistOrder).not.toHaveBeenCalled();
    lookup.mockResolvedValue({
      status: 'present',
      reservation: {
        requestKey: 'key',
        streamId: '1-0',
        admittedAtMs: 1234,
      } as ValidatedReservation,
    });
    vi.mocked(persistOrder).mockRejectedValueOnce(
      new Error('Unknown commit result'),
    );
    await expect(
      processOrder(database, redis, gate, 'sale', entry),
    ).rejects.toThrow('Unknown commit');
    expect(status).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    vi.mocked(persistOrder).mockResolvedValue('order');
    status.mockRejectedValueOnce(new Error('Killed after commit'));
    await expect(
      processOrder(database, redis, gate, 'sale', entry),
    ).rejects.toThrow('Killed');
    expect(ack).not.toHaveBeenCalled();
    ack.mockRejectedValueOnce(new Error('Killed before ack'));
    await expect(
      processOrder(database, redis, gate, 'sale', entry),
    ).rejects.toThrow('Killed');
    await processOrder(database, redis, gate, 'sale', entry);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenLastCalledWith(
      expect.stringContaining(':completed'),
      'person',
      'order',
    );
  } finally {
    await database.end();
    vi.restoreAllMocks();
  }
});

it('refuses worker failpoints outside test mode', async () => {
  const database = createDatabase('postgresql://unused', 1, 100);
  const redis = createRedisConnection('redis://unused', 'commands');
  const gate = new RedisAdmission('redis://unused');

  vi.stubEnv('NODE_ENV', 'production');

  try {
    const hook = vi.fn(async () => {});

    await expect(
      processOrder(
        database,
        redis,
        gate,
        'sale',
        { id: '1-0', message: {} },
        hook,
      ),
    ).rejects.toThrow('test mode');
    expect(hook).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    await database.end();
  }
});
