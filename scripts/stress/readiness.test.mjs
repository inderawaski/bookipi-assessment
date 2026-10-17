import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { waitForReadiness } from './readiness.mjs';

async function server(t, handler) {
  const app = createServer(handler);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
  });
  return `http://127.0.0.1:${app.address().port}`;
}

test('waits for every replica and records transient unavailable responses', async (t) => {
  let calls = 0;
  const slow = await server(t, (_request, response) => {
    calls++;
    response.writeHead(calls === 1 ? 503 : 200, {
      'content-type': 'application/json',
    });
    response.end(
      JSON.stringify({ status: calls === 1 ? 'unavailable' : 'ready' }),
    );
  });
  const ready = await server(t, (_request, response) =>
    response.end('{"status":"ready"}'),
  );
  const attempts = [];
  await waitForReadiness([slow, ready], {
    timeoutMs: 1000,
    retryMs: 5,
    onAttempt: (attempt) => attempts.push(attempt),
  });
  assert.equal(calls, 2);
  assert.deepEqual(
    attempts
      .filter((attempt) => attempt.endpoint === slow)
      .map((attempt) => attempt.httpStatus),
    [503, 200],
  );
  assert(
    attempts.some(
      (attempt) => attempt.endpoint === ready && attempt.status === 'ready',
    ),
  );
});

for (const [code, status] of [
  [503, 'unavailable'],
  [200, 'running'],
]) {
  test(`rejects persistent HTTP ${code}/${status} with endpoint diagnostics within the setup deadline`, async (t) => {
    const endpoint = await server(t, (_request, response) => {
      response.writeHead(code);
      response.end(JSON.stringify({ status }));
    });
    const started = performance.now();
    await assert.rejects(
      waitForReadiness([endpoint], { timeoutMs: 80, retryMs: 5 }),
      (error) =>
        error.message.includes('Service readiness deadline exceeded') &&
        error.message.includes(endpoint),
    );
    assert(performance.now() - started < 1000);
  });
}

test('bounds a readiness response that never arrives', async (t) => {
  const endpoint = await server(t, () => {});
  await assert.rejects(
    waitForReadiness([endpoint], { timeoutMs: 80 }),
    /Service readiness deadline exceeded/,
  );
});
