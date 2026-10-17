import { startService } from './service.js';

try {
  await startService('api');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
}
