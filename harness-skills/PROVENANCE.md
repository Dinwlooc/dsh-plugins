# dsh-plugins/harness-skills —— DSH 自带技能的项目内副本

**性质**：vendor 内容副本，不是本项目创作的技能。修改请回到来源，不要在这里手改。

## 来源

- 包：`@deepseek-ai/dsh-agent-preset`，`skills/` 目录
- 构建：DSH `0.2.1-rc.3` 桌面版，`resources/app.asar`（asar 内路径
  `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills`），asar 时间戳 2026-10-23 16:00
- 抽取：2026-10-26，deepseek-flash，按 owner 裁定「为 godot-creator 开放创造插件的权限和工具」

## 为什么是副本而不是 asar 路径

`preset-cordis` 用的是

```yaml
customSkillDirs:
  - !!js ... createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json') ...
```

该表达式里 `baseUrl` 是**配置文件自身**的位置。shipped preset 位于 asar 内的
`dsh-web-app/presets/`，所以 `require` 能在 asar 的 `node_modules` 里解析到包；
而本项目的 bundle patch 位于 `D:/.../dsh-plugins/godot-creator/plugin/`，同一表达式会从
项目目录解析并抛错——按本文件的既有事故记录（见 `cordis.patch.yml` 里
`skill-filesystem` 上方注释），这类抛错会让 **preset 激活失败、新会话开不出来**。
因此改为项目内字面量副本 + 字面量 `customSkillDirs`：最坏情况只是少技能。

## 目录

| 技能 | 用途 |
|---|---|
| `agent-experience` | 面向模型的工具/技能/上下文设计规则 |
| `cordis-plugin-development` | 写、装、调 DSH 插件与 bundle 的主流程（含 references/ 与 templates/） |
| `cordis-composition-reference` | Loader YAML 方言与可安装包清单（含 references/packages.md） |
| `editing-cordis-compositions` | 编辑/校验 agent preset 与其它 Cordis 组合 |

## 刷新方式

1. 用与 asar 头解析等价的脚本从当前安装的 `app.asar` 重新抽取该目录（本次用
   Node 24 内置 `zlib` 之外无需依赖：读 asar 头 → 取 `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/**`）；
2. 覆盖本目录同名文件，删掉来源已移除的条目；
3. 在 `cordis.patch.yml` 的 `customSkillDirs` 不变的前提下，重启 DSH 后新会话生效。

## 已知限制

- 与 DSH 版本绑定：DSH 升级后本副本可能过期（技能内容不会自动跟随）。
- 副本里若出现与其它技能根同名的技能，按 `skill-filesystem` 的 rank 规则决定优先级
  （`customSkillDirs` rank 300，`bundledSkillDir` rank 600）。
