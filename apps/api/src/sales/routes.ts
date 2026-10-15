import type { FastifyInstance, FastifyError } from 'fastify';
import { normalizeIdentifier, normalizePurchase, operationalLimits, saleRoutes, saleParamsSchema, purchaseBodySchema, lookupQuerySchema, purchaseResponseSchema, lookupResponseSchema, saleResponseSchema, purchaseHttpStatus, type PurchaseInput, type PurchaseResponse, type OrderState } from '@flash/contracts';
import { listSales, type createDatabase } from '@flash/database';
import { saleKey, type createRedisConnection, type DurableAdmission } from '@flash/redis';

export function registerSaleRoutes(app: FastifyInstance, dependencies: {
  database: ReturnType<typeof createDatabase>;
  redis: ReturnType<typeof createRedisConnection>;
  admission: DurableAdmission;
  probe: () => Promise<void>;
  webOrigin?: string;
}) {
  const { database, redis, admission, probe, webOrigin } = dependencies;
  app.addHook('onRequest', async (request, reply) => {
    if (Buffer.byteLength(request.raw.url ?? '') > operationalLimits.requestTargetBytes) return reply.code(414).send({ status: 'REJECTED', reason: 'invalid_input' });
    if (webOrigin && request.headers.origin === webOrigin) {
      reply.header('Access-Control-Allow-Origin', webOrigin).header('Vary', 'Origin');
      if (request.method === 'OPTIONS') return reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS').header('Access-Control-Allow-Headers', 'Content-Type').code(204).send();
    }
  });
  app.options('/sales/*', async (_request, reply) => reply.code(204).send());
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as FastifyError;
    const code = failure.statusCode === 413 ? 413 : failure.statusCode === 400 || failure.validation ? 400 : 503;
    return reply.code(code).send({ status: 'REJECTED', reason: code === 503 ? 'unavailable' : 'invalid_input' });
  });
  const unavailable = { status: 'UNAVAILABLE', reason: 'unavailable' } as const;
  const rejected = (reason: 'invalid_input' | 'not_found') => ({ status: 'REJECTED', reason } as const);
  async function sale(id: string) { return (await listSales(database)).find(value => value.id === id); }
  async function committed(id: string, identifier: string): Promise<OrderState | undefined> {
    const result = await database.query<{ id: string }>('SELECT id FROM "order" WHERE flash_sale_id = $1 AND user_identifier = $2', [id, identifier]);
    return result.rows[0] ? { status: 'SUCCESS', orderId: result.rows[0].id } : undefined;
  }
  async function allocated(id: string, identifier: string): Promise<OrderState> {
    const order = await committed(id, identifier);
    if (order) return order;
    await probe();
    const confirmation = await admission.lookup(id, identifier);
    if (confirmation.status !== 'durable') {
      // DB absence plus successful reconciliation and the confirmation script's current-run fence
      // establish absence here. Allocations are retained even after persistence.
      if (confirmation.diagnostic === 'missing_without_absence_proof') return { status: 'NOT_ORDERED' };
      if (await redis.hGet(`${saleKey(id)}:identifiers`, identifier)) return { status: 'PROCESSING', phase: 'confirming' };
      throw new Error('Lookup unavailable');
    }
    const retry = await redis.hGet(`${saleKey(id)}:retries`, confirmation.reservation.streamId);
    const quarantined = await redis.hExists(`${saleKey(id)}:quarantine`, confirmation.reservation.streamId);
    return { status: 'PROCESSING', phase: retry || quarantined ? 'delayed' : 'queued' };
  }
  app.get<{ Params: { saleId: string } }>(saleRoutes.status, { schema: { params: saleParamsSchema, response: { default: saleResponseSchema } } }, async (request, reply) => {
    let id: string;
    try { id = normalizeIdentifier(request.params.saleId); } catch { return reply.code(400).send(rejected('invalid_input')); }
    try {
      const config = await sale(id);
      if (!config) return reply.code(404).send(rejected('not_found'));
      await probe();
      const stock = await redis.hGet(saleKey(id), 'remaining_stock');
      const remainingStock = stock === null ? NaN : Number(stock);
      if (!Number.isInteger(remainingStock) || remainingStock < 0 || remainingStock > config.initialStock) throw new Error('Invalid stock');
      const now = Date.now();
      return { saleId: id, startsAt: config.startsAt, endsAt: config.endsAt, observedAt: new Date(now).toISOString(), remainingStock,
        status: now < Date.parse(config.startsAt) ? 'UPCOMING' : now >= Date.parse(config.endsAt) ? 'ENDED' : remainingStock === 0 ? 'SOLD_OUT' : 'OPEN' };
    } catch { return reply.code(503).send(unavailable); }
  });
  app.get<{ Params: { saleId: string }; Querystring: { identifier: string } }>(saleRoutes.order, { schema: { params: saleParamsSchema, querystring: lookupQuerySchema, response: { default: lookupResponseSchema } } }, async (request, reply) => {
    let id: string, identifier: string;
    try { id = normalizeIdentifier(request.params.saleId); identifier = normalizeIdentifier(request.query.identifier); } catch { return reply.code(400).send(rejected('invalid_input')); }
    try {
      if (!await sale(id)) return reply.code(404).send(rejected('not_found'));
      return { status: 'AVAILABLE', order: await allocated(id, identifier) };
    } catch { return reply.code(503).send(unavailable); }
  });
  app.post<{ Params: { saleId: string }; Body: PurchaseInput }>(saleRoutes.purchase, { schema: { params: saleParamsSchema, body: purchaseBodySchema, response: { default: purchaseResponseSchema } } }, async (request, reply) => {
    let payload;
    try { payload = normalizePurchase(request.params.saleId, request.body); } catch { return reply.code(400).send(rejected('invalid_input')); }
    try {
      if (!await sale(payload.saleId)) return reply.code(404).send(rejected('not_found'));
      await probe();
    } catch { return reply.code(503).send({ status: 'REJECTED', reason: 'unavailable' }); }
    let result: PurchaseResponse = await admission.place(payload.saleId, payload);
    if (result.status === 'PROCESSING' || (result.status === 'REJECTED' && result.reason === 'already_placed')) {
      try {
        const order = await allocated(payload.saleId, payload.identifier);
        if (order.status !== 'NOT_ORDERED') result = result.status === 'REJECTED' ? { ...result, existingOrder: order } : order;
      } catch { /* Preserve admission evidence when subsequent reads fail. */ }
    }
    return reply.code(purchaseHttpStatus(result)).send(result);
  });
}
