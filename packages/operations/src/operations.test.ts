import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { Metrics, registerOperations } from './index.js';

it('rejects excess requests without queueing and recovers capacity after completion', async () => {
  const app = Fastify();
  const metrics = new Metrics();
  registerOperations(app, metrics, 1);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  app.get('/hold', async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return 'ok'; });
  await app.ready();
  try {
    const first = app.inject('/hold');
    const pending = first.then(value => value);
    await started;
    for (let i = 0; i < 1000; i++) {
      const response = await app.inject('/hold');
      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({ status: 'REJECTED', reason: 'busy' });
      expect(response.headers['retry-after']).toBe('1');
    }
    expect(metrics.render()).toContain('flash_http_active 1\n');
    release(); await pending;
    const response = await app.inject('/metrics');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('flash_http_busy_total 1000\n');
    expect(response.body).toContain('flash_process_rss_bytes');
    expect(metrics.render()).toContain('flash_http_active 0\n');
  } finally { await app.close(); }
});

it('retains the slot after disconnect until the handler completes', async () => {
  const { request } = await import('node:http');
  const app = Fastify();
  const metrics = new Metrics();
  registerOperations(app, metrics, 1);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  app.get('/hold', async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return 'finished'; });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const client = request(address + '/hold');
    client.on('error', () => {}); client.end();
    await started;
    client.destroy();
    expect((await app.inject('/hold')).statusCode).toBe(429);
    release();
    // Wait for the handler's onSend, not for delivery on the closed client socket.
    for (let i = 0; i < 100 && metrics.render().includes('flash_http_active 1\n'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(metrics.render()).toContain('flash_http_active 0\n');
    expect((await app.inject('/metrics')).statusCode).toBe(200);
  } finally { release?.(); await app.close(); }
});
