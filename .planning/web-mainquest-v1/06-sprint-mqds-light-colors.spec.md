# Sprint 06 Spec：MQDS 浅色配色替换

## 1. Sprint 结果

所有保留页面统一切换为 MainQuest MQDS v4.1 Light 色板。组件结构、布局几何、交互和业务行为保持一致。

## 2. 强制范围

允许修改的视觉属性：

- CSS 自定义颜色变量。
- `color`、`background-color`、纯色 `background`。
- `border-color`、`outline-color`。
- SVG `fill`、`stroke`。
- `caret-color`、滚动条颜色。
- 现有阴影中的颜色值；偏移、模糊、扩散参数保持原值。

禁止修改：

- React 组件树和 JSX 结构。
- 页面布局、宽高、间距、定位、Grid、Flex。
- 字号、字重、行高和字体。
- 圆角。
- 阴影的偏移、模糊和扩散。
- 图标、Logo、文案和业务交互。
- 动画、过渡时长和状态逻辑。
- 深色变量、主题切换、主题 Provider 和 `data-theme`。

## 3. 色板

### 3.1 基础色

| 语义 | 色值 |
| --- | --- |
| 页面背景 | `#ffffff` |
| 卡片/面板 | `#ffffff` |
| 次级背景 | `#f3f4f6` |
| Hover/选中弱底色 | `#e5e7eb` 或现有透明层映射 |
| 主文字 | `#111827` |
| 次文字 | `#6b7280` |
| 弱文字 | `#9ca3af` |
| 弱边框 | `#e5e7eb` |
| 主操作 | `#111827` |
| 主操作文字 | `#ffffff` |
| 滚动条 | `#d1d5db` |

### 3.2 状态色

| 状态 | 文字 | 背景 |
| --- | --- | --- |
| 成功 | `#166534` | `#dcfce7` |
| 警告 | `#92400e` | `#fef3c7` |
| 错误 | `#991b1b` | `#fee2e2` |
| 信息 | `#374151` | `#f3f4f6` |

状态色只用于状态、风险和校验，不作为普通装饰色。

## 4. 实施策略

1. 删除功能的 CSS 已在 Sprint 01 移除。
2. 先更新 `client/src/styles/tokens.css` 的语义 Token。
3. 把保留 CSS 中蓝、紫、青色品牌值映射到上述色板。
4. 保留状态语义色并统一为表中值。
5. 处理 SVG fill/stroke、Radix 状态、Toast、Dialog、Markdown、编辑器和滚动条。
6. 对硬编码 `hex/rgb/rgba/gradient` 做全量搜索。
7. 逐页截图，对照 Sprint 05 的布局基线。

渐变处理：

- 普通品牌渐变改为单色或同色系浅灰渐变。
- 保留结构所需的透明度层。
- 不新增视觉效果。

## 5. 重点文件

```text
client/src/styles/tokens.css
client/src/styles/layout-app-shell.css
client/src/styles/app-shell-dialogs.css
client/src/styles/shared-components.css
client/src/styles/shared-dialog.css
client/src/styles/shared-toast.css
client/src/styles/shared-markdown.css
client/src/styles/feature-technical-plan.css
client/src/styles/feature-knowledge-base.css
client/src/styles/feature-duplicate-check.css
client/src/styles/feature-rejection-check.css
client/src/styles/feature-export-format.css
client/src/styles/feature-settings.css
client/src/styles/feature-developer.css
```

## 6. SDD 方案

- 模式：SDD Light。
- 开发工包：1 个 Spark worker。
- 原因：Token 和页面 CSS 存在大量共享选择器，多 worker 容易产生重复映射和冲突。
- 审查：Sol Medium，重点判断是否严格满足“只改配色”和 MQDS Light 品牌目标。
- 主线程负责逐页视觉冒烟和 CSS 属性差异检查。
- 升级触发：若颜色替换必须改 JSX 或组件状态结构，立即返回主线程裁决，不自动扩大范围。

## 7. 页面验收矩阵

至少覆盖：

- 应用 Shell、主菜单、顶部工具条。
- 技术方案五步流程及已有方案扩写。
- 知识库。
- 标书查重。
- 废标项检查。
- 模板与导出格式。
- 设置和开发配置。
- Dialog、Popover、Tooltip、Toast。
- Markdown 阅读器与编辑器。
- 上传、任务运行、成功、警告、失败和禁用态。

## 8. 验收标准

- 所有保留页面没有旧蓝紫品牌主色。
- 页面背景、面板、文字和边框符合 MQDS Light 色板。
- 主操作为黑底白字或现有结构下的黑色强调。
- 普通数据与标签保持黑白灰。
- 状态色只出现在对应语义场景。
- 没有深色样式、主题开关和玻璃效果。
- DOM 结构和组件数量无计划外变化。
- 关键元素的 bounding box 与 Sprint 05 基线一致，允许浏览器字体渲染产生微小误差。
- 键盘焦点、禁用态、Hover 和错误态仍清晰。
- 文字与背景达到基本可读性要求。

## 9. 验证

```bash
cd client
npm run build
```

颜色审计：

```bash
rg -n "#[0-9A-Fa-f]{3,8}|rgba?\\(|linear-gradient|radial-gradient" src --glob "*.css"
rg -n "blue|purple|violet|cyan|indigo" src --glob "*.css"
```

结构差异审计：

```bash
git diff <sprint-05-sha> -- client/src -- "*.tsx" "*.ts"
git diff --word-diff=porcelain <sprint-05-sha> -- client/src/styles
```

手动验证：

- 按页面矩阵逐页截图。
- 桌面宽度和小屏宽度各检查一次。
- 对 Dialog、Toast、表单 focus、禁用和错误态做交互检查。

## 10. 回滚

- Sprint 颜色修改保持独立提交。
- 回滚该提交即可恢复 Sprint 05 配色。
- 不混入业务逻辑修改。

## 11. Sprint 07 交接物

- 色板 Token 表。
- 旧品牌色残留清单为零或有逐条合理说明。
- 页面截图证据。
- 冻结 commit SHA 与审查结论。
