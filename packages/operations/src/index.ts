import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Names are code-owned constants, never identifiers supplied by clients.
export class Metrics {
  private values = new Map<string, number>();
  add(name: string, value = 1) { this.values.set(name, (this.values.get(name) ?? 0) + value); }
  set(name: string, value: number) { this.values.set(name, value); }
  observe(name: string, seconds: number) { this.add(`${name}_count`); this.add(`${name}_sum`, seconds); }
  render() {
    const memory = process.memoryUsage();
    this.set('process_rss_bytes', memory.rss);
    this.set('process_heap_used_bytes', memory.heapUsed);
    this.set('process_cpu_seconds_total', (process.cpuUsage().user + process.cpuUsage().system) / 1e6);
    return [...this.values].map(([name, value]) => `flash_${name} ${value}`).join('\n') + '\n';
  }
}
export function correlation(value: string) { return createHash('sha256').update(value).digest('hex').slice(0, 24); }

export function registerOperations(app: FastifyInstance, metrics: Metrics, limit: number,
  sample: () => Promise<void> = async () => {}) {
  let active = 0;
  const held = new WeakSet<object>();
  app.addHook('onRequest', async (request, reply) => {
    if (active >= limit) {
      metrics.add('http_busy_total');
      return reply.header('Retry-After', '1').code(429).send({ status: 'REJECTED', reason: 'busy' });
    }
    active++; held.add(request);
    metrics.set('http_active', active);
  });
  // onSend runs after the handler even when the socket has disconnected.
  app.addHook('onSend', async (request, _reply, payload) => {
    if (held.delete(request)) active--;
    metrics.set('http_active', active);
    return payload;
  });
  app.addHook('onResponse', async (_request, reply) => {
    metrics.add('http_requests_total');
    if (reply.statusCode >= 400) metrics.add('http_errors_total');
    metrics.observe('http_latency_seconds', reply.elapsedTime / 1000);
  });
  app.get('/metrics', async (_request, reply) => {
    try { await sample(); metrics.set('metrics_sample_available', 1); }
    catch { metrics.set('metrics_sample_available', 0); }
    return reply.type('text/plain; version=0.0.4').send(metrics.render());
  });
}
