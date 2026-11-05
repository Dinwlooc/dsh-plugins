# dsh-prompt-trim

**定位**：会话启动成本治理（不是提示词编辑器，也不是 tool-search）。把"工具说明或工具返回已经能读到"的
系统提示段，在 agent preset 里用同名**空文本段**遮蔽掉，让它们不再每轮注入。

## 用法

装进 profile 后，preset `godot-creator` 会多挂一个 `prompt-trim` 插件。改遮蔽清单只改 `index.js` 的
`SHADOWS`；新增一条要给它一个有限 `order`（优先用 `getSectionOrder` 的放置名）。

## 机制与边界

- Loader 的按 id 覆盖是**整块替换 `config`**，所以 `cordis.patch.yml` 里重述了 `preset-godot-creator`
  的完整插件清单；来源是 `dsh-plugins/godot-creator/plugin/cordis.patch.yml`，godot-creator 升级后需重新合并。
- 只在 scoped（preset/agent）层注册能遮蔽；全局层注册同名段会抛 `prompt section ... is already registered`。
- 段落消失后，其事实仍可从工具 schema、工具返回或项目文件读到——这是删除的前提，不是副作用。

## 验收

新会话的 `~/.dsh/xray/runtime.json` → `promptAssembly.sections` 里，被遮蔽的段应显示 `tokens: 0`。
