# 测试与发布 Gate

## 1. 测试原则

- 单元测试验证 pure function、校验器、状态转换和格式 builder。
- integration test 验证 Bridge -> TenantContext -> task -> Store -> SSE。
- Browser E2E 验证真实用户路径和错误体验。
- Docker smoke 验证 Linux 依赖、Node ABI、Chromium、字体、OpenCode Foundation 和持久卷。
- 真实模型 E2E 只在本地 RC 和 ECS staging 运行，不在普通 PR CI 消耗外部额度。
- Prompt、JSON contract、图片计划和输出质量需有固定 fixture/eval。
- mock 只能验证控制流，不能替代真实模型 Gate。

## 2. 覆盖图

```text
AUTH
  MainQuest authorize
    +-- authorized Product user ------> code -> token -> /me -> session [E2E]
    +-- unauthorized Product user ----> access_denied, no session [E2E]
    +-- state mismatch ---------------> 400, no session [integration]
    +-- token timeout ----------------> safe error, retry login [integration]

UPLOAD
  multipart
    +-- PDF/DOCX/TXT/MD valid --------> file ID -> parser -> Markdown [integration/E2E]
    +-- DOC/XLS/XLSX -----------------> 400 unsupported [integration]
    +-- fake extension ---------------> 400 + temp cleanup [integration]
    +-- oversize/timeout -------------> bounded failure [integration]

TECHNICAL PLAN
  bid analysis [existing + regression]
    -> outline [E2E + eval]
      -> edit/invalidate [integration]
        -> global facts [E2E + eval]
          -> content [E2E + eval]
              +-- pause/resume [E2E]
              +-- retry section [E2E]
              +-- refresh [E2E]
              +-- restart interrupted [Docker E2E]
              +-- stale revision [integration]

ILLUSTRATIONS
  plan
    +-- Mermaid -> validate -> render/repair -> PNG [integration/E2E]
    +-- HTML -> sanitize -> isolated render -> PNG [security integration/E2E]
    +-- AI -> generate/download -> validate -> file [integration/E2E]
    +-- rerun -> remove old block/assets -> regenerate [E2E]

EXPORT
  latest outline content + template + assets
    -> DOCX buffer
      +-- structure/styles/numbering/media [unit/integration]
      +-- LibreOffice open/convert [Docker QA]
      +-- token download/expiry/replay [Browser E2E]

OPERATIONS
  Docker start -> readiness -> login -> business flow -> restart -> restore
    +-- backup/restore [local RC + staging]
    +-- old digest rollback [staging]
```

## 3. 功能验收矩阵

| 能力 | 成功路径 | 失败/边界 | 持久化/恢复 | 测试层 |
|---|---|---|---|---|
| OAuth | 有权限用户登录 | 无权限、state 错、token 超时 | session 重启后有效 | integration + staging E2E |
| 单租户 | A 写入，B 可读取 | session 互不复用 | 重启后共享数据保留 | integration + E2E |
| 上传 | 四种格式解析 | 伪装、超大、范围外 | file ID 重启后可解析 | integration |
| 招标分析 | 真实模型成功 | 模型超时、JSON 错 | 刷新恢复 | integration + real E2E |
| 目录 | 标准/扩写成功 | 缺输入、stale revision | 编辑失效旧下游 | unit + E2E + eval |
| 全局事实 | 生成和人工保存 | 空/坏 JSON、模型失败 | 刷新恢复 | unit + E2E + eval |
| 正文 | 完整生成 | 任务冲突、单章失败 | pause/resume/retry/restart | integration + E2E + eval |
| Mermaid | PNG 成功 | 非法语法、修复失败 | 计划与文件保留 | unit + Docker E2E |
| HTML 图 | PNG 成功 | script/外链/超高/超时 | 失败可单独重跑 | security integration |
| AI 图 | 文件成功 | 错 MIME、超大、超时、SSRF/DNS redirect | 原子写入、可重跑 | security integration + real E2E |
| DOCX | 模板、编号、表格、图片 | 缺 asset、builder error | 临时文件清理 | unit + Browser + QA |
| SSE | 进度到浏览器 | 断线、重连、shutdown | Store 重放 | integration + E2E |
| Backup | 新容器恢复 | 损坏包拒绝 | SQLite + files 一致 | local/staging drill |

## 4. Prompt 与质量 eval

至少保留以下脱敏 fixture：

1. 标准技术方案招标文件。
2. 已有方案扩写：带原方案正文和两级以上目录。
3. 包含事实冲突、字数控制、表格要求的复杂样例。
4. 包含 Mermaid、HTML 图、AI 图需求的样例。

每次改 Prompt 或 JSON contract 时验证：

- 招标要求覆盖率
- 目录结构合法性
- 原方案内容保留
- 全局事实不引入明显冲突
- 所有叶子小节生成正文
- 暂停/继续不重复已完成章节
- 图片计划引用存在的小节
- DOCX 内容与 Store 权威正文一致

eval 结果记录 model/provider/config hash，禁止记录 API key、用户原文和服务器绝对路径。

## 5. 安全测试

### Auth/session

- state 必须同时匹配 URL 与 HttpOnly Cookie。
- production Cookie 必须 `Secure`、`HttpOnly`、`SameSite=Lax`。
- session 过期后所有 bridge/upload/download/SSE 返回 401。
- logout 删除服务端 session 并清理新旧 Cookie。
- OAuth/AI 错误响应和日志不含 code、token、secret。

### 文件

- 路径穿越文件名不会改变服务端目标路径。
- file ID 不属于当前租户时拒绝。
- zip bomb/超大 DOCX 解压边界测试。
- parser worker timeout 后进程和临时文件释放。
- 下载 token 一次性、短 TTL、只允许当前租户。
- AI 图片 URL 下载逐次校验 DNS 和 redirect；loopback、私网、link-local、云 metadata
  地址与非 HTTP(S) 协议全部拒绝。

### HTML/Chromium

- `<script>`、事件属性、iframe、object、embed、form 被拒绝或删除。
- `http(s)://`、`file://`、`javascript:`、CSS `url()` 外链被阻断。
- renderer 无法访问 `/data` 和环境变量。
- 每个失败路径都关闭 Page/Context。
- 并发上限和最大截图尺寸有效。

## 6. 性能与稳定性 Gate

首发不追求高并发，要求资源有明确上限：

| 指标 | Gate |
|---|---|
| Web 实例 | 1 |
| 同时技术方案写任务 | 1 |
| 文本 AI 并发 | 沿用配置，但不超过服务端上限 30 |
| 图片 AI 并发 | 沿用配置，但不超过服务端上限 6 |
| Chromium context | 有界，默认不超过 2 |
| 上传 | 单文件默认 50 MB，最多 10 个 |
| Bridge JSON body | 2 MB |
| SSE heartbeat | 30 秒 |
| shutdown | 30 秒内完成或失败退出 |
| 下载 token | 5 分钟、每租户最多 10 个 |
| 容器峰值内存 | 完整小型流程低于已配置容器上限的 70%，无 OOM/重启 |

稳定性检查：

- 连续执行三次小型完整流程，无残留 `running`。
- 连续生成 20 张测试图后 Browser/Page 数回到空闲值。
- 重复导出 10 次，旧临时文件按上限和 TTL 清理。
- 两个浏览器同时操作时无 SQLite busy 泄漏、无 stale overwrite。
- Local RC 和 ECS staging 记录 `docker stats`、Chromium 子进程数和 `/data` 增长量。

## 7. PR Gate

每个 WR 包至少运行：

```bash
cd client
npm ci
npm run build:web
npm run test:web
find server core shared scripts -name '*.cjs' -print0 | xargs -0 -n1 node --check
npm audit --omit=dev --audit-level=high
```

涉及 Browser/Docker 时追加：

```bash
npx playwright install chromium
npm run test:web-browser
cd ..
docker build -t bidmaster-web:pr .
```

PR 不得合入的情况：

- release-reachable pending/stub/mock。
- 新增 high/critical 漏洞。
- 单包净新增超过 1,000 行且无批准。
- 测试只断言 500/501 或文件头。
- 技术方案 core 直接导入 Electron、Express 或 `server/agent`；OpenCode Foundation 只能通过服务端 Task Spec/port 接入。
- 用户可见旧品牌或旧推广链接。

## 8. Local RC Gate

### 8.1 环境

- Docker production image。
- 临时独立数据目录。
- mock OAuth，仅用于本地身份。
- 真实文本模型。
- 真实图片模型。
- 真实 PDF/DOCX fixture。
- 固定 checksum 的真实 OpenCode binary、`prlimit`、`rg`、`fd` 和 `jq`。

### 8.2 必跑场景

#### RC-01 标准方案

PDF -> 招标分析 -> 目录 -> 编辑 -> 全局事实 -> 正文 -> 三类图片 -> 模板 DOCX -> 下载。

#### RC-02 已有方案扩写

DOCX 招标文件 + DOCX 原方案 -> 目录 original-only/AI 补充的首发保留模式 -> 正文 -> 图片 -> DOCX；核对原方案关键段落仍存在。

#### RC-03 两用户

用户 A 创建方案；用户 B 登录后读取并继续；用户 A/B Cookie 互不替代。

#### RC-04 中断恢复

正文运行中刷新页面；随后重启 container；确认已完成章节保留，中断任务可继续/重试。

#### RC-05 OpenCode Foundation

构建 production 与 `agent-e2e` target；确认 readiness 通过，真实 OpenCode 完成两轮 tool-call，安全读取唯一声明输出，成功/失败/取消后任务目录清理。确认 production image 不包含测试 harness，浏览器无法调用通用 Agent Bridge。

#### RC-06 边界

- 范围外上传
- 错误文件签名
- 模型超时
- Mermaid 无法修复
- HTML 外链/脚本
- AI 图片错误 MIME
- session 过期
- download token 重放

#### RC-07 备份恢复

停止测试容器，备份 `/data`，在新目录恢复并启动同 digest；确认项目、图片、模板和 session/账号数据一致。

### 8.3 通过标准

- 所有必跑场景全绿。
- 连续三轮无随机失败。
- 生成的 DOCX 可由 Word/LibreOffice 打开。
- active brand scan、Contract pending、dependency audit 全绿。
- 镜像 digest、Git SHA、测试输出、峰值资源数据和样例文件进入证据包。

## 9. ECS Staging Gate

必须通过：

- HTTPS 与真实域名。
- TLS 证书链、到期监控和自动续期 owner。
- MainQuest authorized、unauthorized、forced-password-change。
- callback redirect URI 精确匹配。
- Secure Cookie。
- SSE 运行至少 15 分钟且代理不缓冲。
- 单文件 50 MB 上限内上传成功，10 文件 multipart 不被代理提前拦截，超限明确失败。
- `/data` 持久卷重启后保留。
- 真实小型完整流程。
- 冷备份恢复。
- 旧 image digest 回滚。
- 长任务 shutdown 获得至少 40 秒容器停止窗口，不被代理或 Compose 提前强杀。
- 日志不含 secret、OAuth code、用户正文、完整模型响应。

## 10. 发布证据

每个 RC 记录：

```text
release-evidence/
  manifest.json
  commands.log
  test-summary.md
  dependency-audit.txt
  contract-summary.json
  brand-scan.txt
  docker-image.txt
  docx-structure.json
  screenshots/
```

`manifest.json` 至少包含：

- Git SHA
- image tag 和 digest
- Node/Chromium 版本
- fixture hash
- model/provider 名称与配置 hash
- 测试开始/结束时间
- Gate 结果

证据中禁止保存 secret、Cookie、用户原始文件和完整模型响应。

## 11. Gate 总表

| Gate | 阻断条件 | Owner |
|---|---|---|
| G-A Scope | 可达退出能力或 pending | 代码集成 |
| G-B Core | 重复实现、技术方案 core 直接依赖 Electron/Express/server Agent | 架构 |
| G-C Text | 真实模型两条文本链失败 | 产品/工程 |
| G-D Images | 任一图片类型无法真实落盘 | 产品/工程 |
| G-E DOCX | 模板/编号/表格/图片不完整 | 产品 |
| G-F Security | high/critical 非零、OpenCode checksum/权限/输出边界或其他越界测试失败 | 工程 |
| G-G Local RC | 完整本地闭环未通过 | 老板 |
| G-H MainQuest | Product/redirect/三用户未验收 | 老板 + MQ owner |
| G-I ECS | HTTPS/SSE/volume/backup/rollback 失败 | 老板 + 运维 |
