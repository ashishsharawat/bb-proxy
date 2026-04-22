import 'dotenv/config';
import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : fallback;
}

function optInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v || v.trim() === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${name} must be an integer, got "${v}"`);
  }
  return n;
}

function flag(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  host: string;
  bbPlainHttpPort: number | null;
  publicBaseUrl: string;
  adminPassword: string;
  dataDir: string;
  logLevel: string;
  spotify: {
    clientId: string | null;
    clientSecret: string | null;
    redirectUri: string;
  };
  modules: {
    browser: boolean;
    spotify: boolean;
    whatsapp: boolean;
  };
}

export function loadConfig(): Config {
  const nodeEnv = (opt('NODE_ENV', 'development') as Config['nodeEnv']);
  const dataDir = path.resolve(opt('DATA_DIR', './data'));
  const port = optInt('PORT', 8080);
  const host = opt('HOST', '0.0.0.0');

  const bbPortRaw = process.env['BB_PLAIN_HTTP_PORT'];
  const bbPlainHttpPort = bbPortRaw && bbPortRaw.trim() !== ''
    ? Number.parseInt(bbPortRaw, 10)
    : null;
  if (bbPlainHttpPort !== null && !Number.isFinite(bbPlainHttpPort)) {
    throw new Error(`BB_PLAIN_HTTP_PORT must be an integer or empty`);
  }

  return {
    nodeEnv,
    port,
    host,
    bbPlainHttpPort,
    publicBaseUrl: req('PUBLIC_BASE_URL'),
    adminPassword: req('ADMIN_PASSWORD'),
    dataDir,
    logLevel: opt('LOG_LEVEL', 'info'),
    spotify: {
      clientId: process.env['SPOTIFY_CLIENT_ID'] ?? null,
      clientSecret: process.env['SPOTIFY_CLIENT_SECRET'] ?? null,
      redirectUri: opt('SPOTIFY_REDIRECT_URI', `${opt('PUBLIC_BASE_URL', 'http://localhost:8080')}/admin/spotify/callback`),
    },
    modules: {
      browser: flag('ENABLE_BROWSER', true),
      spotify: flag('ENABLE_SPOTIFY', true),
      whatsapp: flag('ENABLE_WHATSAPP', true),
    },
  };
}
