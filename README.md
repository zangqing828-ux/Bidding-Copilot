# BidMaster

<p align="center">
  <strong>简体中文</strong> | <a href="./README.en.md">English</a>
</p>

BidMaster 是一款面向招投标场景的 AI 标书写作工具，当前交付形态为可完整在浏览器中使用、可由 Docker 单实例部署的纯 Web 应用，通过 MainQuest OAuth 完成登录与访问授权。

> 仓库地址：<https://github.com/zangqing828-ux/Bidding-Copilot>

## 首发能力范围

- **生成技术方案**：上传招标文件（PDF / DOCX / TXT / Markdown）→ 需求分析 → 大纲 → 事实材料 → 正文 → 图片 → 高保真 DOCX 导出下载。
- **已有方案扩写**：基于既有方案文本进行结构化扩写。
- **模板管理**：导出模板的创建、编辑与预览。
- **设置**：文本模型、生图模型与文件解析方式配置，配置在服务端加密保存。

主链路中的长任务在服务端执行并持续落盘，页面刷新或容器重启后可恢复进度；Mermaid、HTML 图与 AI 图片生成、按模板导出高保真 DOCX 均在服务端完成。

## 部署形态

- 单实例 Docker 部署，一个部署对应一个租户业务空间。
- 所有获授权用户共享同一租户业务数据，各自保留独立 session 与身份记录。
- 生产环境强制 MainQuest OAuth（`OAUTH_MODE=mainquest`）与 HTTPS。

### Docker 快速开始

```bash
# 构建镜像（仓库根目录）
docker build -t bidmaster-web:local .

# 准备环境变量
cp .env.example .env   # 按需填写 OAuth、SESSION_SECRET、CONFIG_ENCRYPTION_KEY 等

# 启动
docker compose up -d

# 健康检查
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/readiness
```

数据目录由 `BIDMASTER_DATA_DIR`（默认 `/data`）注入，业务状态保存在租户 SQLite 与租户文件目录中，请为 `/data` 配置持久卷与备份。

详细部署说明见 [docs/web-deployment.md](./docs/web-deployment.md)。

## 本地开发

```bash
cd client
npm ci
npm run dev:web      # 开发模式
npm run build:web    # Web 构建
npm run test:web     # Web 聚焦测试
```

更多开发约定见 [client/开发说明.md](./client/开发说明.md) 与 [AGENTS.md](./AGENTS.md)。

## 项目文档

- [项目目标与锁定决策](./project.md)
- [Web 单租户首发基线](./.planning/web-single-tenant-release/baseline.md)
- [贡献指南](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)

## 许可证

本项目基于开源许可证发布，详见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
