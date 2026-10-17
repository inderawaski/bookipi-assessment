import { expect, it, vi } from 'vitest';
import {
  assertAdmissionConfiguration,
  initializeAdmission,
  saleKey,
} from './configuration.js';
const sale = {
  id: 'arbitrary } / 人',
  startsAt: '2030-01-01T00:00:00Z',
  endsAt: '2030-01-02T00:00:00Z',
  initialStock: 3,
};
it('initializes from the Redis write acknowledgement without a persistence wait', async () => {
  const sendCommand = vi.fn().mockResolvedValue(1);
  await expect(
    initializeAdmission({ sendCommand }, sale),
  ).resolves.toBeUndefined();
  expect(sendCommand).toHaveBeenCalledTimes(1);
  expect(sendCommand.mock.calls[0]?.[0]?.[0]).toBe('EVAL');
});
it('compares immutable fields while accepting depleted stock', async () => {
  const fields = [
    String(Date.parse(sale.startsAt)),
    String(Date.parse(sale.endsAt)),
    '3',
    '0',
  ];
  await expect(
    assertAdmissionConfiguration({ sendCommand: async () => fields }, sale),
  ).resolves.toBeUndefined();
  for (const actual of [
    [null, null, null, null],
    [...fields.slice(0, 3), '4'],
    [...fields.slice(0, 3), '-1'],
    ['1', ...fields.slice(1)],
  ]) {
    await expect(
      assertAdmissionConfiguration({ sendCommand: async () => actual }, sale),
    ).rejects.toThrow('inconsistent');
  }
  expect(saleKey(sale.id)).toMatch(/^sale:\{[0-9a-f]+\}:admission$/);
});
