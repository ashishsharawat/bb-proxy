import type { FastifyInstance } from 'fastify';
import { listDevices, mintDevice, revokeDevice } from '../auth/deviceToken.js';
import { renderPage, escape } from './render.js';
import type { ModuleStatus } from '../util/types.js';

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function formatDate(ts: number | null): string {
  if (ts === null) return '—';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const basicAuth = { onRequest: app.basicAuth };

  app.get('/admin', basicAuth, async (_req, reply) => {
    // Gather module statuses by calling /health's getter indirectly.
    // We don't have a direct handle here; the health endpoint already exposes
    // it, so we reconstruct a compact view of the dashboard by invoking the
    // handler via app.inject would be overkill. Instead, we expose a minimal
    // per-module placeholder. Real module statuses surface via /health.
    // (Admin dashboard can call /health via fetch in a future HTMX pass.)
    const modulesPlaceholder: Record<string, ModuleStatus> = {
      browser:  { state: 'disabled', detail: 'see /health', since: Date.now() },
      whatsapp: { state: 'disabled', detail: 'see /health', since: Date.now() },
      spotify:  { state: 'disabled', detail: 'see /health', since: Date.now() },
    };

    const devices = listDevices(app.db);
    const devicesHtml = devices.length === 0
      ? '<p class="muted">No devices yet. Mint a token below and type it into the BB app.</p>'
      : `<table><thead><tr><th>ID</th><th>Label</th><th>Created</th><th>Last seen</th><th></th></tr></thead><tbody>${
          devices.map((d) => `
            <tr>
              <td>${d.id}</td>
              <td>${escape(d.label ?? '')}</td>
              <td>${formatDate(d.createdAt)}</td>
              <td>${formatDate(d.lastSeenAt)}</td>
              <td><form method="POST" action="/admin/devices/${d.id}/revoke" onsubmit="return confirm('Revoke this device?')"><button class="btn-danger" type="submit">Revoke</button></form></td>
            </tr>`).join('')
        }</tbody></table>`;

    const newToken = (_req.query as { minted?: string } | undefined)?.minted;
    const banner = newToken
      ? `<p style="background:#d4edda;padding:12px;border-radius:6px;margin-top:12px;"><strong>New device token:</strong> <code>${escape(newToken)}</code> — copy it now, it won't be shown again.</p>`
      : '';

    const moduleRows = Object.entries(modulesPlaceholder).map(([name, s]) => `
      <tr>
        <td><strong>${escape(name)}</strong></td>
        <td><span class="pill ${s.state}">${s.state}</span></td>
        <td>${escape(s.detail ?? '')}</td>
      </tr>`).join('');

    const spotifyStatus = app.config.spotify.clientId
      ? '<p><a class="btn" href="/admin/spotify/login">Login to Spotify</a></p>'
      : '<p class="muted">Set <code>SPOTIFY_CLIENT_ID</code> and <code>SPOTIFY_CLIENT_SECRET</code> in env to enable Spotify.</p>';

    const html = renderPage('Dashboard', 'dashboard.html', {
      MODULE_ROWS: moduleRows,
      DEVICE_ROWS: devicesHtml,
      NEW_TOKEN_BANNER: banner,
      SPOTIFY_STATUS: spotifyStatus,
      VERSION: escape(process.env['npm_package_version'] ?? '0.0.0'),
      NODE_VERSION: escape(process.version),
      UPTIME: escape(formatUptime(process.uptime())),
    });
    void reply.type('text/html').send(html);
  });

  app.post('/admin/devices', basicAuth, async (req, reply) => {
    const body = req.body as { label?: string } | undefined;
    const label = body?.label?.trim() || null;
    const { rawToken } = mintDevice(app.db, label);
    void reply.redirect(`/admin?minted=${encodeURIComponent(rawToken)}`);
  });

  app.post('/admin/devices/:id/revoke', basicAuth, async (req, reply) => {
    const id = Number.parseInt((req.params as { id: string }).id, 10);
    if (!Number.isFinite(id)) {
      void reply.code(400).send({ error: 'bad_id' });
      return;
    }
    revokeDevice(app.db, id);
    void reply.redirect('/admin');
  });

  // NOTE: /admin/spotify/login and /admin/spotify/callback are registered by
  // the SpotifyModule itself (src/spotify/oauth.ts → registerSpotifyOAuthRoutes)
  // so that the OAuth handlers have direct access to the token manager. The
  // dashboard's "Login to Spotify" button links to /admin/spotify/login.
}
