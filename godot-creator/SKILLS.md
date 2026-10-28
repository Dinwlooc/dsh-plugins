# Godot Creator skills layer

`skills/` 是 preset 的按需知识层：每目录一个 `SKILL.md`，经 `@deepseek-ai/dsh-skill-filesystem` 的 `bundledSkillDir`（rank 600 兜底根）挂载。项目 `<root>/.dsh/skills`(100)、`.agents/skills`(200)、`customSkillDirs`(300)、`<dshHome>/skills`(400) 的同名技能覆盖这里。

本文件必须在 `skills/` **之外**：扫描根里的顶层 `<name>.md` 会被当成扁平技能。

## 契约

- 一目录一技能，一 `SKILL.md`；frontmatter 必有 `name`（kebab-case）与 `description`。
- 未知键（`upstream`/`verified`）被忽略；拼成 `disableModelInvocation` 等会整条丢弃。
- 只发现顶层 `<name>/SKILL.md`；正文按任务加载，不要整目录塞进提示词。

## Catalog (13)

| Skill | Role |
| --- | --- |
| `godot-ai-orchestration` | 编辑器控制协议：会话、工具路由、批量写入、运行/验收。编辑器任务先加载。 |
| `godot-creator-workflows` | 2 个流程模板（2D 骨架、菜单/HUD/暂停）：阶段/验收/恢复。 |
| `godot-nodes-scenes` | 场景树、PackedScene、实例化、autoload、生命周期、所有权。 |
| `godot-gdscript` | GDScript 类型、生命周期、注解、诊断。 |
| `godot-csharp` | .NET/C#：生命周期、导出、signals、释放、互操作、构建。 |
| `godot-signals-groups` | signals/groups 解耦通信与验证。 |
| `godot-resources` | Resource/.tres 数据驱动、共享、UID、序列化。 |
| `godot-animation` | AnimationPlayer/Tree/Tween、混合、过渡。 |
| `godot-ui-control` | Control：anchors、containers、theme、焦点、响应式 HUD。 |
| `godot-shaders` | canvas_item/spatial shader、uniforms、材质、验证。 |
| `godot-audio` | 播放器、bus、effects、衰减、运行时验证。 |
| `godot-multiplayer` | authority、RPC、Spawner/Synchronizer、复制、安全。 |
| `godot-export` | export preset、模板、权限、headless、发布验收。 |

## 来源与更新

- 工具语义：`hi-godot/godot-ai` 4.3.0，直连 MCP；工具名/`op`/引擎事实一律现场读（`api_manage(op="get_class")`）。
- 连接参数不硬编码：`$DSH_HOME` 的 `mcp-godot-ai` 条目 `--port` 是唯一来源；4.3.0 起 HTTP 需 capability（读 `http-<port>.json`）。
- 领域知识：`gamedev-skills/awesome-gamedev-agent-skills` 快照 `9ca5296b…`；引擎事实基线 Godot 4.7.2 + godot-ai 4.3.0。
- 归属与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 更新：比对上游 → 回写技能与 `godot-ai-orchestration` 的 `verified-against` → `workflows/catalog.json` 是流程模板唯一权威源（流程技能只做索引）→ 改目录后更新 bundle patch 的 `bundledSkillDir`。

---
**署名**：deepseek-flash ｜2026-10-16 ~ 2026-10-22
