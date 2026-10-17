import { createServer, createConnection, type Socket } from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  createDatabase,
  migrate,
  persistOrder,
  persistSale,
} from '../../packages/database/src/index.js';
import {
  RedisAdmission,
  admissionKeys,
  initializeAdmission,
} from '../../packages/redis/dist/index.js';
import {
  processOrder,
  orderGroup,
} from '../../apps/worker/src/orders/consumer.js';
import { testServices } from '../services.js';

// Forward the command, suppress its real server reply, then close both sockets.
async function loseReply(url: string, command: string, partition = false) {
  const endpoint = new URL(url);
  const target = { host: endpoint.hostname, port: Number(endpoint.port) };
  const sockets = new Set<Socket>();
  // Match complete wire command markers, not COMMIT inside READ COMMITTED.
  const marker =
    command === 'COMMIT'
      ? Buffer.concat([
          Buffer.from([0x51, 0, 0, 0, 11]),
          Buffer.from('COMMIT\0'),
        ])
      : Buffer.from(`$${Buffer.byteLength(command)}\r\n${command}\r\n`);
  let dropped = false;
  const server = createServer((client) => {
    const upstream = createConnection(target);

    sockets.add(client);
    sockets.add(upstream);

    let armed = false;
    let tail = Buffer.alloc(0);

    client.on('data', (data) => {
      const chunk = Buffer.concat([tail, data]);

      if (chunk.includes(marker)) armed = true;

      tail = chunk.subarray(Math.max(0, chunk.length - marker.length + 1));
      upstream.write(data);
    });
    upstream.on('data', (data) => {
      if (armed) {
        dropped = true;

        if (!partition) {
          client.destroy();
          upstream.destroy();
        }
      } else client.write(data);
    });

    for (const socket of [client, upstream]) {
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
      socket.on('close', () => sockets.delete(socket));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint.hostname = '127.0.0.1';
  endpoint.port = String((server.address() as { port: number }).port);

  return {
    url: endpoint.href,
    dropped: () => dropped,
    close: async () => {
      for (const socket of sockets) socket.destroy();

      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it.each(['redis_reply', 'redis_partition', 'commit_reply', 'postgres_restart'])(
  '%s preserves uncertain work and converges',
  async (scenario) => {
    const { database, redis } = testServices();

    await redis.connect();

    const sale = {
      id: randomUUID(),
      startsAt: new Date(Date.now() + 2000).toISOString(),
      endsAt: new Date(Date.now() + 3600000).toISOString(),
      initialStock: 1,
    };
    const keys = admissionKeys(sale.id),
      gate = new RedisAdmission(process.env.TEST_REDIS_URL!);
    let proxy: Awaited<ReturnType<typeof loseReply>> | undefined;
    let uncertainDatabase: ReturnType<typeof createDatabase> | undefined;

    try {
      await migrate(database);
      await persistSale(database, sale);
      await initializeAdmission(redis, sale);
      await gate.recover(sale, []);
      await expect
        .poll(
          async () => {
            const time = (await redis.sendCommand(['TIME'])) as string[];

            return (
              Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000) >=
              Date.parse(sale.startsAt)
            );
          },
          { timeout: 5000, interval: 25 },
        )
        .toBe(true);

      if (scenario.startsWith('redis_')) {
        proxy = await loseReply(
          process.env.TEST_REDIS_URL!,
          'EVAL',
          scenario === 'redis_partition',
        );

        const uncertain = new RedisAdmission(proxy.url, 1, 2000);

        expect(
          await uncertain.place(sale.id, {
            identifier: 'person',
            idempotencyKey: 'key',
          }),
        ).toEqual({ status: 'PROCESSING', phase: 'confirming' });
        uncertain.close();
        expect(proxy.dropped()).toBe(true);
      }

      expect(
        await gate.place(sale.id, {
          identifier: 'person',
          idempotencyKey: 'key',
        }),
      ).toEqual({ status: 'PROCESSING', phase: 'queued' });
      await redis.xGroupCreate(keys[4], orderGroup, '0');

      const entry = (await redis.xReadGroup(orderGroup, 'network', {
        key: keys[4],
        id: '>',
      }))![0]!.messages[0]!;

      if (scenario === 'commit_reply') {
        proxy = await loseReply(process.env.TEST_DATABASE_URL!, 'COMMIT');
        uncertainDatabase = createDatabase(proxy.url, 1, 1000);
        await expect(
          persistOrder(uncertainDatabase, {
            saleId: sale.id,
            identifier: 'person',
            admittedAtMs: Number(entry.message.admitted_at_ms),
          }),
        ).rejects.toThrow();
        expect(proxy.dropped()).toBe(true);
        expect(
          (
            await database.query(
              'SELECT id FROM "order" WHERE flash_sale_id=$1',
              [sale.id],
            )
          ).rowCount,
        ).toBe(1);
        expect(await redis.hGet(`${keys[0]}:completed`, 'person')).toBeNull();
      }

      if (scenario === 'postgres_restart') {
        const docker = (...args: string[]) =>
          execFileSync(
            'docker',
            [
              'compose',
              '-f',
              'compose.test.yaml',
              '-p',
              process.env.TEST_PROJECT!,
              ...args,
            ],
            { stdio: 'pipe', timeout: 30000 },
          );

        docker('kill', '-s', 'SIGKILL', 'postgres');
        await expect(
          processOrder(database, redis, gate, sale.id, entry),
        ).rejects.toThrow();
        expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
        docker('up', '-d', '--wait', 'postgres');
      }

      await processOrder(database, redis, gate, sale.id, entry);
      await processOrder(database, redis, gate, sale.id, entry);

      const orders = await database.query(
        'SELECT id, user_identifier FROM "order" WHERE flash_sale_id=$1',
        [sale.id],
      );

      expect(orders.rows.map((r) => r.user_identifier)).toEqual(['person']);
      expect(await redis.hLen(keys[3])).toBe(1);
      expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
      expect((await redis.xPending(keys[4], orderGroup)).pending).toBe(0);
      expect(await redis.hGet(`${keys[0]}:completed`, 'person')).toBe(
        orders.rows[0]!.id,
      );
      expect(
        await gate.place(sale.id, {
          identifier: 'other',
          idempotencyKey: 'other',
        }),
      ).toEqual({ status: 'REJECTED', reason: 'sold_out' });
      expect((await gate.lookup(sale.id, 'missing')).status).toBe('confirming');

      const directory = `test-results/failure/${process.env.TEST_PROJECT}`;

      await mkdir(directory, { recursive: true });
      await writeFile(
        `${directory}/${scenario}.json`,
        JSON.stringify(
          {
            scenario,
            saleId: sale.id,
            dropped: proxy?.dropped(),
            orders: orders.rows,
            remaining: 0,
            pending: 0,
          },
          null,
          2,
        ),
      );
    } finally {
      gate.close();
      await proxy?.close();
      await uncertainDatabase?.end();
      redis.destroy();
      await database.end();
    }
  },
  60000,
);
