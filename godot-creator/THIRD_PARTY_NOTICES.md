# Third-party notices

源自 `dsh-godot-ai@0.7.0`（MIT），为本仓库重建版做了修订。

## 重建来源（2026-10-16）

`plugin/cordis.patch.yml` 的 `preset-godot-creator` 行是为本项目新写的声明：插件清单对齐当前 DSH 的 `standard` 预设；Persona 改编自 `dsh-godot-ai@0.7.0` 的 `renderGodotCreatorPersona()`（MIT），改为直连 MCP；preset 标识（`godot-creator`，order 5）沿用原声明。不是任何上游文件的拷贝，也未修改上游 DSH 模式。

## 原 dsh-godot-ai 声明

已退役的 `godot-creator` 声明派生自公开的 `@deepseek-ai/dsh-web-app` 0.2.0-rc.2 PTC 预设；改动了标识与描述、省略禁用行、加入 Godot Agent 行。

- Source: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/bundle/web-app/presets/ptc.patch.yml
- License: MIT, Copyright (c) 2026 DeepSeek

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## hi-godot/godot-ai

`godot-ai-orchestration` 技能与兼容性契约是对公开 Godot AI 工具文档的独立改写；3.1.5 时代的正文已于 2026-10-16 按直连 MCP 重写，2026-10-22 于 4.3.0 复核。本包不 vendor 该包或 addon，只经官方 MCP 配置与 addon 通信。

- Source: https://github.com/hi-godot/godot-ai
- License: MIT

## awesome-gamedev-agent-skills

11 个 Godot 领域技能的名称、分类与路由边界受该仓库启发；正文按 `hi-godot/godot-ai` 的执行与验收模型重写，不含上游 hooks、脚本、安装器或 MCP 集成。

- Source snapshot: https://github.com/gamedev-skills/awesome-gamedev-agent-skills/tree/9ca5296b219049c5b68494e1f3c274ead6d727b3/skills/godot
- License: Apache-2.0, Copyright 2026 Abhishek Barali and contributors

## GodotPrompter

`jame581/GodotPrompter` 作为覆盖面与技能路由的第二参考；未分发其文件、hooks、脚本或安装行为。

- Reviewed snapshot: https://github.com/jame581/GodotPrompter/tree/eae755a1f3719076d52f50ab76f21993ebb9682b
- License: MIT

---
**署名**：deepseek-flash ｜2026-10-16 ~ 2026-10-22
