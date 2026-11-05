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
| soft（默认 15 步/次） | 距上次进展 ≥ `softSteps`（**只按步**） | 原生：**否决非进度工具**；PTC：**不打断正在跑的程序**，警告**追加**在该次 `run_code` 结果末尾 |
| hard（默认 25 步/次） | ≥ `hardSteps` | 只放行 `allowAlways`（`todo_write` / `get_goal` / `create_goal` / `update_goal` / `ask_user_question` / `meta_route` / `meta_sign`），其余否决；**PTC 下额外关闭 `run_code` 本身** |

**PTC 与原生分档（v0.5.3；v0.5.4 起首次长告警）**：软阈值对 PTC **只警告不拦截**——批量程序被打断的代价高于多跑几个调用，模型的典型反应还是盲目重试。警告**追加**在这次 `run_code` 结果的内容块末尾（原输出原样留在前面）：不覆盖返回值、不另发消息、不改状态位——覆盖返回值等于篡改工具输出，发独立消息则与工具结果的顺序/状态对不上。硬阈值才真关闸，关的是 `run_code` 入口（已开跑的程序照跑完），文案刻意不同（`run_code is closed at the hard threshold …`），免得模型把「入口被锁」误读成「程序内某调用被拒」。

**计量单位（v0.5.3）：只按步**。`since = 当前步 - 上次进展步`。一段 `run_code` 程序算一步，程序内多少次嵌套调用都不推进熔断——**程序是原子的**，按调用数计会惩罚「一个程序做一批事」这种本来最省的做法；PTC 侧真正兜底的是硬阈值对 `run_code` 入口的锁（迟到一步，但状态一致）。原生模式下一次调用≈一步，两种口径等价。

否决发生在 `ctx.tools.guard()`：同步、单调、不可翻案，理由作为工具错误回到模型手里——**不注入消息、不占用户发言位、不碰 llm/stream**。

**文案语言**：Loops（模型面）按惯例**只用英文**——否决理由固定为英文，不随界面语言切换；中英双语只出现在设置面板上。

- 原生 soft / hard：见 `messages.js` 的 `softBlock` / `hardBlock`（Blocked: … 句式）。
- PTC soft 告警：`Progress warning: …`（追加在结果末尾，不是错误）。**每会话首次越线是长文案**：一次把理由讲透（无规划探索 → 硬阈值锁死 `run_code`；先有预期再探索，不要等提醒才补 todo；三条重置路径：`todo_write` 新的完成项 / `update_goal` 到终态 / 问 Owner），之后同一会话再越线只追加短提醒；PTC hard：`Blocked: run_code is closed at the hard threshold …`。

**被 hard 拦住后怎么自救**：唯一出路是**出现新的完成项**（`todo_write` 中 `status=completed` 条目的**内容签名**此前没出现过）或 `update_goal` 走到终态；把同一张表原样重写不算。**v0.5.2 起按身份集判定**：只比 `completed` 计数会被「重写清单时删掉旧完成项」骗死（计数不变，永远解不开）。若一步里同时发 `todo_write`（推进）和后续调用，后者看到的是同一 step 内的 `since = 0`，会被放行——这是有意留的"记完就干"通道。

## 例外（不算无进展）

- **等 Owner**：agent 进入 `idle` 时计数清零（`resetOnIdle`，默认开）。
- **进度工具本身**：永远放行，否则模型被拦住后无法自救。
- **无任务清单**：默认按无进展计时（`noTaskMode: 'count'`）；设 `'skip'` 则只对建过任务表的会话计时。

## 读取整形（v0.4.0，可关）

Owner 的观察：**全文 `read` 是上下文成本的主项**，而模型又习惯在 `edit`/`write` 之后重读整个文件确认改动。所以本插件在自己的 `tools/post-execute` 里加了一段纯读取整形：它**不改变熔断的计数与阈值**（`ctx.tools.guard` 一行未动），但和熔断共用整机开关 `enabled`——把 `enabled` 关掉，熔断与整形一起停（三个读取开关仍在面板上，此时点它们不会有作用）。五个读取开关在同一张设置卡片里：

| 开关 | 默认 | 行为 |
|---|---|---|
| Markdown 全文读 → 标题大纲 | 开 | 无 `offset`/`limit` 的 `.md`/`.mdx` 读，≥ `outlineMinLines`（默认 80）行时只回 `#` 标题 + **每节的行区间** |
| GDScript 全文读 → 成员表 | 开 | 同上，`.gd` 只回第 0 列的 `class_name`/`extends`/`class`/`signal`/`enum`/`const`/`var`/`func`（含 `@export` 等注解）；函数体里的缩进局部变量永不计入 |
| 编辑后重读 → 编辑窗口 | 开 | 同会话里刚 `edit`/`write` 过的文件再被全文读时，只回锚点行上下共 `verifyRegionLines`（默认 24）行 + 总行数 + 指纹 |
| 整形最小行数 | 80 | 小于它的文件原样返回 |
| 编辑窗口行数 | 24 | 窗口总行数（不是单侧） |

**永远可逆**：`offset`/`limit` 的显式范围读**永不被整形**；大纲条目带"起行-止行"（末节终点即文件尾行，模型看不到正文时尾行只有这里给），末行只写**选读意图**——不给可照抄的整文件命令：示例照抄出来就是"再读一遍全文"，把整形教成了绕行通道。

**绝不说谎的判定顺序**：只对 `kind==='accept'`、无 `value`、`isError!==true`、参数里**没有** `offset`/`limit`、会话工作区已知（`agent.session.header.cwd`，不猜进程 cwd）、文件可读、结果含文本块、整形后**严格更省**（大纲 ≤ 原文 60%、窗口 ≤ 70%）的读生效；任何一步不满足就原样放行。`.md` 的围栏代码块里的 `#` 不算标题，`utf8 BOM` 先剥掉（否则第一行标题会整条消失——实测事故）。

**已知边界**：`.md`/`.gd` 之外的扩展名不整形；锚点必须逐字出现在文件里才出窗口，否则退回大纲或原文；锚点一次性消费（第二次全文读不再给窗口）；`edit`/`write` 的锚点按会话隔离、20 分钟过期、最多 16 个路径。

## grep 摘要（v0.4.1，可关）

`grep` 的单次开销来自**命中条数**而不是行长度（实测本项目：代码命中行 avg 52–62 字符、p90 104、max 192；`.md` 命中行才长，avg 152 / max 323）。而宽泛搜索动辄上千命中：`var ` 在 `project/**/*.gd` 里是 2081 条、171 个文件，工具只返回前 250 条。

所以对**命中数 ≥ `grepSummaryAfter`（默认 80）** 的 grep，改回一份索引：

```
[exploration-guard grepSummary] Index, NOT all matches: showing 250 of 2081 matches, 26 files in this listing. This listing saved to: <spill 路径>
(The complete result could not be saved; narrow pattern, path, or include to see more.)   ← 工具自己的括注原样带上来
path/File.gd (37 matches)
Line 4: @onready var vbox_container: VBoxContainer = $VBoxContainer
Line 6: ...
Line 8: ...
+34 more at lines 10, 12, 14, ...          ← 行号一个不丢
```

要点：

- **每文件只留前 3 条原文**（`grepPerFile`，面板可调），其余只给行号——想读哪行就 `read file_path=<文件> offset=<行> limit=<n>`，想再搜就收窄 `path`/`include`。
- **索引自身必须小**：最多列 40 个文件（其余一句 `+N more files` 指向 locator）、总行数 ≤ 200；稠密文件（>20 条）只留 1 条样例，>100 条只给行号。原因很实在：`dsh-plugin-save-token` 对 >240 行的工具输出还有一道 head/tail 窗口，索引要是超过它就会被二次裁掉。
- **无损可取**：本次 grep 的完整输出**逐字**写进 spill（`spillStore`），摘要第一行就给该路径 + 真实行数（`offset=1 limit=<总行数>`）；工具自己另存的那份（若有）也一并列出。输出 >512KB 时不落盘、不整形（省下的上下文换成几 MB 临时文件不划算）。
- **识别工具自身的截断**：`Found 250 of 769 matches` 这种头也能摘要，且明细条数必须与 `of` 前的数字相等才动手；对不上（例如被其它插件裁剪过）就原样放行。
- **never-worse**：摘要至少省 25%，否则给全量。
- 命中数低于阈值、无 `spillStore`、认不出格式、开关关闭 → 一律原样。

## 设置界面

设置 → **探索熔断**（`settings.section`，order 640）里有十二个开关/数值：启用、软阈值、硬阈值、"无任务清单时"口径、等待 Owner 时清零、Markdown 大纲、GDScript 成员表、编辑后窗口、整形最小行数、编辑窗口行数、grep 摘要、grep 摘要阈值。保存即写入 `$DSH_HOME/exploration-guard/config.json` 并**立即生效**。

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
    outlineMd: true
    outlineGd: true
    verifyRegion: true
    outlineMinLines: 80
    verifyRegionLines: 24
    grepSummary: true
    grepSummaryAfter: 80
```

`enabled: false` 即整机关闭（等效于回到未安装状态）。

## 安装 / 回滚

```
dsh plugin --profile desktop add dsh-exploration-guard      # 从 npm
dsh plugin --profile desktop add link:/abs/path/to/dsh-exploration-guard   # 从本地源码
dsh plugin --profile desktop remove dsh-exploration-guard
```

## 回归

```
node dsh-plugins/dsh-exploration-guard/test/run.mjs   # 14 条熔断夹具 + 12 条读取/grep 整形夹具
```

覆盖（v0.5.4：14 条熔断夹具）：会话首次软告警是长文案且只出现一次（无内容块时不消费）、PTC 软档不打断 + 返回后告警、PTC 硬档锁 `run_code` 且文案独立、完成项身份判定（删旧项后新增仍算进展）、原样重写不算、阈值以下放行、soft 档否决与非进度工具豁免、首次建表算进展、完成数增量判定（原样重写不算）、hard 档文案与 `allowAlways`、idle 清零、`noTaskMode: skip`、开关关闭 / 无 agent / 跨 agent 隔离；以及 .md 大纲（围栏伪标题排除、正文不外泄、指纹与可照抄的逃生口）、.gd 成员表（缩进局部变量排除）、小文件/显式窗口/错误/非文本/读不到/无工作区一律原样、`edit` 后窗口（总行数+指纹+锚点逐字+窗口正好 `verifyRegionLines` 行+一次性消费）、`write` 后头部窗口（文案不说成 edited region）、`verifyRegion` 单独关闭、三个开关各自可关与配置 API 往返、BOM 文件首行标题不丢；grep 摘要（完整形态、`Found N of M` 截断形态、工具括注不当成文件、计数不符原样、无 store 原样、开关关闭原样、spill 内容逐字）。

跑夹具要用带 `node` 的运行时；本机 PATH 里没有 node，用 DSH 自带的：`C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`。

## 边界

- 只认**任务节点**（todo / goal）为进展；写文件、读文件、跑测试都不算——这符合 Owner 的口径"没有推进任务节点即无进展"。
- 不判断探索是否"有价值"：它只度量"有没有落到任务上"。
- 不结束回合、不取消 agent、不写会话事件。
### 文案契约

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