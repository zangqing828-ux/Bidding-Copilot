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

## 主分支保护启用顺序

1. CI workflow 合入 `main`。
2. 在 `main` 上确认一次 `CI / Quality Gate` 成功。
3. 创建 GitHub Ruleset，要求 Pull Request 和 `CI / Quality Gate`。
4. 再次通过测试 PR 验证合并限制。

在检查名尚未出现在 `main` 前，不提前绑定 required check。
