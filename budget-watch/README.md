# @dinwlooc/dsh-budget-watch

DSH 的**只提醒、不中断** token 预算看门狗。预算口径（与项目 `AGENTS.md` 一致）：直计费模型计 `billed = 未命中缓存输入 + 输出`，套餐模型计 `quota = input + output + cacheRead + cacheWrite`，两者之和与 `granted` 比较。**输出是给模型的 token 钟，不是账单**：`budget_status` ≤3 行，不回显单价表与账本内部字段。

## 为什么

AI 自觉查预算在长会话里会静默失效（本项目实测过 +10M 任务花掉 13.1M）；而每次自查 `usage_report` 本身要花一个完整请求。本插件把"记账 + 阈值提醒"变成确定性行为，但不接管决策、不阻断流程。

## 行为

- **预算由模型填报**：Owner 用自然语言发放预算（如 "+10M tok"）后，模型必须调用 `budget_register({ tokens: 10000000 })`；插件不做自然语言解析。
- **自动发放（0.3.0）**：① **新会话**（账本里还没有任何发放）在第一次请求时静默按 `autoRegisterTokens`（默认 1M）登记一次；② **超量之后**（超量当轮即计入），若连续 **两轮**（turn，不是 step）没有新的 `budget_register`，就在**下一轮开头的请求**里再自动登记一次，并追加一条短说明（`已自动登记 granted=…`）——说清这是自动兜底，不是新一轮 Owner 发放。轮次只看每轮第一次请求，同一轮里的多个 step 不推进计数；显式 `budget_register` 会清掉计数。
- **记账**：从 `llm/stream` 的 usage chunk 累加，每会话一本账（`$DSH_HOME/budget-watch/<sessionId>.json`），重启/压缩不丢。
- **阈值提醒走 developer 通道**：默认只在 **80%** 提醒一次，英文、一句话：`[budget-watch] Used: <已用 token> tokens. Prepare to wrap up.`。写入方式是 `session.append('developer/message', …, {surfaceOp:'append'})`（role=developer），**不写用户消息**——用户通道只留给 Owner。送不出去（无 `session.append` / 抛错）就不标记阈值，下一步重试。**时机有硬约束**：提醒只在 `agent/request` 写入——该事件由 agent loop 在 `step()` 内触发，此时 `step/start` 已落盘。写在 `agent/pre-step` 会排在 `step/start` 之前，V4 校验器判 `developer/message does not match an open turn and step`，重启后整个会话读不出来（实测 264 个会话中 3 个因此损坏）。回归夹具里有 `no agent/pre-step writer` 一条专守此事。不改 system prompt / 工具 schema，前缀缓存不破。
- **永不中断**：不 reject、不 throw、不拦 `llm/stream`、不拦工具；100% 也只是说"必须收尾并汇报"。
- `budget_status` 是**一行 token 钟**：`session=<id> granted=… used=… remaining=… pct=…`；有模型数据时追加一行 `money≈¥… | <model>=<tok>[hit/miss/out]≈¥/M`。不再回显单价表、baseline、grants、announced 等内部字段。
- **按会话隔离**：两个工具默认只作用于**调用方会话**；`budget_status({ sessionId })` / `budget_register({ tokens, sessionId })` 可显式指向另一个会话（父会话查子代理账本即走这条），`sessionId` 只接受 `字母数字 . _ : -`，穿越串直接拒绝。
- `remindUnregistered` 打开时，未登记预算且已有用量会提醒一次 `budget_register`（默认关闭）。

## 峰值感知（0.1.2）

累计值只回答"用了多少坐标"，回答不了"哪一次烧得凶"。账本因此额外维护 `burn`（最近 12 次 provider 调用的预算单位增量，直计费=billed、套餐=quota），`budget_status` 第二行尾部给出：

```
| last=+700 peak=+700@3/3 burst=7x
```

- `last`：上一次调用的花费；`peak`：窗口内最大的一次及其序号；`burst = peak / median`。
- 判据：`burst ≥ 3` 说明当前窗口有明显尖峰（通常是一次超长读取或一次批量调用），是"先收尾再继续"的信号。

## 已知缺口（不能发布的原因）

它现在只做到**消耗坐标 + 峰值坐标**，还缺两层，缺了就不算完整：

1. **tok 计权**：三档单价（hit/miss/out）已在金额行体现，但没有折算成单一的"加权单位"反馈给模型，模型看到的仍是三列原始数。
2. **任务难度加权**：没有难度输入，就无法区分"这一峰是任务本来难"还是"这一峰是我自己失控"。缺它，任何阈值都只能给绝对值，无法自适应。

这一层需要先定输入契约（例如 `budget_register({ tokens, difficulty })` 或按任务类型取默认权重），否则任何加权都是拍脑袋。定契约之前不发布。

## 安装

```
plugin_manager(action="install_bundle", target="<仓库根>\\.dsh\\budget-watch\\plugin")
```

已安装后改代码：`set_bundle` 关闭再启用（host 代码热载）。

## 配置（`cordis.patch.yml` 的 `budget-watch` 行）

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | true | 总开关 |
| `thresholds` | `[0.8]` | 插话阈值（每档一次） |
| `remindUnregistered` | false | 未登记预算时提醒一次（`autoRegister` 打开时基本用不到） |
| `autoRegister` | true | 自动发放：新会话按默认额度登记；超量后连续两轮无登记则下一轮开头补发 |
| `autoRegisterTokens` | 1000000 | 自动发放的额度（raw token），如 1M |
| `homeDir` | `$DSH_HOME` | 账本根目录（账本在 `<homeDir>/budget-watch/<sessionId>.json`） |
| `prices` | 见下「金钱感知」 | 分档单价表：`[[前缀, {hit,miss,out}]]` 或 `{前缀: {hit,miss,out}}`，`¥/1M token`；套餐模型写 `{subscription:true}` |
| `defaultRates` | flash 三档价 | 未归因 token（`?` / `provider:xxx`）的估价，**绝不按 ¥0 处理** |
| `usdToCny` | 7.1 | 仅供文档/换算备注，不参与计算 |

## 字段语义判别（2026-10-30 修复）

provider 的 usage 有两种语义并存，旧实现只认包含式，遇到分离式会把未命中输入整段丢掉：

| 语义 | 判据 | 未命中 |
|---|---|---|
| 分离式（DeepSeek 实测） | `totalTokens = input + cacheRead + output + write` | `inputTokens` 本身 |
| 包含式 | 上式不成立 | `max(0, input - cacheRead)` |

判别用 `totalTokens` 的加法同一性（容差 ±1）；provider 报的 `totalTokens` 优先作为总量。实测影响：本会话 159 次调用真实未命中 134,724，旧口径记成 10,209（漏 92%），billed 由 268,844 被读成 144,329。

## 金钱感知（2026-10-27，Owner 口径 + 官方价目表）

- **计费分三档**：缓存命中输入（hit）/ 缓存未命中输入（miss）/ 输出（out）；cacheWrite 按 miss 价计。
- 单价来源：`api-docs.deepseek.com/quick_start/pricing`（USD/1M，峰值价；off-peak 为其一半）。按 ¥7.1/$ 折算后的默认表：
  - `deepseek-flash`: hit ¥0.043 / miss ¥2.13 / out ¥8.52
  - `deepseek-v4-pro`: hit ¥0.31 / miss ¥9.37 / out ¥28.12（约为 flash 的 3~7 倍）
  - `glm`: `{subscription:true}` —— 订阅制，**不可折算**，单列不参与求和（既不算钱也不算免费）
- 目标是**暴露原料让模型自己画性价比曲线**，不是替模型下结论：`budget_status` 末行给出前两名模型的 `hit/miss/out` 占比与折算后的 `≈¥/M`，模型据此判断「多读一个文件 / 多开一个子代理 / 换便宜模型」的边际成本。为保持 token 钟短小，只保留前两名模型，且不回显单价表。
- `money≈¥X attr NN%`：`attr` 是已归因 token 占比（100% 时省略）；未达 100% 时该数字是**下界**，`*` 标出的是按 defaultRates 估的未归因桶。
- 折算不改变预算判定：预算仍按 billed+quota 原始 token 与 granted 比较；¥ 只是同一账本的另一种读法。80% 提醒行保持纯 token、保持单行（前缀缓存纪律）。
- **单价唯一权威 = 本插件 `prices` 配置**；AGENTS/meta 里的数字只是量级提示，避免多处漂移。

## 折算关系源（0.4.0，Owner 2026-11-06）

- **只取比例，不取金额**：从 `https://models.dev/api.json` 读各模型的 input / cache_read / output / cache_write，除以 input 归一成 `hit / miss=1 / out / write`。币种、每百万单位、高峰倍率在相除时全部抵消——这正是折算需要的口径。
- **优先级**：`config.prices` 明示 > models.dev 比例 > `defaultRates`（flash 比例）。配置里写了价就永远以配置为准，不会被远程数据覆盖。
- **不编数**：同模型多 provider 报价冲突、结构不符、拉取失败 → 一律不入账，退回上一层。冲突条目数可在 `rates.state()` 看到。
- **缓存与离线**：比例写 `<home>/budget-watch/rates-cache.json`（默认 TTL 24h，`ratesRefreshHours` 可调）；缓存命中即离线可用。设 `DSH_BUDGET_WATCH_OFFLINE=1` 可完全禁网。
- **展示金额不变**：面板里的 ¥ 仍按 `config.prices` 计算；本次只改「折算成等效 miss token」的比例口径。

## 账本

`$DSH_HOME/budget-watch/<sessionId>.json`：`{ sessionId, sessionTotal, cost{billed,quota}, models{}, task{...}, unregisteredNotified, updatedAt }`。
预算恢复/重启不丢；删文件即清空该会话账本。

**一个会话只有一个账本文件。** DSH 升级前后 `session.id` 有两种形态（`session-<uuid>` 与裸 `<uuid>`，主会话与子代理各用其一），插件按「同会话的两种候选路径」解析：先找 `<sessionId>.json`，再找另一种前缀形态，命中哪个就固定写回哪个，绝不为同一会话新建第二个文件。读取时以文件内的 `sessionId` 为准（它才是账本的真实身份），因此用裸 id 也能读到旧的 `session-*.json`。

## 测试

```
node test/run.mjs
```

48 组假 ctx 断言：无 grant、阈值各一次、**提醒只写 developer/message 且不碰用户消息**、**提醒只挂 agent/request、不挂 agent/pre-step（顺序契约）**、提醒携带当前已打开 step 的坐标、送不出去时下一次请求重试、去重、重新登记重置、非法参数、落盘、三档折算、未归因桶按 defaultRates 计价、订阅模型单列、provider 不作价格键、旧账本（无 models）不抛错、脏单价行丢弃并告警、**输出紧凑（≤3 行，无单价表/账本明细）**；自动发放三组——**新会话静默登记 1M**、**超量后同轮的多个 step 不推进轮数、连续两轮无登记才在下一轮补发且只说明一次**、**显式登记清掉计数**；会话维度另测四组——**并行会话互不串账、显式 sessionId 跨会话只读、旧 `session-*.json` 可被裸 id 读到且写回同一文件（不分裂）、穿越型 sessionId 被拒**。

## 已知边界

- 不解析自然语言 grant——依赖模型调用 `budget_register`（AGENTS 已写明该义务）。
- 记账来自 `llm/stream` 的 provider usage chunk：只统计带 `sessionId` 的请求；压缩、标题生成等内部调用不计入（与 `dsh-budget-guard` 的豁免同向）。
- 重试可能让同一请求的 usage 多次计入（provider 每次尝试都可能报），方向是**偏高估**（早提醒，不会漏报）。
- 会话中途安装时，安装前用量不计入；每次 `budget_register` 重设基线，只统计登记之后的用量。
- **子会话/子代理各自独立记账**（按 session id，实测：子代理 `budget_status` 看到的是自己的裸 uuid 账本，不是父会话的 `session-*.json`）。父会话要查子代理账本，用 `budget_status({ sessionId })` 显式指定。
- `sessionId` 显式参数只改「看哪本账」，不改归属：无 `session.id` 且未显式传入时，两个工具失败关闭而不是写进共享的 `unknown` 账本。
- **每模型拆分自升级后开始累计**（`models` 字段）；升级前已用量的 ¥ 会漏计（显示为 `?` 桶），`session_total` 仍是全量。这是记账口径的已知偏差，不是漏账。
- 模型名取自 `llm/stream` 的 `options.model`（provider usage chunk 本身不含模型名）；拿不到时记 `provider:xxx` 或 `?` 桶，按 `defaultRates` 估价并标 `*`，绝不按 ¥0 处理。
- 插件只提醒；是否收尾、是否申请预算仍由模型/Owner 决定。
- 提醒的 source 复用 `cordis-host-runner`（`MessageSource` 是闭集，没有插件专用 kind）；会话上下文浏览器里因此显示为 `inject / cordis-host-runner`，不是 `user`。要换标签就得改 Harness 的类型闭集。

## 实测

- 安装后 `budget_register` / `budget_status` 可用，账本落盘 `$DSH_HOME/budget-watch/<sessionId>.json`。
- 1 token 预算冒烟：超过 80% 阈值后下一步收到单行 `[budget-watch] Used: 1 tokens. Prepare to wrap up.` 的 user 消息，流程未被阻断；随后重新登记恢复正式预算。
- 输出体积（2026-10-29 重构）：`budget_status` 由 5 行降为 ≤3 行；删去每次都重复的单价表，以及 `baseline/grants/announced` 等只对账本自检有用的内部字段。

**署名**：deepseek-flash ｜2026-10-24

## 缓存命中折算面板（会话标题栏，纯 GUI）

- 客户端 `client.js` 挂在 `conversation.session.header.actions`（渲染回调无 props，与 `godot-creator-ui` 同形），轮询 `/api/budget-watch/panel`，显示「单步缓存命中折算消耗已达冷启动的 x%」（悬停给出冷启动折算值与预算占比）；无冷启动基准时照常显示 0%。
- 同一模块另挂 `settings.general.item`（id `budget-watch-settings`）：「预算看门狗」卡显示本会话预算、自动发放开关与额度、补发轮数、提醒阈值。
- 客户端不带会话 id 时只请求 `/api/budget-watch/panel`，宿主回退到最近一次 `agent/request` 的会话；`package.json` 必须导出 `./client`，缺这条时客户端半边根本不加载（头部与设置都不会出现）。
- 冷启动基准 = 第一次出现「已在动工」的工具调用（编辑类 `write`/`edit`，以及工具检索系列 `tool_search`/`tool_describe`/`tool_call`）那一刻的累计折算值，即这个任务「从准备到动工」的总折算 tokens，即冷启动一次的花费；单步占比 = 本步缓存读取的折算值 ÷ 冷启动基准。
- 判读方式：占比 10% ⇒ 约 10 步 loops 的开销等于重开一个新会话（Harness 平均每轮 10~11 步），可据此决定是否重启会话。
- 阈值默认 `[0.05, 0.10]`：5% 提示压缩步数（合并调用、减少探索、多问 Owner），10% 要求停止文件输出；每档每会话提醒一次。
- 不注册任何模型面工具，面板数据只走 HTTP 路由。
- 预算提醒阈值同时改为 `[0.6, 1.0]`（60% 加速提醒，100% 中止提醒），默认发放 100k。
