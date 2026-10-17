import { expect, it, vi } from 'vitest';
import { cachedSaleConfigurations } from './configuration-cache.js';

const sale = {
  id: 'sale',
  startsAt: '2030-01-01T00:00:00.000Z',
  endsAt: '2030-01-02T00:00:00.000Z',
  initialStock: 3,
};

it('loads once on a cache miss and reads Redis without PostgreSQL on hits', async () => {
  let raw = '';
  const sendCommand = vi.fn(async (args: string[]) => {
    if (args.length === 5) return ['0', raw];

    raw = args[6]!;

    return 1;
  });
  const load = vi.fn(async () => [sale]);

  expect(
    await cachedSaleConfigurations({ sendCommand }, 'database', load),
  ).toEqual([sale]);
  load.mockRejectedValue(new Error('PostgreSQL unavailable'));
  expect(
    await cachedSaleConfigurations({ sendCommand }, 'database', load),
  ).toEqual([sale]);
  expect(load).toHaveBeenCalledTimes(1);
});

it('retries a DB snapshot invalidated by concurrent sale configuration', async () => {
  const sendCommand = vi
    .fn()
    .mockResolvedValueOnce(['0', ''])
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(['1', ''])
    .mockResolvedValueOnce(1);
  const load = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([sale]);

  expect(
    await cachedSaleConfigurations({ sendCommand }, 'database', load),
  ).toEqual([sale]);
  expect(load).toHaveBeenCalledTimes(2);
});

it('does not hide Redis errors with a database fallback or overwrite inventory', async () => {
  const load = vi.fn(async () => [sale]);
  const sendCommand = vi.fn().mockRejectedValue(new Error('Redis unavailable'));

  await expect(
    cachedSaleConfigurations({ sendCommand }, 'database', load),
  ).rejects.toThrow('Redis unavailable');
  expect(load).not.toHaveBeenCalled();
});

it('fails closed on corrupt metadata without falling back to PostgreSQL', async () => {
  const load = vi.fn(async () => [sale]);
  const sendCommand = vi
    .fn()
    .mockResolvedValue(['0', '{"revision":"0","sales":[{}]}']);

  await expect(
    cachedSaleConfigurations({ sendCommand }, 'database', load),
  ).rejects.toThrow('Invalid configuration cache payload');
  expect(load).not.toHaveBeenCalled();
});
