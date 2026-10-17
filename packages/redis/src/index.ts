import { createClient } from 'redis';
export type RedisRole = 'commands' | 'blocking-consumer' | 'admission';
// Each call owns a distinct socket. Never share blocking or admission sockets across operations.
export function createRedisConnection(url: string, role: RedisRole, timeoutMs = 2000) {
  const client = createClient({ url, name: role, disableOfflineQueue: true, commandsQueueMaxLength: 256,
    commandOptions: role === 'commands' ? { timeout: timeoutMs } : undefined,
    socket: { connectTimeout: timeoutMs, reconnectStrategy: false } });
  client.on('error', () => { /* Readiness/operation callers handle failures; do not log credentials. */ });
  return client;
}
export async function assertRedisSafety(client: { configGet: (keys: string[]) => Promise<Record<string, string>> }) {
  const config = await client.configGet(['appendonly', 'appendfsync', 'maxmemory-policy']);
  if (config.appendonly !== 'yes' || config.appendfsync !== 'everysec' || config['maxmemory-policy'] !== 'noeviction') {
    throw new Error('Redis requires appendonly=yes, appendfsync=everysec, maxmemory-policy=noeviction');
  }

}
/** Control-plane check: startup and periodic readiness, never per purchase. */
export async function assertRedisHealth(client: { configGet: (keys: string[]) => Promise<Record<string, string>>; info: (section: string) => Promise<string> }) {
  await assertRedisSafety(client);
  const persistence = await client.info('persistence');
  if (!persistence.includes('aof_enabled:1\r\n') || !persistence.includes('aof_last_write_status:ok\r\n')) throw new Error('AOF persistence unavailable');
}
export { initializeAdmission, assertAdmissionConfiguration, readAdmissionConfiguration, saleKey } from './sales/configuration.js';
export { admitPurchase, admissionKeys, AdmissionUncertainError, type AdmissionResult, type Reservation } from './sales/admission.js';
export { RedisAdmission, type ValidatedReservation, type PersistedAdmission, type Confirmation } from './sales/acknowledgement.js';
export { finishAttempt, claimAttempt, delayAttempt, replayOrder, retryDelay, defaultRetryPolicy, type RetryPolicy } from './sales/retries.js';

export { cachedSaleConfigurations } from './sales/configuration-cache.js';
