---
name: godot-nodes-scenes
description: "Godot 场景树：节点组合、PackedScene、实例化、autoload、生命周期与所有权。"
---

# 节点与场景

- 场景是可复用组件，根节点类型即契约；组合优先于深继承。
- 父调子直接调；子向上用 signal；跨树广播慎用 autoload。
- 频繁复用对象存 `PackedScene`；数据存 `Resource`，别把数据模型藏节点树。
- 明确 owner/可编辑子节点与资源路径，避免保存后子节点消失、重名、悬空 NodePath。
- 流程：`scene_get_hierarchy`/`node_get_properties` 读 → `node_find` 查冲突 → 建/移/挂/删 → 保存后回读层级 → 涉及切换/pause/deferred 变更时运行验证。
