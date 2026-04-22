import pino, { type Logger } from 'pino';

export function createLogger(level: string): Logger {
  const isProd = process.env['NODE_ENV'] === 'production';
  return pino({
    level,
    ...(isProd
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
          },
        }),
  });
}
