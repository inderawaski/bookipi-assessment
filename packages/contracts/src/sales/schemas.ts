// JSON Schema shared by Fastify route validation/serialization and client tooling.
const text = { type: 'string', minLength: 1, maxLength: 1024 } as const;

function object(properties: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  } as const;
}

const identifierInput = {
  type: 'string',
  minLength: 1,
  maxLength: 16384,
} as const;
const enumeration = (...values: string[]) => ({ type: 'string', enum: values });
const rejected = (...reasons: string[]) =>
  object({ status: { const: 'REJECTED' }, reason: enumeration(...reasons) });
const processing = object({
  status: { const: 'PROCESSING' },
  phase: enumeration('confirming', 'queued', 'delayed'),
});
const success = object({ status: { const: 'SUCCESS' }, orderId: text });
const unconfirmed = object({
  status: { const: 'NOT_ORDERED' },
  reason: { const: 'confirmation_uncertain' },
});
export const allocatedOrderSchema = { anyOf: [processing, success] };
export const orderStateSchema = {
  anyOf: [
    object({ status: { const: 'NOT_ORDERED' } }),
    unconfirmed,
    processing,
    success,
  ],
};
export const saleParamsSchema = object({ saleId: identifierInput });
export const lookupQuerySchema = object({ identifier: identifierInput });
export const purchaseBodySchema = object({
  identifier: identifierInput,
  idempotencyKey: {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    not: { pattern: '[^!-~]' },
  },
});
export const purchaseResponseSchema = {
  anyOf: [
    unconfirmed,
    processing,
    success,
    rejected(
      'upcoming',
      'ended',
      'sold_out',
      'invalid_input',
      'idempotency_conflict',
      'busy',
      'unavailable',
      'not_found',
    ),
    object({
      status: { const: 'REJECTED' },
      reason: { const: 'already_placed' },
      existingOrder: { anyOf: [unconfirmed, processing, success] },
    }),
  ],
};
const unavailable = object({
  status: { const: 'UNAVAILABLE' },
  reason: { const: 'unavailable' },
});
export const lookupResponseSchema = {
  anyOf: [
    object({ status: { const: 'AVAILABLE' }, order: orderStateSchema }),
    unavailable,
    rejected('invalid_input', 'not_found'),
  ],
};
const timestamp = { type: 'string', format: 'date-time' };
export const saleResponseSchema = {
  anyOf: [
    object({
      saleId: text,
      startsAt: timestamp,
      endsAt: timestamp,
      observedAt: timestamp,
      status: enumeration('UPCOMING', 'OPEN', 'ENDED', 'SOLD_OUT'),
      remainingStock: { type: 'integer', minimum: 0, maximum: 2147483647 },
    }),
    unavailable,
    rejected('invalid_input', 'not_found'),
  ],
};
export const saleRoutes = {
  status: '/sales/:saleId',
  purchase: '/sales/:saleId/purchases',
  order: '/sales/:saleId/order',
} as const;
