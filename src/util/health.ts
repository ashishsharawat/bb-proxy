import type { FastifyInstance } from 'fastify';
import type { ModuleStatus } from './types.js';

export async function registerHealth(
  app: FastifyInstance,
  getModuleStatuses: () => Record<string, ModuleStatus>
): Promise<void> {
  app.get('/health', async () => {
    const modules = getModuleStatuses();
    const anyDown = Object.values(modules).some((m) => m.state === 'down');
    return {
      ok: !anyDown,
      uptime: process.uptime(),
      pid: process.pid,
      version: process.env['npm_package_version'] ?? '0.0.0',
      modules,
    };
  });
}
