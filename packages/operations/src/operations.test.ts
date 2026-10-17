import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { Metrics, registerOperations } from './index.js';

it('allows concurrent handlers beyond the former 64-request guard and tracks active requests', async () => {
  const app = Fastify();
  const metrics = new Metrics();

  registerOperations(app, metrics);

  let release!: () => void,
    entered!: () => void,
    active = 0;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  app.get('/hold', async () => {
    if (++active === 100) entered();

    await blocked;

    return 'ok';
  });

  const pending = Array.from({ length: 100 }, () =>
    app.inject('/hold').then((value) => value),
  );

  try {
    await started;
    expect(metrics.render()).toContain('flash_http_active 100\n');
    expect(metrics.render()).toContain('flash_http_active_peak 100\n');
    release();
    expect(
      (await Promise.all(pending)).every(
        (response) => response.statusCode === 200,
      ),
    ).toBe(true);

    const response = await app.inject('/metrics');

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('flash_http_busy_total');
    expect(metrics.render()).toContain('flash_http_active 0\n');
  } finally {
    release();
    await Promise.allSettled(pending);
    await app.close();
  }
});

it('tracks a disconnected handler until completion without rejecting another request', async () => {
  const { request } = await import('node:http');
  const app = Fastify();
  const metrics = new Metrics();

  registerOperations(app, metrics);

  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  app.get('/hold', async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });

    return 'finished';
  });
  app.get('/fast', async () => 'ok');

  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  try {
    const client = request(address + '/hold');

    client.on('error', () => {});
    client.end();
    await started;
    client.destroy();
    expect((await app.inject('/fast')).statusCode).toBe(200);
    release();

    // Wait for the handler's onSend, not for delivery on the closed client socket.
    for (
      let i = 0;
      i < 100 && metrics.render().includes('flash_http_active 1\n');
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));

    expect(metrics.render()).toContain('flash_http_active 0\n');
    expect((await app.inject('/metrics')).statusCode).toBe(200);
  } finally {
    release?.();
    await app.close();
  }
});
