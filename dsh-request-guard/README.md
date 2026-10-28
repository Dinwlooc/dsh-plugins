# dsh-request-guard

**一句话**：把"一个畸形 tool-call 块搞死整条会话"这件事，在**三个层**同时堵住——写入层补 id、请求层修消息数组、错误层重试一次。

> English abstract: keeps a malformed provider response from wedging or poisoning a DeepSeek Harness session. Stage A fills empty tool-call ids on the write side; stage B repairs the outbound message array (nameless calls, orphan/stranded results, missing results, bad arguments); stage C retries a pairing/adjacency 400 once.

## 它防的是什么（有原始日志证据）

GLM 4.6V 两次实测：provider 把 tool call 的 `id` 与 `name` 都发成空串。

```
assistant/message   [text, tool-call(id:"", name:"")]
tool/call           callId="", name=""
                    ← 日志到此结束：没有 tool/result，没有 step/end，没有 turn/end
```

agent-loop 拿空 id 构造 `tool/result`，写入时被会话格式校验拒绝（空 `toolCallId`）→ 这一轮连收尾都没落盘 → 恢复时又从同一条 assistant 消息发现"待执行调用" → **永久卡死**。

## 三层

| 层 | 挂载点 | 规则 | 效果 |
|---|---|---|---|
| **A 写入层** | `llm/stream` 瀑布 | 空 `id` → 分配本流稳定的合成 id（同名块复用） | 错误调用带着非空 id 落盘，回合能收尾，会话存活 |
| **B 请求层** | 包装 `llm` 服务的 `stream()` | R1 空 `name` 的调用块剔除；R2 孤儿结果剔除；R3 丢结果的调用补合成错误结果；R4 重复/错位结果剔除；R5 非对象 `arguments` 归一为 `{}` | **已经被毒化的历史**也能再次发出去 |
| **C 错误层** | `agent/request-error` 瀑布 | 命中配对/邻接类 `INVALID_REQUEST` → 重试一次（每回合上限可配） | 让 B 的修复有机会生效 |

B 为什么不能挂在公开的 `llm/stream` 上：`@deepseek-ai/dsh-agent-loop` 对消息数组与 options 做了 `deepFreeze` / `Object.freeze`，监听器只能看、不能改。本插件包装**运行中的 `llm` 服务实例**的 `stream` 方法，给适配器一个**新的 options 对象**——不解析模块、不锁 `@deepseek-ai/dsh-llm` 版本，因此不会像打补丁的同类件那样被 peer 版本卡死。

## 配置

```yaml
- id: request-guard
  name: 'dsh-request-guard'
  config:
    enabled: true
    repairRequests: true   # B 层开关（false = 只做写入层）
    healOnRetry: true      # C 层开关
    maxHealsPerTurn: 1     # 每回合最多重试次数
    idPrefix: call-synth   # 合成 id 前缀，便于日志辨识
```

## 观测

`GET /request-guard/api/stats` → 各计数：

```json
{"ok":true,"enabled":true,"repairRequests":true,"healOnRetry":true,
 "stats":{"filledIds":0,"repairedRequests":0,"droppedNamelessCalls":0,
          "droppedOrphanResults":0,"droppedStrandedResults":0,"synthesizedResults":0,
          "normalizedArguments":0,"droppedAssistants":0,"retries":0,"streams":0,
          "lastRepairAt":null,"lastError":null}}
```

## 失败姿态

每一层都 **fail-open**：修流器或修消息抛错时原样透传，绝不让守卫本身弄坏一个本来正常的请求。B 层若拿不到 `llm` 服务，只记 `lastError`，A 层照常工作。

## 与其它件的关系

- **`dsh-healer`**（社区件）：请求层规则与 C 层思路的来源之一，但靠给 `LlmRuntime` 原型打补丁并锁 `dsh-llm 0.2.0-rc.2`；本插件以服务实例包装 + 无版本锁取代它，安装后应**卸掉 healer 并撤销版本豁免**。
- **`dsh-session-repair`**：用户主动的会话日志体检/修复，职责不同，可共存。
- **历史脚本**：`dsh-plugins/dsh-stream-sanitizer/scripts/` 里那套会话扫描/修复脚本不依赖任何插件，仍在用。

## 测试

```bash
node dsh-plugins/dsh-request-guard/test/run.mjs
# RESULT run.mjs: pass=10 fail=0
```

覆盖：干净历史零改动（同一数组身份）、R1–R5 各一条、整条 assistant 因只剩空 name 调用而被移除、混合结果消息只留存活块、A 层补 id 的稳定复用与不覆盖真实 id。
