---
name: godot-shaders
description: "Godot canvas_item/spatial shader：uniforms、材质、UV、光照与视觉/性能验证。"
---

# Shaders

- 2D 用 `canvas_item`，3D 用 `spatial`；先定视觉目标与渲染阶段再选 type/render_mode。
- uniforms 是调参接口：命名清晰、给默认值与范围。
- 先最小效果（UV/COLOR/少量采样）再加噪声、屏幕纹理、多 pass。
- 注意透明/深度/剔除/blend 对排序与性能的影响；移动端限制采样、分支、overdraw。
- ShaderMaterial 可共享；每实例独立参数要复制资源或用 instance uniform。
- 工具：`material_manage` 建/设/赋/回读；纹理/噪声/渐变用 `resource_manage`；截图比较目标区域并读 monitors。
