---
name: godot-resources
description: "Godot Resource/.tres 数据驱动：共享与独立、UID、序列化边界。"
---

# Resources

- Resource 存数据/配置，Node 存行为与树关系；物品/技能/敌人配置优先自定义 Resource。
- typed `@export` 是编辑器数据契约；不持久化 live Node、Callable、瞬态状态。
- 共享 `.tres` 同步影响所有引用者；要独立状态就 duplicate 并确认 subresources。
- 保持 `res://` 路径、UID、ext/sub_resource 引用完整，不猜 UID。
- 存档只存可重建纯数据 + schema version。用 `resource_manage(op=search|get_info|load|create|assign)`；赋值后回读属性再保存/运行。
