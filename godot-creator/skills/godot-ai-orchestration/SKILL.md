---
name: godot-ai-orchestration
description: "直连 MCP 操控 Godot 编辑器：会话发现、工具路由、批量写入、运行、输入与截图验收。任何编辑器写入/运行/验收任务先加载。"
verified-against: godot-ai 4.3.0 / Godot 4.7.2 / MCP 2025-06-18
---

# Godot AI 编排

编辑器是事实来源，本技能是控制协议。工具直连 `mcp__godot-ai__*`，无包装层；工具名与参数一律以当前 schema 为准，不凭记忆编造。

## 开始前

1. `session_manage(op="list")` 发现编辑器；多项目时显式 `session_activate`。
2. 读 `editor_state`：`current_scene`、`readiness`、`play_state`、`game_status.status`。
3. 写入前先读目标（层级、节点属性、脚本、资源、设置）；不从用户描述推断现状。

## 工具路由

- 高频：`session_manage`、`editor_state`、`scene_get_hierarchy`、`node_get_properties`、`node_set_property`、`batch_execute`、`project_run`、`logs_read`、`editor_screenshot`。
- 领域 rollup（`{op, params, session_id?}`，`session_id` 顶层）：名字与 `op` 读当前 schema。
- `batch_execute.commands[].command` 用插件底层命令名（`create_node` 等），不能嵌套。
- 类属性/信号不确定：`api_manage(op="get_class")`。第三方 addon 工具：`custom_manage`。

## 写入纪律

- 一个原子批次单一子树/资源族，≤约 20 条副作用命令；更大按子树分批并回读。
- 无依赖只读可并行；创建/改名/重挂/赋值/保存必须串行。
- 每批写入后用另一条读取路径回验；`success: true` 不是完成证明。
- `script_create`/`script_patch` 后立即看 `diagnostics`。
- 编辑器内存改动用 `scene_save` 落盘；避免工具写文件与编辑器内存副本分裂。
- `batch_execute` 返回 `rolled_back: true` 时整批已撤销，修正后重放并回读。

## 运行与验收

1. 保存后 `project_run(mode="custom", scene=目标)`；不要用 `current` 验证隔离目标。
2. 以 `game_status.status` 判定：`live` 才算在线；`break` 先 stop、修最早解析错误再跑；`no_helper` 只证明进程存在。
3. 读 editor 日志与本次 run 的 game 日志（带 `run_id`）。
4. 交互验收用 `input_sequence`（frame-timed），结束释放按键；它不保证 `_input`/边沿语义，需边沿时用 `is_action_pressed` 自存上一帧。
5. 同一交互 oracle 最多两次有界尝试（单次 ≤300 physics frames）；否则换独立状态读回或标"交互未验证"。
6. 视觉验收用 `editor_screenshot`（`game`/`viewport_2d`/…），注意 `stale_frame`；证据等级：实读→描述→像素，逐级降级不夸大。
7. `editor_reload_plugin` 会断连；重连后重新 `session_manage(op="list")`。

## 失败恢复

记录已完成副作用与最后一个已验证点，先修首个根因，不在未知状态重放整批。
