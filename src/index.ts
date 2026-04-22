import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyBasicAuth from '@fastify/basic-auth';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from './config.js';
import { createLogger } from './util/logger.js';
import { openDb } from './db/index.js';
import { registerAuth } from './auth/index.js';
import { registerHealth } from './util/health.js';
import { registerAdminRoutes } from './admin/routes.js';
import { BrowserModule } from './browser/module.js';
import { SpotifyModule } from './spotify/module.js';
import { WhatsAppModule } from './whatsapp/module.js';
import type { ModuleStatus } from './util/types.js';

async function buildServer(): Promise<{ app: FastifyInstance; cleanup: () => Promise<void> }> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  fs.mkdirSync(config.dataDir, { recursive: true });

  const db = openDb(path.join(config.dataDir, 'bb-proxy.sqlite'));

  // Pass logger *options* (not the pino instance) so Fastify's generic type
  // stays at FastifyBaseLogger. We keep a separate pino `logger` for modules
  // because they're typed against pino's Logger and use .child() features.
  const isProd = process.env['NODE_ENV'] === 'production';
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(isProd
        ? {}
        : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } } }),
    },
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
  });

  // Core plugins
  await app.register(fastifyCookie);
  await app.register(fastifyFormbody);
  await app.register(fastifyBasicAuth, {
    validate: async (username, password) => {
      if (username !== 'admin' || password !== config.adminPassword) {
        throw new Error('Bad credentials');
      }
    },
    authenticate: { realm: 'bb-proxy-admin' },
  });

  // Shared context decorators
  app.decorate('config', config);
  app.decorate('db', db);

  // Auth, health, admin
  await registerAuth(app);
  await registerHealth(app, () => moduleStatuses());
  await registerAdminRoutes(app);

  // Modules (each owns its supervisor, route registration, and cleanup)
  const modules: Array<{ name: string; mod: { status: () => ModuleStatus; stop: () => Promise<void> } }> = [];

  if (config.modules.browser) {
    const m = new BrowserModule(app, config, logger.child({ module: 'browser' }));
    await m.start();
    modules.push({ name: 'browser', mod: m });
  }
  if (config.modules.whatsapp) {
    const m = new WhatsAppModule(app, config, logger.child({ module: 'whatsapp' }));
    await m.start();
    modules.push({ name: 'whatsapp', mod: m });
  }
  if (config.modules.spotify) {
    const m = new SpotifyModule(app, config, logger.child({ module: 'spotify' }));
    await m.start();
    modules.push({ name: 'spotify', mod: m });
  }

  function moduleStatuses(): Record<string, ModuleStatus> {
    const out: Record<string, ModuleStatus> = {};
    for (const { name, mod } of modules) out[name] = mod.status();
    return out;
  }

  const cleanup = async (): Promise<void> => {
    logger.info('shutting down…');
    for (const { name, mod } of modules) {
      try {
        await mod.stop();
      } catch (err) {
        logger.error({ err, module: name }, 'error during module stop');
      }
    }
    db.close();
  };

  return { app, cleanup };
}

async function main(): Promise<void> {
  const { app, cleanup } = await buildServer();
  const config = (app as unknown as { config: ReturnType<typeof loadConfig> }).config;

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutdown signal received');
    try {
      await app.close();
      await cleanup();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: config.port, host: config.host });
    if (config.bbPlainHttpPort && config.bbPlainHttpPort !== config.port) {
      app.log.warn(
        { bbPort: config.bbPlainHttpPort },
        'BB_PLAIN_HTTP_PORT set — note: Fastify listens on a single port. For a second plain-HTTP listener, use a reverse proxy (Coolify/Traefik) to expose the same service on both ports, or run two containers behind one image.'
      );
    }
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    await cleanup();
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal error in main():', err);
  process.exit(1);
});
