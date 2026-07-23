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
| `CI / Client Build` | `npm ci`、CommonJS 语法、TypeScript/Vite 构建、critical 审计 |
| `CI / Analytics Worker Check` | `npm ci`、Wrangler dry-run、critical 审计 |
| `CI / Analytics Dashboard Check` | `npm ci`、Wrangler dry-run、critical 审计 |
| `CI / Quality Gate` | 汇总以上四项，任一失败时整体失败 |

主分支保护应使用稳定检查名 `CI / Quality Gate`。

### Release Client

文件：`.github/workflows/release.yml`

`Release Quality Gate` 会在创建或更新 GitHub Release 前执行：

- 客户端依赖安装
- Electron Main 与脚本语法检查
- TypeScript 与 Vite 构建
- critical 生产依赖审计

门禁失败时不会创建 Release，也不会启动 Windows/macOS 打包。

## 本地等价验证

客户端：

```bash
cd client
npm ci
find electron scripts -name '*.cjs' -print0 | xargs -0 -n1 node --check
npm run build
npm audit --omit=dev --audit-level=critical
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

截至 2026-07-23，客户端与 Wrangler 依赖树仍有 high 和 moderate 级历史风险，其中客户端 `xlsx` 缺少可用修复版本。CI 首版阻断 critical；完整报告继续显示在 Actions 日志中。升级依赖和替换 `xlsx` 应作为独立治理任务处理。

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
