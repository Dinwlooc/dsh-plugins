---
name: godot-csharp
description: "Godot .NET/C#：生命周期、导出、signals、释放、GDScript 互操作与构建诊断。"
---

# C# / .NET

- 仅 .NET 版且已有 `.csproj` 时使用；先核对目标框架与 Godot 版本。
- `_Ready`/`_Process`/`_PhysicsProcess`；`[Export]` 强类型；signals→C# events 的 delegate 需稳定引用，释放时解订阅。
- GodotObject 生命周期≠CLR：`QueueFree`、`IsInstanceValid`、Variant 可支持类型、线程限制。
- 互操作边界用稳定 Godot 类型/signal/方法名；别把复杂 CLR 泛型暴露给 GDScript。
- `godot-ai` 的 script_* 面向 GDScript；C# 用工作区文件工具 + `dotnet build`，再用 godot-ai 绑节点/运行。
