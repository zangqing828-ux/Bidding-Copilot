ARG TARGETARCH

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

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    RUNNER_PORT=7101 \
    RUNNER_HOST=0.0.0.0 \
    AGENT_OUTPUT_DIR=/var/lib/bidmaster/output \
    AGENT_WORKSPACE_ROOT=/var/lib/bidmaster/output \
    HOME=/tmp/agent-home \
    XDG_CONFIG_HOME=/tmp/agent-config \
    XDG_DATA_HOME=/tmp/agent-data \
    XDG_CACHE_HOME=/tmp/agent-cache \
    YIBIAO_AGENT_OPENCODE_BIN=/opt/agent-assets/bin/opencode \
    AGENT_SECCOMP_PROFILE=/opt/agent-assets/seccomp/agent-runner.json \
    PATH=/opt/agent-assets/bin:${PATH}

RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 agentrunner \
  && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin agentrunner

WORKDIR /opt/bidmaster
COPY client/shared ./client/shared
COPY client/server/agent-sidecar ./client/server/agent-sidecar
COPY client/agent-runner ./client/agent-runner
COPY client/server/agent ./client/server/agent
COPY client/core ./client/core
COPY --from=runner-assets /opt/agent-assets /opt/agent-assets
COPY docker/agent-runner/seccomp/agent-runner.json /opt/agent-assets/seccomp/agent-runner.json
RUN mkdir -p /var/lib/bidmaster/output \
  && test -x /opt/agent-assets/bin/opencode \
  && test -x /opt/agent-assets/bin/rg \
  && test -x /opt/agent-assets/bin/fd \
  && test -x /opt/agent-assets/bin/jq \
  && /opt/agent-assets/bin/opencode --version >/dev/null \
  && /opt/agent-assets/bin/rg --version >/dev/null \
  && /opt/agent-assets/bin/fd --version >/dev/null \
  && /opt/agent-assets/bin/jq -n '1+1' >/dev/null \
  && prlimit --version >/dev/null \
  && chown -R 10001:10001 /opt/bidmaster /opt/agent-assets /var/lib/bidmaster

USER 10001:10001
ENTRYPOINT ["node", "/opt/bidmaster/client/agent-runner/runner.cjs"]
