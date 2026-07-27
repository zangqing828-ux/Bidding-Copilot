# syntax=docker/dockerfile:1.7
# WP-J Web Runtime：Web 与 Agent Runner 分离构建。

ARG TARGETARCH

# === Stage 1: Renderer builder ===
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci

COPY client/ ./client/
RUN cd client && npm run build:web

# === Stage 2: Native production dependencies ===
# 编译工具只存在于依赖构建层，最终 Web 镜像不携带它们。
FROM node:22-bookworm-slim AS web-deps

WORKDIR /app/client

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY client/package.json client/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm rebuild better-sqlite3 --runtime=node

# === Stage 3: Web production runtime ===
FROM node:22-bookworm-slim AS web-runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      fonts-noto-cjk \
      fonts-noto-cjk-extra \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /bin/prlimit /usr/bin/prlimit /bin/curl /usr/bin/curl /bin/jq /usr/bin/jq /bin/rg /usr/bin/rg /bin/fd /usr/bin/fd

WORKDIR /app

COPY --from=web-deps /app/client/node_modules ./client/node_modules
COPY --from=builder /app/client/dist ./client/dist
COPY client/package.json ./client/package.json
COPY client/server/ ./client/server/
COPY client/shared/ ./client/shared/
COPY client/core/ ./client/core/
COPY client/electron/ ./client/electron/

# Web 镜像不复制 Agent Runner、OpenCode binary 或 Runner 工具。
RUN groupadd --system --gid 10001 bidmaster \
    && useradd --system --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin bidmaster \
    && mkdir -p /data \
    && chown -R 10001:10001 /app /data

USER 10001:10001

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    YIBIAO_DATA_DIR=/data \
    OAUTH_MODE=mainquest \
    AGENT_QUALITY_ENABLED=0 \
    AGENT_SIDECAR_ENABLED=0 \
    AGENT_SIDECAR_URL=http://agent-runner:7101

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/client
CMD ["node", "server/index.cjs"]

# === Stage 4: Agent Runner fixed assets ===
# Runner 专用资产在独立构建层下载并逐项校验固定 SHA-256；Web production
# target 不会触发该层，也不会把这些资产带入 Web 镜像。
FROM node:22-bookworm-slim AS runner-assets

ARG TARGETARCH
ARG OPENCODE_VERSION=v1.17.8

WORKDIR /build

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tar gzip \
    && rm -rf /var/lib/apt/lists/*

COPY client/scripts/prepare-agent-runner-assets.cjs ./scripts/prepare-agent-runner-assets.cjs
COPY client/scripts/agent-runner-assets.json ./scripts/agent-runner-assets.json
RUN OPENCODE_VERSION="${OPENCODE_VERSION}" node scripts/prepare-agent-runner-assets.cjs --arch "${TARGETARCH}"

# === Stage 5: Agent Runner target ===
# Compose 生产部署优先使用 docker/agent-runner/Dockerfile；保留同名 target
# 供 Linux CI 做独立 Runner 镜像构建检查，避免工具链回流 Web 镜像。
FROM node:22-bookworm-slim AS agent-runner

ENV NODE_ENV=production \
    RUNNER_PORT=7101 \
    RUNNER_HOST=0.0.0.0 \
    AGENT_OUTPUT_DIR=/var/lib/bidmaster/output \
    HOME=/tmp/agent-home \
    XDG_CONFIG_HOME=/tmp/agent-config \
    XDG_DATA_HOME=/tmp/agent-data \
    XDG_CACHE_HOME=/tmp/agent-cache \
    YIBIAO_AGENT_OPENCODE_BIN=/opt/agent-assets/bin/opencode \
    PATH=/opt/agent-assets/bin:${PATH}

RUN groupadd --system --gid 10001 agentrunner \
    && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin agentrunner \
    && mkdir -p /opt/bidmaster /var/lib/bidmaster/output \
    && chown -R 10001:10001 /opt/bidmaster /var/lib/bidmaster

WORKDIR /opt/bidmaster
COPY client/shared ./client/shared
COPY client/server/agent-sidecar ./client/server/agent-sidecar
COPY client/agent-runner ./client/agent-runner
COPY client/server/agent ./client/server/agent
COPY client/core ./client/core
COPY --from=runner-assets /opt/agent-assets /opt/agent-assets

RUN test -x /opt/agent-assets/bin/opencode \
    && test -x /opt/agent-assets/bin/rg \
    && test -x /opt/agent-assets/bin/fd \
    && test -x /opt/agent-assets/bin/jq \
    && /opt/agent-assets/bin/opencode --version >/dev/null \
    && /opt/agent-assets/bin/rg --version >/dev/null \
    && /opt/agent-assets/bin/fd --version >/dev/null \
    && /opt/agent-assets/bin/jq -n '1+1' >/dev/null \
    && prlimit --version >/dev/null

USER 10001:10001
WORKDIR /opt/bidmaster
ENTRYPOINT ["node", "/opt/bidmaster/client/agent-runner/runner.cjs"]

# 未指定 --target 时固定产出 Web production image。
FROM web-runtime AS production
