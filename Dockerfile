# bb-proxy Dockerfile
# Targets Node 20 on Debian slim (not Alpine — Playwright/Chromium needs glibc,
# and better-sqlite3 + sharp prebuilds target debian/ubuntu cleanly).
# Multi-stage: build TS once, copy compiled JS to a minimal runtime image.

ARG NODE_VERSION=20-bookworm-slim

# ---------- builder ----------
FROM node:${NODE_VERSION} AS builder

WORKDIR /app

# Build deps for native modules (better-sqlite3, sharp).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# Install all deps (incl. dev) for the build.
RUN npm install --include=dev

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

# `npm run build` runs tsc then scripts/copy-assets.mjs which copies schema.sql
# and admin/views/** into dist/ (cross-platform, used in local dev too).
RUN npm run build

# Prune to production deps for the runtime stage.
RUN npm prune --omit=dev

# ---------- runtime ----------
FROM node:${NODE_VERSION} AS runtime

WORKDIR /app

# Playwright Chromium system deps + ffmpeg for Spotify transcoding.
# Playwright will install its own browser binary (Chromium) via postinstall on
# first run; we pre-install it in the builder stage below as an optimization.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    wget \
    xdg-utils \
 && rm -rf /var/lib/apt/lists/*

# Copy pruned node_modules and built JS from builder.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Browsers get installed to *shared* paths (not per-user caches) so the final
# USER node runtime sees the same binaries the build installed. Without this,
# Playwright and Puppeteer default to $HOME/.cache which is /root at install
# time and /home/node at runtime — paths diverge, module crashes on boot.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PUPPETEER_CACHE_DIR=/puppeteer-cache

# Playwright Chromium (used by the Browser module).
RUN mkdir -p /ms-playwright \
 && npx --yes playwright install chromium

# Puppeteer's Chrome (used by whatsapp-web.js, which ships puppeteer as a dep).
# `require.resolve` locates install.mjs whether puppeteer is hoisted to the root
# node_modules or nested under whatsapp-web.js/. We then exec it with our
# PUPPETEER_CACHE_DIR so Chrome lands in the shared path the runtime user owns.
RUN mkdir -p /puppeteer-cache \
 && node -e "const {execFileSync}=require('child_process'); const p=require.resolve('puppeteer/install.mjs'); execFileSync(process.execPath,[p],{stdio:'inherit'})"

# Data dir + chown of shared browser caches so the non-root runtime user can
# read them.
RUN mkdir -p /data \
 && chown -R node:node /data /ms-playwright /puppeteer-cache

USER node

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PUPPETEER_CACHE_DIR=/puppeteer-cache

EXPOSE 8080

# Coolify should map its healthcheck at /health.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "dist/index.js"]
