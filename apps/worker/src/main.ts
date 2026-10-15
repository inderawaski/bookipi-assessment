import { startService } from './service.js';
try { await startService('worker'); }
catch (error) { console.error(error instanceof Error ? error.message : 'Startup failed'); process.exitCode = 1; }
