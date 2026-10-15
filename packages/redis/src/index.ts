import { createClient } from 'redis';
export type RedisRole = 'commands' | 'blocking-consumer' | 'durability';
// Each call owns a distinct socket. Never share blocking or durability sockets across operations.
export function createRedisConnection(url: string, role: RedisRole, timeoutMs = 2000) {
  const client = createClient({ url, name: role, disableOfflineQueue: true,
    commandOptions: role === 'commands' ? { timeout: timeoutMs } : undefined,
    socket: { connectTimeout: timeoutMs, reconnectStrategy: false } });
  client.on('error', () => { /* Readiness/operation callers handle failures; do not log credentials. */ });
  return client;
}
export async function assertRedisSafety(client: { configGet: (keys: string[]) => Promise<Record<string, string>>; sendCommand: (args: string[]) => Promise<unknown> }) {
  const config = await client.configGet(['appendonly', 'appendfsync', 'maxmemory-policy']);
  if (config.appendonly !== 'yes' || config.appendfsync !== 'everysec' || config['maxmemory-policy'] !== 'noeviction') {
    throw new Error('Redis requires appendonly=yes, appendfsync=everysec, maxmemory-policy=noeviction');
  }
  const commands = await client.sendCommand(['COMMAND', 'INFO', 'WAITAOF']);
  if (!Array.isArray(commands) || !commands[0]) throw new Error('Redis must support WAITAOF (7.2+)');
}
export { initializeAdmission, assertAdmissionConfiguration, saleKey } from './sales/configuration.js';
export { admitPurchase, admissionKeys, AdmissionUncertainError, type AdmissionResult, type Reservation } from './sales/admission.js';
export { DurableAdmission, type DurableReservation, type PersistedAdmission, type Confirmation } from './sales/durability.js';
