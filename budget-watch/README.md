# dsh-budget-watch

DSH 的**只提醒、不中断** token 预算看门狗。口径与项目 `AGENTS.md` 一致：`total = input + output + cacheRead + cacheWrite`（原始 token，无价格加权）。

## 为什么

AI 自觉查预算在长会话里会静默失效（本项目实测过 +10M 任务花掉 13.1M）；而每次自查 `usage_report` 本身要花一个完整请求。本插件把"记账 + 阈值提醒"变成确定性行为，但不接管决策、不阻断流程。

## 行为

- **预算由模型填报**：Owner 用自然语言发放预算（如 "+10M tok"）后，模型必须调用 `budget_register({ tokens: 10000000 })`；插件不做自然语言解析。
- **确定性记账**：从会话事件的 `assistant/message.usage` 重算，按 `turn:step` 去重；不持久化 used，不会漂移。
- **阈值插话**：只在 **80%** 插话一次，英文、一句话：`[budget-watch] Used: <已用原始 token> tokens. Prepare to wrap up.`。不含预算、剩余、阈值比率、后续提醒或"不中断"声明；追加在历史尾部，不改 system prompt / 工具 schema，前缀缓存不破。
- **永不中断**：不 reject、不 throw、不拦 `llm/stream`、不拦工具；100% 也只是说"必须收尾并汇报"。
- `budget_status` 随时查账（granted/used/remaining/pct），**首行固定回显 `session=<id>`**——并行开多个会话时，先看这一行就知道看的是谁的账。
- **按会话隔离**：两个工具默认只作用于**调用方会话**；`budget_status({ sessionId })` / `budget_register({ tokens, sessionId })` 可显式指向另一个会话（父会话查子代理账本即走这条），`sessionId` 只接受 `字母数字 . _ : -`，穿越串直接拒绝。
- 未登记预算且已有用量时，提醒一次 `budget_register`。

## 安装

```
plugin_manager(action="install_bundle", target="<仓库根>\\.dsh\\budget-watch\\plugin")
```

已安装后改代码：`set_bundle` 关闭再启用（host 代码热载）。

## 配置（`cordis.patch.yml` 的 `budget-watch` 行）

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | true | 总开关 |
| `thresholds` | `[0.5, 0.8, 1.0]` | 插话阈值（每档一次） |
| `remindUnregistered` | true | 未登记预算时提醒一次 |
| `homeDir` | `$DSH_HOME` | 账本根目录（账本在 `<homeDir>/budget-watch/<sessionId>.json`） |
| `prices` | 见下「金钱感知」 | 分档单价表：`[[前缀, {hit,miss,out}]]` 或 `{前缀: {hit,miss,out}}`，`¥/1M token`；套餐模型写 `{subscription:true}` |
| `defaultRates` | flash 三档价 | 未归因 token（`?` / `provider:xxx`）的估价，**绝不按 ¥0 处理** |
| `usdToCny` | 7.1 | 仅供文档/换算备注，不参与计算 |

## 金钱感知（2026-10-27，Owner 口径 + 官方价目表）

- **计费分三档**：缓存命中输入（hit）/ 缓存未命中输入（miss）/ 输出（out）；cacheWrite 按 miss 价计。
- 单价来源：`api-docs.deepseek.com/quick_start/pricing`（USD/1M，峰值价；off-peak 为其一半）。按 ¥7.1/$ 折算后的默认表：
  - `deepseek-flash`: hit ¥0.043 / miss ¥2.13 / out ¥8.52
  - `deepseek-v4-pro`: hit ¥0.31 / miss ¥9.37 / out ¥28.12（约为 flash 的 3~7 倍）
  - `glm`: `{subscription:true}` —— 订阅制，**不可折算**，单列不参与求和（既不算钱也不算免费）
- 目标是**暴露原料让模型自己画性价比曲线**，不是替模型下结论：`models:` 行给出每个模型的 `hit/miss/out` 占比与折算后的 `≈¥/M`，模型据此判断「多读一个文件 / 多开一个子代理 / 换便宜模型」的边际成本。
- `money≈¥X (attr NN%)`：`attr` 是已归因 token 占比；未达 100% 时该数字是**下界**，`*` 标出的是按 defaultRates 估的未归因桶。
- 折算不改变预算判定：预算仍按 billed+quota 原始 token 与 granted 比较；¥ 只是同一账本的另一种读法。80% 提醒行保持纯 token、保持单行（前缀缓存纪律）。
- **单价唯一权威 = 本插件 `prices` 配置**；AGENTS/meta 里的数字只是量级提示，避免多处漂移。

## 账本

`$DSH_HOME/budget-watch/<sessionId>.json`：`{ sessionId, sessionTotal, cost{billed,quota}, models{}, task{...}, unregisteredNotified, updatedAt }`。
预算恢复/重启不丢；删文件即清空该会话账本。

**一个会话只有一个账本文件。** DSH 升级前后 `session.id` 有两种形态（`session-<uuid>` 与裸 `<uuid>`，主会话与子代理各用其一），插件按「同会话的两种候选路径」解析：先找 `<sessionId>.json`，再找另一种前缀形态，命中哪个就固定写回哪个，绝不为同一会话新建第二个文件。读取时以文件内的 `sessionId` 为准（它才是账本的真实身份），因此用裸 id 也能读到旧的 `session-*.json`。

## 测试

```
node test/run.mjs
```

29 组假 ctx 断言：无 grant、阈值各一次、去重、reject 透传、重新登记重置、非法参数、落盘、三档折算、未归因桶按 defaultRates 计价、订阅模型单列、provider 不作价格键、旧账本（无 models）不抛错、脏单价行丢弃并告警；会话维度另测四组——**并行会话互不串账、显式 sessionId 跨会话只读、旧 `session-*.json` 可被裸 id 读到且写回同一文件（不分裂）、穿越型 sessionId 被拒**。

## 已知边界

- 不解析自然语言 grant——依赖模型调用 `budget_register`（AGENTS 已写明该义务）。
- 记账来自 `llm/stream` 的 provider usage chunk：只统计带 `sessionId` 的请求；压缩、标题生成等内部调用不计入（与 `dsh-budget-guard` 的豁免同向）。
- 重试可能让同一请求的 usage 多次计入（provider 每次尝试都可能报），方向是**偏高估**（早提醒，不会漏报）。
- 会话中途安装时，安装前用量不计入；`newTask` 之后只统计之后的用量（基线即登记时计数）。
- **子会话/子代理各自独立记账**（按 session id，实测：子代理 `budget_status` 看到的是自己的裸 uuid 账本，不是父会话的 `session-*.json`）。父会话要查子代理账本，用 `budget_status({ sessionId })` 显式指定。
- `sessionId` 显式参数只改「看哪本账」，不改归属：无 `session.id` 且未显式传入时，两个工具失败关闭而不是写进共享的 `unknown` 账本。
- **每模型拆分自升级后开始累计**（`models` 字段）；升级前已用量的 ¥ 会漏计（显示为 `?` 桶），`session_total` 仍是全量。这是记账口径的已知偏差，不是漏账。
- 模型名取自 `llm/stream` 的 `options.model`（provider usage chunk 本身不含模型名）；拿不到时记 `?`、按 ¥0 处理。
- 插件只提醒；是否收尾、是否申请预算仍由模型/Owner 决定。

## 实测（2026-10-24 本机）

- 安装后 `budget_register` / `budget_status` 可用，账本落盘 `$DSH_HOME/budget-watch/<sessionId>.json`。
- 用 1 token 预算做注入冒烟：下一步收到 `[budget-watch] … 已达 100% 阈值 … 插件不会中断你。` 的 user 消息，未阻断流程；随后 `newTask` 恢复正式预算。

**署名**：deepseek-flash ｜2026-10-24
