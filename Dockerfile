# syntax=docker/dockerfile:1.7

# ---------- Stage 1: build ----------
# The web client is packages/renderer only — it runs standalone against
# Dexie/IndexedDB and doesn't need the Hono server or Electron at runtime.
# @easydb/renderer depends on @easydb/shared (workspace `*` dep), so shared
# must be compiled to dist/ before the renderer build can resolve it.
FROM node:24-alpine AS builder
WORKDIR /app

# Dependency layer: package.json files only, so this caches across source
# changes. All four packages/* manifests are needed because npm workspaces
# resolves the whole workspace graph even though we only build two of them.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/renderer/package.json ./packages/renderer/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY packages/electron/package.json ./packages/electron/package.json

# --ignore-scripts is load-bearing: without it, npm ci would trigger
# Playwright's browser download (root devDep) and Electron's ~200 MB binary
# download, neither of which the renderer build needs. Belt-and-braces env
# var in case some transitive postinstall checks it directly.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --ignore-scripts --no-audit --no-fund

# Only what the build actually touches: tsconfigs, the plugin-catalog
# generator (imported by vite.config.ts's buildStart hook from the repo
# root, NOT from packages/renderer), and the two packages being built.
COPY tsconfig.json tsconfig.base.json ./
COPY scripts ./scripts
COPY packages/shared ./packages/shared
COPY packages/renderer ./packages/renderer

RUN npm run build -w @easydb/shared && npm run build -w @easydb/renderer

# ---------- Stage 2: runtime ----------
# Static files only — default nginx config serves /usr/share/nginx/html at
# root, which matches Vite's default base of "/". No custom nginx.conf: the
# app uses ?space= query params, not path routing, so no SPA try_files
# fallback is required either.
FROM nginx:alpine
COPY --from=builder /app/packages/renderer/dist /usr/share/nginx/html
EXPOSE 80
