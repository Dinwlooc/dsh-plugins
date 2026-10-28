---
name: godot-multiplayer
description: "Godot 高层多人：authority、RPC、Spawner/Synchronizer、复制与安全边界。"
---

# Multiplayer

- 先定权威端；客户端只发意图，权威端验证并改状态；不信任客户端传来的伤害/位置/结果。
- RPC 显式 mode/transfer mode/channel/call_local；可靠通道用于关键离散事件，不可靠有序用于高频状态。
- `MultiplayerSpawner` 管出生销毁，`MultiplayerSynchronizer` 管可复制属性；NodePath 与场景结构各 peer 一致。
- 输入/预测/校正/插值分层；先两端确定性正确再优化手感。
- 单编辑器成功≠联网正确：至少覆盖 host/client/断线/重连/拒权。godot-ai 只能做单实例验证，别把单 session 当多人验收。
