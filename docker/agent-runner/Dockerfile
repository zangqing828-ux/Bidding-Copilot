FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    RUNNER_PORT=7101 \
    RUNNER_HOST=0.0.0.0

RUN groupadd --system --gid 10001 agentrunner \
  && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin agentrunner

WORKDIR /opt/bidmaster
COPY client/shared ./client/shared
COPY client/server/agent-sidecar ./client/server/agent-sidecar
COPY client/agent-runner ./client/agent-runner
RUN chown -R 10001:10001 /opt/bidmaster

USER 10001:10001
EXPOSE 7101
ENTRYPOINT ["node", "/opt/bidmaster/client/agent-runner/runner.cjs"]
