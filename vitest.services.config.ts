import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: [`tests/${process.env.TEST_SUITE ?? 'integration'}/**/*.test.ts`], fileParallelism: false, testTimeout: 10000 } });
