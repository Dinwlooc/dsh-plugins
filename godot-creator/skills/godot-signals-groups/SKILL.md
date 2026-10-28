---
name: godot-signals-groups
description: "Godot signals/groups 解耦通信：连接、断开、广播与验证。"
---

# Signals 与 Groups

- signal 表达"发生了什么"，发送者不感知接收者；同场景直连，父到子直接调用；跨系统多订阅者才用 EventBus autoload。
- typed signal + 过去式命名，参数只带接收方需要的。
- 动态节点入树后连接，释放/替换时防悬空；一次性流程可用 `CONNECT_ONE_SHOT`。
- group 用于标签查询/批量调用，不替代稳定引用或类型契约。
- 流程：`signal_manage(op="list")`/`node_manage(op="get_groups")` 读 → connect/disconnect → 重新 list → 运行时证明只触发一次且目标正确。
