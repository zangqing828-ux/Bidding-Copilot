# 远端 CI 说明

## 目标

所有进入 `main` 的 Pull Request 都先完成客户端、Analytics Worker 和 Analytics Dashboard 的可重复验证。正式 Release 在创建 GitHub Release 前再次执行客户端质量门禁。

## Workflow

### CI

文件：`.github/workflows/ci.yml`

触发方式：

- Pull Request 指向 `main`
- Push 到 `main`
- 手动触发

固定门禁：

| Check | 内容 |
| --- | --- |
| `CI / Repository Hygiene` | lockfile 完整性、变更范围 whitespace |
| `CI / Client Build` | `npm ci`、CommonJS 语法、Web 构建、`test:web` 与浏览器 Gate、high 审计 |
| `CI / Analytics Worker Check` | `npm ci`、Wrangler dry-run、critical 审计 |
| `CI / Analytics Dashboard Check` | `npm ci`、Wrangler dry-run、critical 审计 |
| `CI / Quality Gate` | 汇总以上四项，任一失败时整体失败 |

主分支保护应使用稳定检查名 `CI / Quality Gate`。

### Release Client（已退役）

桌面发行流水线 `.github/workflows/release.yml` 及 Windows/macOS 打包已随 Web-only 首发退役（WR-06A 删除）。当前不再有桌面 Release workflow；Web 交付以 Docker 镜像 + ECS 部署为准（见 `.planning/web-single-tenant-release/`）。如需重新引入桌面发行，须通过独立工作包与审核。

## 本地等价验证

客户端：

```bash
cd client
npm ci
find scripts server core shared -name '*.cjs' -print0 | xargs -0 -n1 node --check
npm run build:web
npm run test:web
npm run audit:production
```

Analytics Worker：

```bash
cd analytics/worker
npm ci
npx --no-install wrangler deploy --dry-run --outdir /tmp/analytics-worker
npm audit --audit-level=critical
```

Analytics Dashboard：

```bash
cd analytics/dashboard
npm ci
npx --no-install wrangler deploy --dry-run --outdir /tmp/analytics-dashboard
npm audit --audit-level=critical
```

## 依赖审计基线

WR-06A（2026-07-29）已删除 Pi/Electron/`xlsx` 等依赖并升级余下依赖，客户端生产依赖 `npm audit --omit=dev` 的 high 与 critical 漏洞已清零；客户端 CI 门槛为 high（`npm run audit:production`）。Analytics Worker/Dashboard 仍以 critical 为首版门槛，其历史 high/moderate 风险作为独立治理任务处理。

## 主分支保护

GitHub Ruleset `Main branch quality gate` 已于 2026-07-23 启用：

- Ruleset ID：`19615061`
- 状态：`active`
- 目标：默认分支 `main`
- 无绕过角色
- 禁止删除 `main`
- 禁止强制推送
- 所有变更必须通过 Pull Request
- 所有 review conversation 必须解决
- 必须由 GitHub Actions App 提交 `Quality Gate`
- PR 必须基于最新 `main` 完成检查

规则地址：

```text
https://github.com/zangqing828-ux/Bidding-Copilot/rules/19615061
```

后续调整 CI 检查名时，必须在同一 Pull Request 中同步更新 Ruleset，避免主分支进入不可合并状态。
