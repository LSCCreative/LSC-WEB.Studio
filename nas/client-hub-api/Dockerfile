# Client Hub API — Node + Express + SQLite, runs on the DXP4800 Pro (amd64).
# Nothing here is arch-specific, so the same file builds on an arm64 Mac.

# ── Stage 1: dependencies ─────────────────────────────────────────────────────
# better-sqlite3 ships prebuilt binaries for common Node ABIs; the toolchain is
# here so a version without a prebuild compiles rather than fails.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# /data is the volume mount point. Created and owned here so the container can
# write the SQLite DB as the unprivileged `node` user.
RUN mkdir -p /data && chown -R node:node /data
USER node

ENV DATA_DIR=/data
ENV DELIVERABLES_DIR=/srv/deliverables
ENV PORT=8097
EXPOSE 8097

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8097)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
