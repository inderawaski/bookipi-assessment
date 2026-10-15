import { expect, it } from 'vitest';
import { defaultRetryPolicy, retryDelay } from './retries.js';
it('bounds exponential jitter, including very large attempts', () => {
  expect(retryDelay(defaultRetryPolicy, 1, 0)).toBe(500);
  expect(retryDelay(defaultRetryPolicy, 2, 1)).toBe(2000);
  expect(retryDelay(defaultRetryPolicy, 100, 0)).toBe(30000);
  expect(retryDelay(defaultRetryPolicy, 100, 1)).toBe(60000);
});
