import { expect, it, vi } from 'vitest';
import { singleFlightProbe } from './readiness.js';

it('shares overlapping probes without caching later readiness checks', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const check = vi.fn(async () => {
    entered();
    await pending;
  });
  const probe = singleFlightProbe(check);
  const first = probe(),
    second = probe();
  expect(first).toBe(second);
  await started;
  expect(check).toHaveBeenCalledOnce();
  release();
  await Promise.all([first, second]);
  await probe();
  expect(check).toHaveBeenCalledTimes(2);
});

it('shares failures and checks again after dependencies recover', async () => {
  const check = vi.fn(async (): Promise<void> => {
    throw new Error('Dependency unavailable');
  });
  const probe = singleFlightProbe(check);
  const results = await Promise.allSettled([probe(), probe()]);
  expect(results.map((result) => result.status)).toEqual([
    'rejected',
    'rejected',
  ]);
  expect(check).toHaveBeenCalledOnce();
  check.mockResolvedValue(undefined);
  await expect(probe()).resolves.toBeUndefined();
  expect(check).toHaveBeenCalledTimes(2);
});
