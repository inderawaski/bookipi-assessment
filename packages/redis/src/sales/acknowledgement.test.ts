import { expect, it, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), safety: vi.fn() }));
vi.mock('../index.js', () => ({ createRedisConnection: mocks.create, assertRedisSafety: mocks.safety }));
import { RedisAdmission } from './acknowledgement.js';
import { confirmationScript } from './state-scripts.js';

function connection() {
  return { isOpen: true, info: vi.fn(async () => 'aof_enabled:1\r\naof_last_write_status:ok\r\n'), connect: vi.fn(async () => {}), destroy: vi.fn(),
    sendCommand: vi.fn(async (args: string[]): Promise<unknown> => {
      if (args[0] === 'WAITAOF' || args[0] === 'WAIT') throw new Error('Admission must not wait for persistence or replication');
      return args[1] === confirmationScript ? ['key', '100', '1-0'] : ['reserved', 'key', '100', '1-0', 'new'];
    }) };
}
beforeEach(() => { vi.clearAllMocks(); mocks.safety.mockResolvedValue(undefined); });
it('acknowledges the reservation after one Lua call without a confirmation write or durability wait', async () => {
  const client = connection(); mocks.create.mockReturnValue(client);
  expect(await new RedisAdmission('redis://unused').place('sale', { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
  expect(client.sendCommand).toHaveBeenCalledTimes(1);
  expect(client.sendCommand.mock.calls[0]?.[0]?.[0]).toBe('EVAL');
  expect(client.sendCommand.mock.calls[0]?.[0]?.[1]).not.toBe(confirmationScript);
  expect(client.destroy).toHaveBeenCalledOnce();
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
it('bounds blocked commands without queuing, times out and releases capacity', async () => {
  const blocked = connection(); blocked.sendCommand.mockImplementation(() => new Promise(() => {})); mocks.create.mockReturnValue(blocked);
  const gate = new RedisAdmission('redis://unused', 1, 20);
  const first = gate.place('sale', { identifier: 'person', idempotencyKey: 'key' });
  expect(await gate.place('sale', { identifier: 'other', idempotencyKey: 'other' })).toEqual({ status: 'REJECTED', reason: 'busy' });
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(await first).toEqual({ status: 'PROCESSING', phase: 'confirming' });
  expect(blocked.destroy).toHaveBeenCalled();
  mocks.create.mockReturnValue(connection()); expect((await gate.lookup('sale', 'person')).status).toBe('present');
});
it('retains persistence configuration and write-health checks before admission', async () => {
  const client = connection(); client.info.mockResolvedValue('aof_enabled:1\r\naof_last_write_status:err\r\n'); mocks.create.mockReturnValue(client);
  expect((await new RedisAdmission('redis://unused').lookup('sale', 'person')).status).toBe('confirming');
  expect(client.sendCommand).not.toHaveBeenCalled();
});
it('refuses injected failpoints outside test mode', () => {
  vi.stubEnv('NODE_ENV', 'production');
  try { expect(() => new RedisAdmission('redis://unused', 1, 100, async () => {})).toThrow('test mode'); }
  finally { vi.unstubAllEnvs(); }
});
