# tools/session-repair

会话日志的**只读诊断**与**谨慎修复**脚本。它们不依赖任何 DSH 插件，直接读写
`$DSH_HOME/sessions/**/session.v4.jsonl.zstd`（多帧 zstd，按帧手动解码）。

原来这些脚本跟着已退役的 `dsh-stream-sanitizer` 走；插件角色已由 `dsh-request-guard`
取代（写入层补 id + 请求层修消息数组），脚本单独留下继续用。

## 脚本

| 脚本 | 作用 | 是否写盘 |
|---|---|---|
| `scan-all-sessions.mjs <sessions 根>` | 全库扫描空 tool-call id，报 `scanned / decode failures / poisoned` | 只读 |
| `find-recent-breakage.mjs` | 找最近 3 小时内出过回合错误或空 id 的会话，打印形态与尾部事件 | 只读 |
| `analyze-session-tail.mjs <会话文件>` | 打印声明过的 tool call 与其结果、孤儿列表、尾部事件 | 只读 |
| `analyze-loop.mjs <会话文件>` | 重复/循环统计 | 只读 |
| `repair-empty-toolcall.mjs <会话文件> [--apply]` | 删掉空 id 的 tool-call 块与配对的 `tool/call` 行 | 需 `--apply` |

## 修复脚本的安全约束

- 默认 **dry-run**，只打印将要删除的行；
- `--apply` 时先写 `.bak-<epoch>` 备份，再单帧重压 + 原子替换；
- 写后自检：重新解码，报告剩余空 id 数量（应为 0）。

## 用法

```bash
node scan-all-sessions.mjs "$DSH_HOME/sessions"
node repair-empty-toolcall.mjs "<path>/session.v4.jsonl.zstd"          # 预演
node repair-empty-toolcall.mjs "<path>/session.v4.jsonl.zstd" --apply  # 执行
```

需要 Node ≥ 18（用到 `zlib.zstdDecompressSync`，Node 22+ 自带）。
