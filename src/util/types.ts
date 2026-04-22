export type ModuleHealth = 'up' | 'degraded' | 'down' | 'disabled';

export interface ModuleStatus {
  state: ModuleHealth;
  detail?: string;
  lastError?: string;
  since?: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: import('../config.js').Config;
    db: import('../db/index.js').Db;
    requireDeviceToken: import('fastify').preHandlerHookHandler;
  }
  interface FastifyRequest {
    deviceId?: number;
  }
}
