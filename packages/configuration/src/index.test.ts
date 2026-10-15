import { describe, it, expect } from 'vitest';
import { parseConfiguration } from './index.js';
const valid = { DATABASE_URL: 'postgres://local:local@localhost/flash', REDIS_URL: 'redis://localhost:6379' };
describe('configuration', () => {
  it('uses distinct API and worker defaults', () => {
    expect(parseConfiguration(valid, 'api').port).toBe(3000);
    expect(parseConfiguration(valid, 'worker').port).toBe(3001);
  });
  for (const key of ['DATABASE_URL', 'REDIS_URL']) it(`rejects missing ${key}`, () => {
    expect(() => parseConfiguration({ ...valid, [key]: undefined }, 'api')).toThrow(`Missing ${key}`);
  });
  for (const value of ['', '0', '-1', '1.5', '3000oops', '65536']) it(`rejects invalid port ${value}`, () => {
    expect(() => parseConfiguration({ ...valid, API_PORT: value }, 'api')).toThrow('Invalid API_PORT');
  });
  it('rejects unsupported URLs without disclosing credentials', () => {
    expect(() => parseConfiguration({ ...valid, DATABASE_URL: 'https://secret:password@localhost/db' }, 'api')).toThrow('Invalid DATABASE_URL: unsupported URL');
  });
  it('bounds pool and timeout settings', () => {
    expect(() => parseConfiguration({ ...valid, DATABASE_POOL_SIZE: '101' }, 'api')).toThrow();
    expect(() => parseConfiguration({ ...valid, DEPENDENCY_TIMEOUT_MS: '0' }, 'api')).toThrow();
  });
});
it('validates an optional exact web origin', () => {
  expect(parseConfiguration({ ...valid, WEB_ORIGIN: 'http://localhost:8080' }, 'api').webOrigin).toBe('http://localhost:8080');
  for (const WEB_ORIGIN of ['*', 'null', 'https://example.com/path', 'https://user:password@example.com', 'https://example.com/']) {
    expect(() => parseConfiguration({ ...valid, WEB_ORIGIN }, 'api')).toThrow();
  }
});
