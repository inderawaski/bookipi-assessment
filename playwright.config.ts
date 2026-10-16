import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/browser', outputDir: './test-results/browser', use: { baseURL: 'http://127.0.0.1:4173' }, webServer: { command: 'pnpm --filter @flash/web dev --port 4173 --strictPort', url: 'http://127.0.0.1:4173', reuseExistingServer: false } });
