import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { persistOrder } from './orders.js';

it('refuses injected failpoints in production before accessing dependencies', async () => {
  vi.stubEnv('NODE_ENV', 'production');

  try {
    const hook = vi.fn(async () => {});

    await expect(
      persistOrder(
        {} as Pool,
        { saleId: 'sale', identifier: 'person', admittedAtMs: 1 },
        hook,
      ),
    ).rejects.toThrow('test mode');
    expect(hook).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});
