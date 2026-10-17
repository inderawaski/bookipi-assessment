import { expect, it } from 'vitest';
import { admitPurchase, AdmissionUncertainError } from './admission.js';

it('rejects invalid input before Redis and treats transport/malformed replies as uncertainty', async () => {
  let calls = 0;
  const redis = {
    sendCommand: async () => {
      calls++;
      throw new Error('timeout');
    },
  };
  await expect(
    admitPurchase(redis, 'sale', { identifier: ' ', idempotencyKey: 'key' }),
  ).rejects.toThrow('Identifier');
  expect(calls).toBe(0);
  await expect(
    admitPurchase(redis, 'sale', {
      identifier: 'person',
      idempotencyKey: 'key',
    }),
  ).rejects.toBeInstanceOf(AdmissionUncertainError);
  for (const result of [
    null,
    [],
    ['reserved', 'key', 'garbage', '1-0', 'new'],
    ['rejected', 'unknown'],
  ]) {
    await expect(
      admitPurchase({ sendCommand: async () => result }, 'sale', {
        identifier: 'person',
        idempotencyKey: 'key',
      }),
    ).rejects.toBeInstanceOf(AdmissionUncertainError);
  }
});
