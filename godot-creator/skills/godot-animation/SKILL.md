---
name: godot-animation
description: "Godot AnimationPlayer/AnimationTree/Tween：轨道、状态机、混合与程序动画。"
---

# 动画

- 时间线用 `AnimationPlayer`；状态/混合用 `AnimationTree`；一次性过渡用 Tween。
- 轨道用稳定 NodePath；改名/重挂后 `validate`，防轨道静默失效。
- 游戏规则不依赖纯视觉帧：关键事件用 method track/signal/显式状态。
- Tween 由节点持有；重复触发前 kill/replace，避免属性争用。
- 移动与动画解耦：控制器给速度/状态，动画层消费。
- 工具：`animation_create`/`animation_manage`；改后 `validate`+`list/get` 回读，运行中 `play`，用截图或属性证明起止。
