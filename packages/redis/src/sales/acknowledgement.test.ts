import { expect, it, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), safety: vi.fn(), pool: vi.fn() }));
vi.mock('../index.js', () => ({ createRedisConnection: mocks.create, assertRedisSafety: mocks.safety }));
vi.mock('redis', async importOriginal => {
  const actual = await importOriginal<typeof import('redis')>();
  return { ...actual, createClientPool: mocks.pool };
});
import { TimeoutError } from 'redis';
import { RedisAdmission } from './acknowledgement.js';
import { confirmationScript } from './state-scripts.js';

function connection() {
  const client = { isOpen: false, isReady: false, info: vi.fn(async () => 'aof_enabled:1\r\naof_last_write_status:ok\r\n'), connect: vi.fn(async () => { client.isOpen = true; client.isReady = true; }), destroy: vi.fn(() => { client.isOpen = false; client.isReady = false; }),
    withAbortSignal: vi.fn(() => client),
    sendCommand: vi.fn(async (args: string[]): Promise<unknown> => {
      if (args[0] === 'WAITAOF' || args[0] === 'WAIT') throw new Error('Admission must not wait for persistence or replication');
      return args[1] === confirmationScript ? ['key', '100', '1-0'] : ['reserved', 'key', '100', '1-0', 'new'];
    }) };
  return client;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.safety.mockResolvedValue(undefined);
  mocks.pool.mockImplementation(() => {
    const client = mocks.create();
    return { on: vi.fn(), connect: () => client.connect(),
      execute: vi.fn((operation: (redis: ReturnType<typeof connection>) => Promise<unknown>) => operation(client)),
      destroy: () => client.destroy() };
  });
});
it('acknowledges the reservation after one Lua call without a confirmation write or durability wait', async () => {
  const client = connection(); mocks.create.mockReturnValue(client);
  expect(await new RedisAdmission('redis://unused').place('sale', { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
  expect(client.sendCommand).toHaveBeenCalledTimes(1);
  expect(client.sendCommand.mock.calls[0]?.[0]?.[0]).toBe('EVAL');
  expect(client.sendCommand.mock.calls[0]?.[0]?.[1]).not.toBe(confirmationScript);
  expect(client.destroy).not.toHaveBeenCalled();
  expect(mocks.safety).not.toHaveBeenCalled();
  expect(client.info).not.toHaveBeenCalled();
});
it('validates lookup and worker identity without waiting for persistence', async () => {
  const client = connection(); mocks.create.mockReturnValue(client);
  const gate = new RedisAdmission('redis://unused');
  expect((await gate.lookup('sale', 'person')).status).toBe('present');
  await expect(gate.confirmForWorker('sale', 'person', 'key', '1-0')).resolves.toMatchObject({ requestKey: 'key' });
  await expect(gate.confirmForWorker('sale', 'person', 'other', '1-0')).rejects.toThrow('unconfirmed');
  expect(client.sendCommand.mock.calls.every(([args]) => args[0] === 'EVAL' && args[1] === confirmationScript)).toBe(true);
});
it.each(['replay', 'duplicate', 'rejected'])('returns acknowledged %s outcomes without another Redis command', async kind => {
  const client = connection(); client.sendCommand.mockResolvedValueOnce(kind === 'rejected' ? ['rejected', 'sold_out'] : kind === 'duplicate' ? ['already_placed', 'key', '100', '1-0'] : ['reserved', 'key', '100', '1-0', 'replay']);
  mocks.create.mockReturnValue(client);
  const processing = { status: 'PROCESSING', phase: 'queued' };
  expect(await new RedisAdmission('redis://unused').place('sale', { identifier: 'person', idempotencyKey: 'key' })).toEqual(kind === 'rejected' ? { status: 'REJECTED', reason: 'sold_out' } : kind === 'duplicate' ? { status: 'REJECTED', reason: 'already_placed', existingOrder: processing } : processing);
  expect(client.sendCommand).toHaveBeenCalledTimes(1);
});
it('keeps a lost Redis reply uncertain rather than claiming acknowledgement', async () => {
  const client = connection(); client.sendCommand.mockRejectedValue(new Error('Disconnected')); mocks.create.mockReturnValue(client);
  expect(await new RedisAdmission('redis://unused').place('sale', { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'confirming' });
});
it('reuses a connection across purchases without config or persistence checks', async () => {
  const client = connection(); mocks.create.mockReturnValue(client);
  const gate = new RedisAdmission('redis://unused');
  await gate.place('sale', { identifier: 'person', idempotencyKey: 'key' });
  await gate.place('sale', { identifier: 'person', idempotencyKey: 'key' });
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(client.connect).toHaveBeenCalledTimes(1);
  expect(mocks.safety).not.toHaveBeenCalled();
  expect(client.info).not.toHaveBeenCalled();
  expect(client.destroy).not.toHaveBeenCalled();
});
it('refuses injected failpoints outside test mode', () => {
  vi.stubEnv('NODE_ENV', 'production');
  try { expect(() => new RedisAdmission('redis://unused', 1, 100, async () => {})).toThrow('test mode'); }
  finally { vi.unstubAllEnvs(); }
});

it('uses the library pool without overriding size or acquisition timeout', async () => {
  const client = connection(); mocks.create.mockReturnValue(client);
  const gate = new RedisAdmission('redis://unused');
  try {
    await gate.connect();
    expect(mocks.pool).toHaveBeenCalledWith(expect.objectContaining({ disableOfflineQueue: true,
      socket: { connectTimeout: 3000, reconnectStrategy: false } }));
    expect(mocks.pool.mock.calls[0]).toHaveLength(1);
    expect(await gate.place('sale', { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
  } finally { gate.close(); }
});

it('returns busy only when the library acquisition expires before executing Lua', async () => {
  const client = connection(); mocks.create.mockReturnValue(client);
  mocks.pool.mockReturnValue({ on: vi.fn(), connect: vi.fn(), destroy: vi.fn(),
    execute: vi.fn().mockRejectedValue(new TimeoutError('Timeout waiting for a client')) });
  const gate = new RedisAdmission('redis://unused');
  try {
    expect(await gate.place('sale', { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'REJECTED', reason: 'busy' });
    expect(client.sendCommand).not.toHaveBeenCalled();
  } finally { gate.close(); }
});

it('keeps an operation timeout uncertain and reconnects before a later operation', async () => {
  const client = connection(); mocks.create.mockReturnValue(client);
  let release!: (reply: unknown) => void;
  client.sendCommand.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const gate = new RedisAdmission('redis://unused', 1, 20);
  try {
    expect(await gate.place('sale', { identifier: 'first', idempotencyKey: 'first' })).toEqual({ status: 'PROCESSING', phase: 'confirming' });
    expect(client.destroy).toHaveBeenCalled();
    release(['reserved', 'first', '100', '1-0', 'new']);
    expect(await gate.place('sale', { identifier: 'next', idempotencyKey: 'next' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(client.connect).toHaveBeenCalledTimes(2);
  } finally { gate.close(); }
});

it('cancels queued callers on shutdown and prevents their later callback from sending Lua', async () => {
  const client = connection(); mocks.create.mockReturnValue(client);
  let execute!: (redis: ReturnType<typeof connection>) => Promise<unknown>, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  mocks.pool.mockReturnValue({ on: vi.fn(), connect: vi.fn(), destroy: vi.fn(),
    execute: vi.fn(callback => { execute = callback; started(); return new Promise(() => {}); }) });
  const gate = new RedisAdmission('redis://unused');
  const waiting = gate.place('sale', { identifier: 'waiting', idempotencyKey: 'waiting' });
  await ready; gate.close();
  expect(await waiting).toEqual({ status: 'PROCESSING', phase: 'confirming' });
  await expect(execute(client)).rejects.toThrow('closed');
  expect(client.sendCommand).not.toHaveBeenCalled();
});
