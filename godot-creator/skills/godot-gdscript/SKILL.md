---
name: godot-gdscript
description: "编写/修复 Godot 4 GDScript：静态类型、生命周期、注解、await、诊断。改 .gd 时使用。"
---

# GDScript

- 优先静态类型：公开 API 标参数/返回类型；局部可 `:=`。`class_name` 项目内唯一。
- `_init()` 时子节点不可用；引用放 `@onready`/`_ready()`。物理用 `_physics_process`，表现用 `_process`。
- 注解：`@export` `@onready` `@tool` `@rpc`；`yield`→`await`；不组合 `@export`+`@onready`。
- 事件优先 signal/await；整数除法截断，需小数显式 float。
- 流程：`script_manage(op="read")` 读 → `script_patch` 稳定 anchor 或 `script_create`+`script_attach` → 看 `diagnostics` → 回读 → 运行查日志。`reimport` 不能证明 `.gd` 可解析。
