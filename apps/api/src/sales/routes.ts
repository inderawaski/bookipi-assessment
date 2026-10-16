import { correlation, type Metrics } from '@flash/operations';
import type { FastifyInstance, FastifyError } from 'fastify';
import { normalizeIdentifier, normalizePurchase, operationalLimits, saleRoutes, saleParamsSchema, purchaseBodySchema, lookupQuerySchema, purchaseResponseSchema, lookupResponseSchema, saleResponseSchema, purchaseHttpStatus, type PurchaseInput, type PurchaseResponse, type OrderState } from '@flash/contracts';
import { listSales, type createDatabase } from '@flash/database';
import { cachedSaleConfigurations, readAdmissionConfiguration, saleKey, type createRedisConnection, type RedisAdmission } from '@flash/redis';

export function registerSaleRoutes(app: FastifyInstance, dependencies: {
  database: ReturnType<typeof createDatabase>;
  redis: ReturnType<typeof createRedisConnection>;
  admission: RedisAdmission;
  probe: () => Promise<void>;
  configurationScope: string;
  webOrigin?: string;
  metrics?: Metrics;
}) {
  const { database, redis, admission, probe, webOrigin } = dependencies;
  app.addHook('onSend', async (request, _reply, payload) => {
    if (request.method === 'POST' && request.routeOptions.url === '/sales/:saleId/purchases' && typeof payload === 'string') {
      const result = JSON.parse(payload) as { status?: string; reason?: string; phase?: string };
      const reasons = ['invalid_input', 'not_found', 'upcoming', 'ended', 'sold_out', 'idempotency_conflict', 'already_placed', 'busy', 'unavailable'];
      const outcome = result.status === 'NOT_ORDERED' ? 'uncertain' : result.status === 'REJECTED' && reasons.includes(result.reason ?? '') ? result.reason :
        result.status === 'PROCESSING' && result.phase === 'confirming' ? 'uncertain' :
        result.status === 'PROCESSING' || result.status === 'SUCCESS' ? 'admitted' : 'other';
      dependencies.metrics?.add(`purchase_${outcome}_total`);
    }
    return payload;
  });
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
  async function sale(id: string) {
    const preloaded = await readAdmissionConfiguration(redis, id);
    if (preloaded) return preloaded;
    const scope = dependencies.configurationScope;
    const load = () => listSales(database);
    const cached = await cachedSaleConfigurations(redis, scope, load);
    const found = cached.find(value => value.id === id);
    // An absent ID is a cache miss too (e.g. DB configuration not initialized yet).
    return found ?? (await cachedSaleConfigurations(redis, scope, load, true)).find(value => value.id === id);
  }
  async function committed(id: string, identifier: string): Promise<OrderState | undefined> {
    const result = await database.query<{ id: string }>('SELECT id FROM "order" WHERE flash_sale_id = $1 AND user_identifier = $2', [id, identifier]);
    return result.rows[0] ? { status: 'SUCCESS', orderId: result.rows[0].id } : undefined;
  }
  async function allocated(id: string, identifier: string): Promise<OrderState> {
    await probe();
    const confirmation = await admission.lookup(id, identifier);
    if (confirmation.status !== 'present') {
      // This is an observation, not proof that a delayed purchase cannot execute later.
      if (confirmation.diagnostic === 'missing_without_absence_proof') return { status: 'NOT_ORDERED' };
      if (await redis.hGet(`${saleKey(id)}:identifiers`, identifier)) return { status: 'NOT_ORDERED', reason: 'confirmation_uncertain' };
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
      const order = await committed(id, identifier);
      if (order) return { status: 'AVAILABLE', order };
      if (!await sale(id)) return reply.code(404).send(rejected('not_found'));
      return { status: 'AVAILABLE', order: await allocated(id, identifier) };
    } catch { return reply.code(503).send(unavailable); }
  });
  app.post<{ Params: { saleId: string }; Body: PurchaseInput }>(saleRoutes.purchase, { schema: { params: saleParamsSchema, body: purchaseBodySchema, response: { default: purchaseResponseSchema } } }, async (request, reply) => {
    let payload;
    try { payload = normalizePurchase(request.params.saleId, request.body); } catch { return reply.code(400).send(rejected('invalid_input')); }
    // Configuration, sale window, stock and restart/fault fences are checked by
    // Redis Lua. PostgreSQL and reconciliation probes stay off the admission path.
    let result: PurchaseResponse = await admission.place(payload.saleId, payload);
    const outcome = result.status === 'NOT_ORDERED' ? 'uncertain' : result.status === 'REJECTED' ? result.reason : result.status === 'PROCESSING' && result.phase === 'confirming' ? 'uncertain' : 'admitted';
    request.log.info({ requestKeyHash: correlation(payload.idempotencyKey), reservationHash: correlation(payload.saleId + ':' + payload.identifier), outcome }, 'Purchase admission');
    // Keep internal command-outcome uncertainty; expose the agreed retryable public state.
    if (result.status === 'PROCESSING' && result.phase === 'confirming') result = { status: 'NOT_ORDERED', reason: 'confirmation_uncertain' };
    if (result.status === 'REJECTED' && result.reason === 'already_placed' && result.existingOrder.status === 'PROCESSING' && result.existingOrder.phase === 'confirming') {
      result = { ...result, existingOrder: { status: 'NOT_ORDERED', reason: 'confirmation_uncertain' } };
    }
    return reply.code(purchaseHttpStatus(result)).send(result);
  });
}
