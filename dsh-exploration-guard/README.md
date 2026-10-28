# dsh-exploration-guard

**一句话**：按**任务进展**熔断探索黑洞——连续 N 个 agent-loop step 没有推进任务节点，就否决非进度工具调用；再拖到 M 步，只剩"记任务 / 报告 / 求助"还能调。

## 病征（为什么不是"重复调用"）

DeepSeek 系模型在卡住时不会原地重复同一调用，而是**不断换新调查**：找源码、解压会话、写临时脚本、换假设、再找一次——每一步都"有产出"，但任务节点一动不动。用"同参数连续"判据抓不到它，因为参数每次都在变。

所以判据换成**任务进展**：

- 计数单位 = `agent/pre-step`（agent-loop 的 step，不是 turn）。
- 进展 = 真的推进了任务节点：
  - `todo_write`：`completed` 计数比上次多（首次建表也算一次进展，避免开局就被拦）
  - `update_goal`：`action` 为 `complete` / `blocked`
  - `create_goal`：新建目标
- 连"同一个列表原样重写"都不算进展（只改了措辞不算推进）。

## 两档熔断

| 档 | 触发 | 行为 |
|---|---|---|
| soft（默认 15 步） | 距上次进展 ≥ `softSteps` | **否决非进度工具**，理由即提醒：先标完成/补下一步，或报告阻塞 |
| hard（默认 25 步） | ≥ `hardSteps` | 只放行 `allowAlways`（`todo_write` / `get_goal` / `create_goal` / `update_goal` / `ask_user_question` / `meta_route` / `meta_sign`），其余一律否决并要求 Owner 授权 |

否决发生在 `ctx.tools.guard()`：同步、单调、不可翻案，理由作为工具错误回到模型手里——**不注入消息、不占用户发言位、不碰 llm/stream**。

**文案语言**：Loops（模型面）按惯例**只用英文**——否决理由固定为英文，不随界面语言切换；中英双语只出现在设置面板上。

- soft：`No task progress for {steps} steps (soft={soft}). Advance the task before continuing: mark finished todos completed with todo_write, add the next step, or report progress/blockers with update_goal; if you are truly stuck, tell the Owner what blocks you.`
- hard：`No task progress for {steps} steps: tool calls are temporarily blocked (hard={hard}). You may only update the task list or goal, or ask the Owner for authorization. Do not start new investigations.`

**被 hard 拦住后怎么自救**：唯一出路是让 `completed` 数**增加**（`todo_write` 新增/标记一个完成项）或 `update_goal` 走到终态；把同一张表原样重写不算。若一步里同时发 `todo_write`（推进）和后续调用，后者看到的是同一 step 内的 `since = 0`，会被放行——这是有意留的"记完就干"通道。

## 例外（不算无进展）

- **等 Owner**：agent 进入 `idle` 时计数清零（`resetOnIdle`，默认开）。
- **进度工具本身**：永远放行，否则模型被拦住后无法自救。
- **无任务清单**：默认按无进展计时（`noTaskMode: 'count'`）；设 `'skip'` 则只对建过任务表的会话计时。

## 设置界面

设置 → **探索熔断**（`settings.section`，order 640）里有五个开关/数值：启用、软阈值、硬阈值、"无任务清单时"口径、等待 Owner 时清零。保存即写入 `$DSH_HOME/exploration-guard/config.json` 并**立即生效**（守卫每次调用读同一份可变配置，无需重启）。

- 面板后端：`GET/POST /exploration-guard/api/config`（宿主 `webServer.register`）。
- 优先级：**文件值覆盖 patch 里的初始 config**；patch 只作出厂默认。
- 数值校验：step 阈值取 1–500 的整数；`hardSteps` 低于 `softSteps` 时自动抬到 `softSteps`。

## 存储与隐私

- **文件内容**：`$DSH_HOME/exploration-guard/config.json`，`JSON.stringify(values, null, 2)` 后以 **UTF-8（无 BOM）** 写出；纯 ASCII、两空格缩进，实测 40 字节。只写**改过的键**（sparse），不含路径、时间戳、会话 id、用户名。
- **面板显示**：只显示符号路径 `$DSH_HOME/exploration-guard/config.json`，**不显示 `C:\Users\...`**。
- **API**：`file` 字段是符号路径；宿主异常只回 `{ok:false,error:'settings request failed'}`，异常正文（可能含绝对路径）只写宿主日志。
- **回归**：夹具断言响应既不含测试 home 目录，也不含 `Users`。

## 配置（patch 兜底）

profile 的 `cordis.patch.yml` 按 id 覆盖（整行 config 整体替换，要保留的键需列全）：

```yaml
- id: exploration-guard
  name: dsh-exploration-guard
  config:
    enabled: true
    softSteps: 15
    hardSteps: 25
    noTaskMode: count
    resetOnIdle: true
```

`enabled: false` 即整机关闭（等效于回到未安装状态）。

## 安装 / 回滚

```
dsh plugin --profile desktop add link:D:/游戏开发/项目/工程/dsh-plugins/dsh-exploration-guard
dsh plugin --profile desktop remove dsh-exploration-guard
```

## 回归

```
node dsh-plugins/dsh-exploration-guard/test/run.mjs    # 8 条夹具
```

覆盖：阈值以下放行、soft 档否决与非进度工具豁免、首次建表算进展、完成数增量判定（原样重写不算）、hard 档文案与 `allowAlways`、idle 清零、`noTaskMode: skip`、开关关闭 / 无 agent / 跨 agent 隔离。

## 边界

- 只认**任务节点**（todo / goal）为进展；写文件、读文件、跑测试都不算——这符合 Owner 的口径"没有推进任务节点即无进展"。
- 不判断探索是否"有价值"：它只度量"有没有落到任务上"。
- 不结束回合、不取消 agent、不写会话事件。
### 文案契约（Owner 2026-10-28）

受限时模型最容易犯的错是"重写同一张清单然后继续"，所以文案必须同时回答两件事：

| 必须说 | 内容 |
|---|---|
| 什么**无用** | 重写同一张 todo 清单（`completed` 不增加就不算进展）、继续读/写/跑 shell |
| 什么**有用** | 把**真正做完**的事标 completed、`update_goal` blocked、问 Owner |
| 什么**禁止** | 为了让拦截放过而假标完成——文案明写 `never mark work complete just to unblock` |
| 现状锚点 | 带上 `completed=N` 与 `step(s)` 计数，模型才知道差多少 |

现行两条（英文，Loops 侧唯一语言）：

```
soft: Blocked: {steps} step(s) since the last completed todo (soft={soft}, completed={done}). Rewriting the list does not count. Honest ways out: mark a genuinely finished item completed, update_goal blocked, or ask the Owner. Other tools are refused.
hard: Blocked: {steps} step(s) (hard={hard}, completed={done}). Only honest progress passes: mark a genuinely finished item completed, update_goal blocked, or ask the Owner — never mark work complete just to unblock. Everything else is refused.
```

实机验证（把 soft 临时降到 1）：soft 档返回上面第一条、hard 档返回第二条，两条都自带"该做什么"，恢复阈值后 `{"softSteps":15,"hardSteps":25}`。