import Fastify from 'fastify';
import { it, expect } from 'vitest';
import {
  purchaseBodySchema,
  saleParamsSchema,
  lookupQuerySchema,
  purchaseResponseSchema,
  lookupResponseSchema,
  saleResponseSchema,
} from '@flash/contracts';

it('validates shared schemas using Fastify without coercion or silently removing fields', async () => {
  const app = Fastify({
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const schemas = [
    purchaseBodySchema,
    saleParamsSchema,
    lookupQuerySchema,
    purchaseResponseSchema,
    lookupResponseSchema,
    saleResponseSchema,
  ];
  schemas.forEach((body, index) =>
    app.post(`/schema/${index}`, { schema: { body } }, async () => ({
      valid: true,
    })),
  );
  const check = async (index: number, payload: object, code: number) => {
    expect(
      (await app.inject({ method: 'POST', url: `/schema/${index}`, payload }))
        .statusCode,
    ).toBe(code);
  };
  try {
    await check(0, { identifier: 'a@.', idempotencyKey: 'key' }, 200);
    await check(0, { identifier: 42, idempotencyKey: 'key' }, 400);
    await check(
      0,
      { identifier: 'a', idempotencyKey: 'key', quantity: 2 },
      400,
    );
    await check(0, { identifier: 'a', idempotencyKey: '' }, 400);
    await check(0, { identifier: 'a', idempotencyKey: 'key\n' }, 400);
    await check(1, { saleId: 'sale' }, 200);
    await check(2, { identifier: 'a' }, 200);
    await check(3, { status: 'REJECTED', reason: 'already_placed' }, 400);
    await check(
      3,
      {
        status: 'REJECTED',
        reason: 'already_placed',
        existingOrder: { status: 'SUCCESS', orderId: '1' },
      },
      200,
    );
    await check(3, { status: 'PROCESSING', phase: 'confirming' }, 200);
    await check(3, { status: 'REJECTED', reason: 'uncertain' }, 400);
    await check(
      3,
      { status: 'SUCCESS', orderId: '1', attemptId: 'private' },
      400,
    );
    await check(
      4,
      { status: 'AVAILABLE', order: { status: 'NOT_ORDERED' } },
      200,
    );
    await check(4, { status: 'UNAVAILABLE', reason: 'unavailable' }, 200);
    await check(
      4,
      {
        status: 'AVAILABLE',
        order: { status: 'REJECTED', reason: 'unavailable' },
      },
      400,
    );
    const sale = {
      saleId: 'sale',
      startsAt: '2026-10-15T00:00:00Z',
      endsAt: '2026-10-16T00:00:00Z',
      observedAt: '2026-10-15T12:00:00Z',
      status: 'OPEN',
      remainingStock: 1,
    };
    await check(5, sale, 200);
    await check(5, { ...sale, remainingStock: -1 }, 400);
    await check(5, { ...sale, observedAt: 'yesterday' }, 400);
  } finally {
    await app.close();
  }
});
