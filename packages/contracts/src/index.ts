export interface Health {
  status: 'running' | 'ready' | 'unavailable';
}
export * from './sales/identity.js';
export * from './sales/state.js';
export * from './sales/schemas.js';
