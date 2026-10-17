import { setTimeout as delay } from 'node:timers/promises';

/** Bounded setup only: no purchases, generator timestamps or sale times change. */
export async function waitForReadiness(
  endpoints,
  { timeoutMs = 10000, retryMs = 100, onAttempt = () => {} } = {},
) {
  const deadline = performance.now() + timeoutMs;

  await Promise.all(
    endpoints.map(async (endpoint) => {
      let last = 'not checked';

      while (performance.now() < deadline) {
        const attempt = { endpoint, at: new Date().toISOString() };

        try {
          const response = await fetch(`${endpoint}/health/ready`, {
            signal: AbortSignal.timeout(
              Math.max(1, Math.ceil(deadline - performance.now())),
            ),
          });

          attempt.httpStatus = response.status;

          const body = await response.json();

          attempt.status = body.status;
          last = `HTTP ${response.status}, status ${body.status}`;
          onAttempt(attempt);

          if (response.ok && body.status === 'ready') return;
        } catch (error) {
          attempt.error = String(error);
          last = attempt.error;
          onAttempt(attempt);
        }

        await delay(
          Math.max(0, Math.min(retryMs, deadline - performance.now())),
        );
      }

      throw new Error(
        `Service readiness deadline exceeded: ${endpoint} (${last})`,
      );
    }),
  );
}
