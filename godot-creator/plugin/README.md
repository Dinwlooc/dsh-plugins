# godot-creator-ui

DSH bundle：把 Godot AI 的连接状态做成两个常驻界面件，并向模型注册一个只读自开销工具。零运行时依赖、无构建步骤（包以绝对路径 link 进 profile，第三方依赖会解析失败；host 只用 node 内建 + `fetch`，client 只用基线 React）。

| 界面件 | 挂载点 | 内容 |
| --- | --- | --- |
| 状态芯片 | `conversation.session.header.actions` | 状态点 + `Godot` + `项目 · 场景`；悬停看诊断，点击刷新 |
| 集成诊断卡 | `settings.general.item` | 后端版本/工具面、attach 协议、MCP 服务版本、会话列表、检查时间 |

状态点：`ready` / `playing`（呼吸）/ `warn`（无编辑器）/ `offline`（不可达）/ `denied`（缺凭证）/ `pending`。

## 预设提示词

`cordis.patch.yml` 的 `persona` 段只写四类内容：**义务**（对结果负责、先读后写、独立回读验证）、**工作方法**（先读后改、小步闭环、最短路径）、**本模式提供的能力**（MCP 直连编辑器、按需技能与流程模板、只读观测件）、**Godot 环境特征**（编辑器会话/快照、场景资源所有权、视觉证据）。不写身份或角色扮演，也不复述项目规则——项目 AGENTS.md 与工具约束文档为最高准则。

## 结构

```
plugin/
├─ package.json      # dsh.bundle.patch + dsh.client{platform:web}
├─ cordis.patch.yml  # host 行 / preset 行 / 注册表行
└─ lib/{index.js,client.js,project-files.js}
```

## 数据来源

| 用途 | 调用 | 必需性 |
| --- | --- | --- |
| 编辑器会话 | `POST /mcp`：`initialize` → `notifications/initialized` → `tools/call session_manage(op=list)` | 主来源 |
| 后端身份 | `GET /godot-ai/status` | 可选增强 |
| 传输凭证 | `<capabilityDir>/http-<port>.json` 的 `http` 字段 → `Authorization: Bearer` | 4.3.0+ 必需 |

端口从 Addon 内置 DSH 配置发现（`$DSH_HOME` 的 `mcp-godot-ai` 条目 `--port`），优先级 `config.port` > 发现值 > `fallbackPort`；缓存 60 s。凭证按平台默认目录 + 发现的端口取名；文件不存在就不带认证头（兼容旧版），401 时强制重读一次。两者都不影响 DSH 自己的 MCP 工具（走 stdio）。

## 失败降级

| 情况 | 表现 |
| --- | --- |
| `/godot-ai/status` 改名/非 JSON | 身份未知，编辑器状态照常，`reachable=true` |
| 会话工具改名 | "会话查询失败"并给出当前工具名，提示改 `sessionTool` |
| 凭证缺失/失效 | 芯片 `denied` + 期望文件路径，不误报 `offline` |
| 凭证轮换 | 本次探测重读重试一次（`auth.retried`） |
| 会话额度用尽 | "会话额度用尽"，按 `sessionLimitBackoffMs` 退避 |
| 会话被回收 | 本次探测重建一次 |
| 两个来源都不可达 | `offline`，诊断卡列出两个原因 |

## MCP 会话额度（4.3.0）

`MAX_MCP_SESSIONS=32`，空闲 30 分钟回收，超额 `503 MCP_SESSION_LIMIT_REACHED`。所以**全程只持有 1 个会话**（按 `(端口, instance_nonce)` 归属）：每次探测只发一次 `tools/call`；404 时 `DELETE` 后重建一次；卸载时 `DELETE`；收到额度错误按 `sessionLimitBackoffMs` 退避。

## 自开销工具 `usage_report`

数据全部来自已挂载投影，**不新增计量**：`tokenUsage`（token）、`contextPressure`（上下文占比/窗口）、`contextBreakdown`（组成）。**不记时间**——墙钟/步数是 DSH 内置 `time-context` 插件（默认开启）的职责；**不记预算**——预算唯一账本是 budget-watch。本工具只做 token 与上下文的自开销视图。

- 三模式：`full`（缺省：会话总量 + 总值 + 命中率 + 上下文）· `baseline`（按会话记快照；默认只回一行，`verbose: true` 才回 JSON）· `delta`（免传参取本会话基线，一行给墙钟/总值/命中率）。**预算不在本工具记账**：`budget` 参数已移除，预算唯一账本是 budget-watch（`budget_register`/`budget_status`），防双账本漂移（2026-10-25 去重）。
- 命中率 `cacheRead/(cacheRead+input)` 低于 96% 时，渲染里追加"低成本——限制工具调用"；阈值与文案在 `lib/index.js`。
- 投影缺失时字段降级 `null` 并在 `missing` 点名。

## 项目文件工具 `project_files`

设计论文：`public/插件/0017`（v1.3，含执行记录与未完成项）。**注册表会话启动定型：实装后需重启会话才在工具面可见。**（2026-10-25 由 `project_fs` 改名：ops `query`/`remove` → `find`/`delete`，参数 `remove_rest` → `continue_on_block`；护栏语义未变。）

- **`op=find`**：类型感知检索。噪声默认在遍历层滤掉（`.uid`/`.import`/`.godot/`/`.trash/`/`*.tmp`）；`type` 多值过滤（scene/script/csharp/resource/texture/audio/md/meta-md/other，未知扩展归 other）；`type=meta-md` 检索 `.dsh/public` 论文（`NNNN-` 前缀 + frontmatter 解析，`state` 白名单 active/superseded/refuted，非法值报 USAGE）。输出不回传绝对路径。
- **`op=delete`**：删除至**系统回收站**（PowerShell VisualBasic）。护栏：lexical+realpath 双重根禁闭；保护清单（项目根/`project.godot`/`.godot/`）；symlink 只删链接（junction 判定修复待办，见论文）；静态 `res://` 引用拦截（`force` 绕过）；批量首 blocked 即停（`continue_on_block` 继续）。`root` 参数不在 schema（fail-closed，仅测试直调）。
- **与 `filesystem_manage`（godot-ai 第三方）的区分**：后者管资源内容操作（move/rename/reimport/read/write），**其 remove op 的全项目发现护栏可被无关大资源（>256KB）锁死，不可依赖**；项目文件删除一律走 `project_files delete`。
- **回收站通道修正（2026-10-25 实测）**：`UIOption` 合法值仅 `OnlyErrorDialogs`/`AllDialogs`，初版误用 `'DoNothing'` 导致宿主内 `recycle_failed` 稳定复现（测试环境被 spawn EPERM 提前 SKIP 掩盖）；已改 `OnlyErrorDialogs`，并补删后 lstat 回读（失败报 `recycle_unverified`，绝不假报 removed）。宿主重启后生效。

## 工具成本量级

`node test/tool-cost.mjs` 可复跑：按 `tool/call`/`tool/result`/`assistant/message` 归因每个工具的三笔账（参数=输出、结果=未命中、结果×剩余步数=缓存命中，实测 78–336×）。本会话量级：`read`/`pwsh`/`inspect` 占输入 95%，`pwsh`/`edit`/`write` 占输出 96%；`read` 单次峰值 13k token。

`project_files` 量级（2026-10-25 实测）：`find` 单次 1 个工具往返替代 shell 通道的 glob+过滤（真实项目 9114 条含 922 条噪声 → 8192 条，94–165ms）；`meta-md` 论文检索单次替代 84 个 md 逐个读头部；`delete` 含引用扫描，量级近似 `grep` 全项目一次。

## 安装 / 更新

```
plugin_manager(action="install_bundle", target="<仓库根>\\.dsh\\godot-creator\\plugin")
```

已安装后改内容 → `set_bundle` 关闭再启用（实测可载入新 host 代码；不行再重启）。详见根 [README](../README.md)。

## 测试

`node test/audit.mjs`（**94 项**断言：传输适配 A、会话生命周期 S、client 状态机 C、自开销工具 U、project_files P；3 项受限环境 SKIP）。

## 已知取舍

- 不重建技能市场、创作台抽屉与预设引导。
- 芯片不用 Godot 官方图标（避免内联 SVG）；归属见 [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
- host 半自做 MCP 握手，不引 SDK；保留一处版本相关：`/godot-ai/status` 端点（可配 `statusPath`）。

---
**署名**：deepseek-flash ｜2026-10-16 ~ 2026-10-22；glm-5.3-flash ｜2026-10-25 补 project_fs 工具说明、成本量级与测试数；glm-5.3-flash ｜2026-10-25 工具改名 project_files（query/remove→find/delete）
