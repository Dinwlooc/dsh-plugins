---
name: godot-creator-workflows
description: "2 个创作流程模板索引：2D 骨架、菜单/HUD/暂停。权威数据在 workflows/catalog.json，开工前读取取输入、阶段、验收与恢复。"
source: local
---

# 流程模板

**权威数据源：项目根 `dsh-plugins/godot-creator/workflows/catalog.json`**（唯一维护副本）。本文件只做索引：较大功能开工前，先读 catalog 取该模板的输入、阶段、验收与恢复策略；每阶段结束要有可回读证据，未过按恢复策略处理。

| 模板 id | 名称 | 必需输入 |
|---|---|---|
| `create-2d-game-foundation` | 创建 2D 游戏骨架 | `gameplay`、`controls`（可选 `resolution` 默认 1280×720、`art-direction`） |
| `add-game-ui-flow` | 添加菜单、HUD 与暂停流程 | `screens`、`hud-data`、`input`（可选 `theme`） |

更新模板只改 `catalog.json`；仅当模板 id、名称或输入清单变化时，才同步本索引。
