# Dockerfile for Bidding Copilot Web v1
# 多阶段构建：构建前端 + 安装运行时依赖

# === Stage 1: 构建前端 ===
FROM node:22-slim AS builder

WORKDIR /app

# 安装构建依赖
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci

# 复制源码并构建
COPY client/ ./client/
RUN cd client && npm run build:web

# === Stage 2: 运行时 ===
FROM node:22-slim AS runtime

# 安装运行时系统依赖
# - better-sqlite3 需要 python3 + build-essential（已预装在 node:22-slim 的 node-gyp）
# - Chromium 用于 Mermaid/HTML 图片渲染（Sprint 05 工包 C，后续启用）
# - LibreOffice 用于 Word 导出转换（Sprint 05 工包 C，后续启用）
# - 中文字体
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    fonts-noto-cjk \
    fonts-noto-cjk-extra \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 安装生产依赖（--ignore-scripts 跳过 postinstall 的 electron-builder install-app-deps，
# 后续手动 rebuild better-sqlite3 为 Node ABI）
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3 --runtime=node

# 复制构建产物和源码
COPY --from=builder /app/client/dist ./client/dist
COPY client/server/ ./client/server/
COPY client/shared/ ./client/shared/
COPY client/core/ ./client/core/
COPY client/electron/ ./client/electron/
COPY client/package.json ./client/

# 创建非 root 用户
RUN useradd -r -s /bin/false yibiao && \
    mkdir -p /data && \
    chown -R yibiao:yibiao /app /data

USER yibiao

# 环境变量默认值
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV YIBIAO_DATA_DIR=/data
ENV OAUTH_MODE=mainquest

EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 启动
WORKDIR /app/client
CMD ["node", "server/index.cjs"]
