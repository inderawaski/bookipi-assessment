import http from 'node:http';
import net from 'node:net';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { inputs, summarize } from './accounting.mjs';

// Finish fires after headers/body are handed to the OS, after socket acquisition.
// This is a conservative upper bound on dispatch, not an iteration-start proxy.
export async function burst(
  baseUrl,
  saleId,
  scenario,
  {
    connections = Math.min(scenario.requests, 10000),
    timeoutMs = 30000,
    beforeDispatch,
    onDispatch,
    dispatchWindowMs = scenario.dispatchWindowMs ?? 1000,
    scheduleWindowMs = scenario.scheduleWindowMs ?? dispatchWindowMs * 0.9,
  } = {},
) {
  const url = new URL(baseUrl);

  if (url.protocol !== 'http:')
    throw new Error('Isolated harness requires HTTP');

  if (
    !Number.isInteger(connections) ||
    connections < 1 ||
    connections > scenario.requests
  )
    throw new Error('Connections must be between 1 and offered requests');

  const sockets = [];
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: connections,
    maxFreeSockets: connections,
  });
  const records = inputs(scenario).map((input, index) => ({
    index,
    input,
    scheduledMs: (index * scheduleWindowMs) / scenario.requests,
  }));
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const cpu = process.cpuUsage();
  const started = performance.now();

  try {
    // All TCP handshakes finish before the measured window. No warmup purchases.
    for (let i = 0; i < connections; i += 256) {
      await Promise.all(
        Array.from(
          { length: Math.min(256, connections - i) },
          () =>
            new Promise((resolve, reject) => {
              const socket = net.createConnection({
                host: url.hostname,
                port: Number(url.port || 80),
              });

              sockets.push(socket);
              socket.setTimeout(timeoutMs, () =>
                socket.destroy(new Error('Preconnect timeout')),
              );
              socket.once('error', reject);
              socket.once('connect', () => {
                socket.setTimeout(0);
                socket.setNoDelay(true);
                resolve();
              });
            }),
        ),
      );
    }

    let next = 0;

    agent.createConnection = (_options, callback) => {
      const socket = sockets[next++];

      if (!socket || socket.destroyed) {
        callback(new Error('Preallocated socket unavailable'));

        return;
      }

      return socket;
    };

    const preconnectedAt = performance.now();

    await beforeDispatch?.();
    loop.enable();

    const epoch = performance.now();

    onDispatch?.();

    const tasks = [];
    let cursor = 0;

    while (cursor < records.length) {
      const now = performance.now() - epoch;

      while (cursor < records.length && records[cursor].scheduledMs <= now) {
        const record = records[cursor++];

        tasks.push(
          new Promise((resolve) => {
            let settled = false;
            const finish = (outcome) => {
              if (settled) return;

              settled = true;
              record.outcome = outcome;
              resolve();
            };
            const body = JSON.stringify(record.input);
            const request = http.request(
              new URL(`/sales/${saleId}/purchases`, url),
              {
                agent,
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(body),
                },
              },
              (response) => {
                let data = '';

                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                  data += chunk;
                });
                response.on('error', () => finish('response_error'));
                response.on('end', () => {
                  record.completedMs = performance.now() - epoch;
                  record.httpStatus = response.statusCode;

                  try {
                    record.response = JSON.parse(data);
                    finish(
                      [
                        record.response.status,
                        record.response.reason ?? record.response.phase,
                      ]
                        .filter(Boolean)
                        .join(':'),
                    );
                  } catch {
                    finish('invalid_response');
                  }
                });
              },
            );
            const timer = setTimeout(() => {
              record.error = 'Request deadline';
              finish('transport_error');
              request.destroy(new Error('Request deadline'));
            }, timeoutMs);

            request.once('close', () => clearTimeout(timer));
            request.once('finish', () => {
              record.dispatchMs = performance.now() - epoch;
            });
            // Agent queue failures can report the same request on multiple socket closes.
            // Keep the listener until collection ends; finish still accounts for it once.
            request.on('error', (error) => {
              record.error = error.code ?? error.message;
              finish('transport_error');
            });
            request.end(body);
          }),
        );
      }

      if (cursor < records.length) await delay(1);
    }

    await Promise.all(tasks);

    return {
      ...summarize(records, scenario.requests, dispatchWindowMs),
      records,
      elapsedMs: performance.now() - epoch,
      generator: {
        connections,
        preconnectMs: preconnectedAt - started,
        readyWaitMs: epoch - preconnectedAt,
        cpuMicros: process.cpuUsage(cpu),
        resourceUsage: process.resourceUsage(),
        memory: process.memoryUsage(),
        eventLoopDelayMaxMs: loop.max / 1e6,
        bytesWritten: sockets.reduce(
          (sum, socket) => sum + socket.bytesWritten,
          0,
        ),
        bytesRead: sockets.reduce((sum, socket) => sum + socket.bytesRead, 0),
      },
    };
  } catch (error) {
    error.measurement = {
      ...summarize(records, scenario.requests, dispatchWindowMs),
      records,
      generator: {
        connections,
        cpuMicros: process.cpuUsage(cpu),
        resourceUsage: process.resourceUsage(),
        memory: process.memoryUsage(),
      },
    };

    throw error;
  } finally {
    loop.disable();
    agent.destroy();

    for (const socket of sockets) socket.destroy();
  }
}
