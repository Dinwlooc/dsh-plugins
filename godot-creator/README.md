# Godot Creator 模式

**性质**：DSH 插件包与预设｜**署名**：见文末

重建自 `dsh-godot-ai@0.7.0` 的 `godot-creator` Agent 模式（该插件已停止适配新 DSH，仅作参考）。本目录直接建立在 DSH 自带的 Godot AI 插件配置之上，通过 MCP 工具面（`mcp__godot-ai__*`）操作编辑器。

## 组成

| 层 | 承载 | 内容 |
| --- | --- | --- |
| Agent 预设 | `plugin/cordis.patch.yml` 的 `preset-godot-creator` 行 | 提示词（义务/方法/模式特征/Godot 环境，不写身份）+ 工具面（22 个插件，对齐官方 `standard` 预设） |
| 默认预设选择 | 同文件的 `agent-preset-registry` 行 | 新会话默认进入本模式 |
| 视觉层 | 同文件的 `godot-creator-ui` 行 + `plugin/lib/` | 会话头状态芯片 + 设置页集成诊断卡 |
| 自开销工具 | `plugin/lib/index.js` | `usage_report`：`full` / `baseline` / `delta` 三档 |
| 技能 | `skills/`（13 个） | 经 `skill-filesystem` 的 `bundledSkillDir` 挂载 |
| 工作流模板 | `workflows/catalog.json`（权威）+ `skills/godot-creator-workflows`（索引） | 2 个模板；只维护 catalog，skill 只给 id/输入索引 |

预设、默认选择与视觉层都随 bundle patch 走，由 `plugin_manager` 安装、更新、移除。

## 目录

```
dsh-plugins/godot-creator/
├─ plugin/                    # bundle（host + client 两半）
│  ├─ package.json            # dsh.bundle.patch + dsh.client
│  ├─ cordis.patch.yml        # host 行 / preset 行 / 注册表行
│  ├─ lib/{index.js,client.js}
│  ├─ test/{audit.mjs,tool-cost.mjs}
│  └─ README.md               # 数据来源、失败语义、验证记录
├─ skills/                    # 13 个技能
├─ workflows/catalog.json     # 流程模板权威数据源
├─ SKILLS.md                  # 技能层契约与来源策略
├─ THIRD_PARTY_NOTICES.md     # 归属与许可
```

## 安装与更新

已安装。检查当前状态：

```powershell
$p = Join-Path $env:DSH_HOME "profiles\<profile>"
(Get-Content "$p\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles   # 应含 godot-creator-ui
(Get-Item "$p\node_modules\godot-creator-ui").Target                        # 应指向本目录 plugin/
```

重装 / 更新：

```
plugin_manager(action="install_bundle", target="<仓库根>\\.dsh\\godot-creator\\plugin")
```

bundle patch 里的 `bundledSkillDir` 是技能目录的绝对路径；仓库换位置后按实际路径修改该行。

已安装的包改内容后 `install_bundle` 会报 `already-installed`；用禁用再启用让组合重新读取：

```
plugin_manager(action="set_bundle", target="godot-creator-ui", enabled=false)
plugin_manager(action="set_bundle", target="godot-creator-ui", enabled=true)
```

## 维护

| 想改什么 | 改哪里 | 之后 |
| --- | --- | --- |
| Persona / 预设工具集 / 默认预设 | `plugin/cordis.patch.yml` 的 preset 行 | `set_bundle` 关闭再启用；新会话生效 |
| 预设提示词 | 同上 `persona` 段的 `prefix`/`suffix` | 只写义务、方法、模式特征、Godot 环境；不写身份、不复述 AGENTS.md；改后 `set_bundle` 关闭再启用 |
| 视觉层（client 半） | `plugin/lib/client.js` | 刷新页面 |
| 状态探测 / 自开销工具（host 半） | `plugin/lib/index.js` | `set_bundle` 关闭再启用；不行再重启 DSH |
| 领域技能 | `skills/<name>/SKILL.md` | 无需重装（目录直接被引用） |
| 流程模板 | 只改 `workflows/catalog.json` | SKILL.md 是索引，仅在模板 id/名称/输入清单变化时同步 |
| Godot AI 升级 | `skills/godot-ai-orchestration/SKILL.md` 的 `verified-against` 与工具路由段 | 跑一次 `editor_state` 确认工具面 |

技能按需加载，不在每轮提示词里；同名技能可被项目 `.dsh/skills` 覆盖。

## 卸载

```
plugin_manager(action="set_bundle", target="godot-creator-ui", enabled=false)   # 停用，保留依赖
plugin_manager(action="remove_bundle", target="godot-creator-ui")              # 移除依赖与 node_modules
```

## 测试

`node plugin/test/audit.mjs`（93 项断言）· `node plugin/test/tool-cost.mjs`（工具成本量级）。

## 归属与许可

迁入的技能与流程模板来自 `dsh-godot-ai@0.7.0`（MIT），其知识又源自 `hi-godot/godot-ai`、`gamedev-skills/awesome-gamedev-agent-skills`（Apache-2.0）与 `jame581/GodotPrompter`。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

**署名**：deepseek-flash ｜2026-10-22
