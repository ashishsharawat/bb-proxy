import type { FastifyInstance } from 'fastify';
import { registerDeviceTokenAuth } from './deviceToken.js';

export async function registerAuth(app: FastifyInstance): Promise<void> {
  await registerDeviceTokenAuth(app);

  app.post('/auth/verify', { preHandler: app.requireDeviceToken }, async (req) => {
    return { ok: true, deviceId: req.deviceId };
  });
}
