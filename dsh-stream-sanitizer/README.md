# dsh-stream-sanitizer（RETIRED）

> **已退役（2026-10-29）**：插件角色由社区件 **`dsh-healer@0.1.0`** 取代（`llm/stream` wire 层修复，规则 `tool-call-name` 剔除空工具名块、`orphan-tool-result` 清孤儿结果、400 自愈并重试一次，且能救**已被毒化的旧会话**）。
> 本插件已 `remove_bundle`，不再装配；`package.json` 保留仅作历史。
> **仍在使用**：`scripts/` 下的会话扫描/修复工具（扫全库 242 会话、修 13 个空 id 会话靠它们）——它们不依赖本插件。
> 残留风险：healer 按**空 name** 剔除整块；若将来出现"id 空、name 非空"的畸形响应，它不覆盖（该形态未实测出现过）。

**一句话**：在 `llm/stream` 瀑布里把**空 tool-call id** 补齐，让 provider 的畸形响应无法再写坏会话日志、锁死对话。

## 病根（已核到源码）

1. provider（GLM 4.6V 实测两次）把 tool call 的 `id`（有时还有 `name`）发成空串。
2. 适配层 `dsh-llm-pi-ai` 原样透传：`block-end` 的 `block.id = brandString(event.toolCall.id)`，**没有兜底**。
3. agent-loop 用这个 id 构造 `tool/result`：`createToolResultMessage({ callId: block.id })`。
4. 写盘校验 `dsh-session-format-v3-to-v4` 拒绝空 id：`toolCallId.length === 0` 与"不匹配"共用一条报错文案。
5. 失败结果写不进去 → 每次恢复都从那条 `assistant/message` 重新发现"待执行调用" → **同一会话永久卡死**。

## 修法

只补 id，别的一概不动：

- `tool-call-delta` / `block-end` 里 id 为空 → 分配**本流稳定**的合成 id（同一 `index` 的所有 chunk 用同一个）；
- `name` 为空不动——上游照常报 `unknown tool`，但带着非空 id 落盘，回合正常结束，**会话存活**；
- 其它 chunk（text/reasoning/usage/finish）原样透传；任何异常都原样透传，绝不让清洗器把正常流弄坏。

合成 id 形如 `call-synth-<时间36进制>-<index>-<序号>`，在日志里一眼能认出是本地补的。

## 验证

- 回归：`node dsh-plugins/dsh-stream-sanitizer/test/run.mjs` → **7/7**
  （空 id 补齐、跨 chunk 同 id、正常 id 不动、空 name 不动、非工具 chunk 透传、计数、apply 接线与关闭透传）。
- 运行期：`GET /stream-sanitizer/api/stats` 返回 `{enabled, stats:{fixed, streams, lastFixAt, lastIndex}}`；`fixed` 就是"这轮救了几个 id"。

## 安装 / 回滚

```
dsh plugin --profile desktop add link:D:/游戏开发/项目/工程/dsh-plugins/dsh-stream-sanitizer
dsh plugin --profile desktop remove dsh-stream-sanitizer
```

## 边界

- **只防新的**：已经写坏的会话它救不了，那需要 `dsh-session-repair` 的「备份并修复」。
- 不重发请求、不换模型、不改 arguments、不删块。
- 不改变"空 name 的工具调用会失败"这一事实——只是把"整会话卡死"降级为"本轮报错"。
## 脚本（历史修复）

```
node dsh-plugins/dsh-stream-sanitizer/scripts/scan-all-sessions.mjs "$env:USERPROFILE/.dsh/sessions"
node dsh-plugins/dsh-stream-sanitizer/scripts/repair-empty-toolcall.mjs <session.v4.jsonl.zstd> [--apply]
```

- 扫描只读，列出所有含空 tool-call id 的会话（seq + 类型）。
- 修复默认 dry-run；`--apply` 才写盘：先 `.bak-<epoch>` 备份，再删空 tool-call 块与配对空 `tool/call`，单帧重压、原子替换，最后重解码自检。
- 多帧 zstd 由脚本自己按帧头 + block 头拆分（Node 的 `zstdDecompressSync` 只解第一帧）。