---
name: godot-export
description: "Godot 导出：preset、模板、平台权限、资源过滤、headless 与发布前验收。"
---

# Export

- 先锁平台/架构/渲染器/分辨率/权限/签名要求。
- `export_presets.cfg` 可入库，但密钥/密码/商店凭证不得提交。
- 检查 export templates 与编辑器版本匹配；自定义扩展名、动态路径、大小写在打包后易丢。
- 发布构建禁用调试后门/dev server，检查日志、存档位置、首次启动、暂停恢复、退出。
- 桌面/Web/移动/headless 限制不同；编辑器通过≠导出包通过。
- 用仓库已有命令导出；godot-ai 只做导出前验收；缺 SDK/签名材料时列待办，不伪造产物。
