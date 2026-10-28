---
name: godot-ui-control
description: "Godot Control UI：anchors、containers、themes、焦点、响应式 HUD 与可访问性。"
---

# UI / Control

- 布局优先 Container；anchors 表达相对伸缩。不要同时用脚本和 Container 争尺寸。
- HUD 放 `CanvasLayer`；世界空间与屏幕 UI 分开。
- 样式集中 Theme，局部 override 只为例外；同语义控件用 type variation。
- 键盘/手柄设 focus neighbor、初始 focus 与返回路径；触控目标留足尺寸。
- 文本适应翻译/fallback/长文/缩放，不用空格对齐；长 Label 开 autowrap。
- full-rect 根用零 offsets；`set_anchor_preset` 可能重置 offsets——先 preset 再边距并回读。
- 流程：`ui_manage(build_layout)` + `theme_manage` → 运行后 `game_manage(op="get_ui_elements")` 回读尺寸/可见/文本/focus；焦点依赖 InputEvent（`input_key`/`input_gamepad`；`input_action` 只设状态）。
