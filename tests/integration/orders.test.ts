import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  migrate,
  persistSale,
  persistOrder,
} from '../../packages/database/src/index.js';
import {
  RedisAdmission,
  admissionKeys,
  saleKey,
} from '../../packages/redis/dist/index.js';
import {
  orderGroup,
  processOrder,
} from '../../apps/worker/src/orders/consumer.js';
import { testServices } from '../services.js';

it('persists once across concurrent deliveries, repeats completion/ack and quarantines conflicts', async () => {
  const { redis, database } = testServices();

  await redis.connect();

  const gate = new RedisAdmission(process.env.TEST_REDIS_URL!);

  try {
    await migrate(database);

    const sale = {
      id: randomUUID(),
      startsAt: new Date(Date.now() - 60000).toISOString(),
      endsAt: new Date(Date.now() + 60000).toISOString(),
      initialStock: 2,
    };

    await persistSale(database, sale);

    const keys = admissionKeys(sale.id);

    await redis.hSet(keys[0], {
      starts_at: String(Date.parse(sale.startsAt)),
      ends_at: String(Date.parse(sale.endsAt)),
      initial_stock: '2',
      remaining_stock: '2',
      configuration_version: '1',
    });
    await gate.recover(sale, []);
    await gate.place(sale.id, { identifier: 'person', idempotencyKey: 'key' });

    const stream = admissionKeys(sale.id)[4];

    await redis.xGroupCreate(stream, orderGroup, '0');

    const batch = await redis.xReadGroup(orderGroup, 'original', {
      key: stream,
      id: '>',
    });
    const entry = batch![0]!.messages[0]!;
    const timestamp = Number(entry.message.admitted_at_ms);

    // Simulates slow original and reclaimed worker, then redelivery after commit/status.
    await Promise.all([
      processOrder(database, redis, gate, sale.id, entry),
      processOrder(database, redis, gate, sale.id, entry),
    ]);
    await processOrder(database, redis, gate, sale.id, entry);

    const rows = await database.query(
      'SELECT id, admitted_at FROM "order" WHERE flash_sale_id = $1',
      [sale.id],
    );

    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].admitted_at.getTime()).toBe(timestamp);
    expect(await redis.hGet(`${saleKey(sale.id)}:completed`, 'person')).toBe(
      rows.rows[0].id,
    );
    expect((await redis.xPending(stream, orderGroup)).pending).toBe(0);
    expect(await redis.xLen(stream)).toBe(1);
    await expect(
      persistOrder(database, {
        saleId: sale.id,
        identifier: 'person',
        admittedAtMs: timestamp + 1,
      }),
    ).rejects.toThrow('Conflicting');
    await processOrder(database, redis, gate, sale.id, {
      ...entry,
      message: { ...entry.message, admitted_at_ms: String(timestamp + 1) },
    });
    expect(
      await redis.hExists(`${saleKey(sale.id)}:quarantine`, entry.id),
    ).toBe(1);
    expect(
      (
        await database.query(
          'SELECT id FROM "order" WHERE flash_sale_id = $1',
          [sale.id],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    gate.close();
    redis.destroy();
    await database.end();
  }
});
