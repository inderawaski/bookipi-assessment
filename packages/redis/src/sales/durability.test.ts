import { expect, it, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), safety: vi.fn() }));
vi.mock('../index.js', () => ({ createRedisConnection: mocks.create, assertRedisSafety: mocks.safety }));
import { DurableAdmission } from './durability.js';
import { confirmationScript } from './durability-scripts.js';

function connection(barrier: unknown = [1, 0]) {
  return { isOpen: true, info: vi.fn(async () => 'aof_enabled:1\r\naof_last_write_status:ok\r\n'), connect: vi.fn(async () => {}), destroy: vi.fn(),
    sendCommand: vi.fn(async (args: string[]): Promise<unknown> => {
      if (args[0] === 'WAITAOF') return barrier;
      return args[1] === confirmationScript ? ['key', '100', '1-0'] : ['reserved', 'key', '100', '1-0', 'new'];
    }) };
}
beforeEach(() => { vi.clearAllMocks(); mocks.safety.mockResolvedValue(undefined); });
it('writes and waits on each exclusively owned socket, including identifier lookup', async () => {
  const a = connection(), b = connection();
  mocks.create.mockReturnValueOnce(a).mockReturnValueOnce(b);
  const gate = new DurableAdmission('redis://unused');
  expect(await gate.place('sale', { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
  expect((await gate.lookup('sale', 'person')).status).toBe('durable');
  for (const client of [a, b]) {
    const commands = client.sendCommand.mock.calls.map(call => call[0]);
    expect(commands.at(-2)?.[1]).toBe(confirmationScript);
    expect(commands.at(-1)).toEqual(['WAITAOF', '1', '0', '3000']);
    expect(client.destroy).toHaveBeenCalledOnce();
  }
});
it.each([[0, 0], [0, 1], null, [true, 0]])('never acknowledges an unconfirmed local count: %j', async reply => {
  mocks.create.mockImplementation(() => connection(reply));
  const gate = new DurableAdmission('redis://unused');
  expect(await gate.place('sale', { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'confirming' });
  await expect(gate.confirmForWorker('sale', 'person', 'key', '1-0')).rejects.toThrow('unconfirmed');
});
it.each(['lua', 'checkpoint', 'barrier'])('keeps confirming after connection loss at %s', async stage => {
  const client = connection();
  client.sendCommand.mockImplementation(async args => {
    if ((stage === 'lua' && args[1] !== confirmationScript) || (stage === 'checkpoint' && args[1] === confirmationScript) || (stage === 'barrier' && args[0] === 'WAITAOF')) throw new Error('Disconnected');
    return args[1] === confirmationScript ? ['key', '100', '1-0'] : ['reserved', 'key', '100', '1-0', 'new'];
  });
  mocks.create.mockReturnValue(client);
  expect(await new DurableAdmission('redis://unused').place('sale', { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'confirming' });
});
it('bounds blocked sockets without queuing, times out and releases capacity', async () => {
  const blocked = connection();
  blocked.sendCommand.mockImplementation(() => new Promise(() => {}));
  mocks.create.mockReturnValue(blocked);
  const gate = new DurableAdmission('redis://unused', 1, 20);
  const first = gate.place('sale', { identifier: 'person', idempotencyKey: 'key' });
  expect(await gate.place('sale', { identifier: 'other', idempotencyKey: 'other' })).toEqual({ status: 'REJECTED', reason: 'busy' });
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(await first).toEqual({ status: 'PROCESSING', phase: 'confirming' });
  expect(blocked.destroy).toHaveBeenCalled();
  mocks.create.mockReturnValue(connection());
  expect((await gate.lookup('sale', 'person')).status).toBe('durable');
});
it('refuses persistence failure before issuing admission writes', async () => {
  const client = connection();
  mocks.create.mockReturnValue(client);
  mocks.safety.mockRejectedValue(new Error('Persistence unavailable'));
  expect(await new DurableAdmission('redis://unused').place('sale', { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'confirming' });
  expect(client.sendCommand).not.toHaveBeenCalled();
});
it.each(['replay', 'duplicate'])('requires a barrier before promoting a %s', async kind => {
  const client = connection([0, 0]);
  client.sendCommand.mockResolvedValueOnce(kind === 'replay' ? ['reserved', 'key', '100', '1-0', 'replay'] : ['already_placed', 'key', '100', '1-0']);
  mocks.create.mockReturnValue(client);
  expect(await new DurableAdmission('redis://unused').place('sale', { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'confirming' });
  expect(client.sendCommand.mock.calls.at(-1)?.[0]?.[0]).toBe('WAITAOF');
});
it('keeps a second socket independent while the first barrier is blocked', async () => {
  const blocked = connection(), free = connection();
  blocked.sendCommand.mockImplementation(async args => args[0] === 'WAITAOF' ? new Promise(() => {}) : args[1] === confirmationScript ? ['key', '100', '1-0'] : ['reserved', 'key', '100', '1-0', 'new']);
  mocks.create.mockReturnValueOnce(blocked).mockReturnValueOnce(free);
  const gate = new DurableAdmission('redis://unused', 2, 50);
  const first = gate.place('sale', { identifier: 'person', idempotencyKey: 'key' });
  expect((await gate.lookup('sale', 'person')).status).toBe('durable');
  expect(await first).toEqual({ status: 'PROCESSING', phase: 'confirming' });
});
it('refuses AOF write errors even with safe persistence configuration', async () => {
  const client = connection();
  client.info.mockResolvedValue('aof_enabled:1\r\naof_last_write_status:err\r\n');
  mocks.create.mockReturnValue(client);
  expect((await new DurableAdmission('redis://unused').lookup('sale', 'person')).status).toBe('confirming');
  expect(client.sendCommand).not.toHaveBeenCalled();
});
