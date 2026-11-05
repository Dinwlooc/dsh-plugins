# dsh-release-notes

**定位**：把"我落后几个版本、中间改了什么"做成**会话视图页签**（与 Chat / Trajectory / X-Ray 同排，给人看），不是模型工具。
模型不需要知道有新版本——这条信息不改变它的任何一次决策，却要每轮为一条 schema 付费
（0014「系统提示段也是工具面」的同一判据）。

## 面

- Host：`GET /release-notes/api/report`（`?force=1` 跳过缓存），返回纯 JSON：
  `current` / `newest` / `behind` / `entries[{tag, at, bullets[]}]` / `cached`。
  **不注册任何模型工具**，不写系统提示段。
- Client：`client.js` 注册 `conversation.view`（id `release-notes`，order 30，排在 Chat 0 / Trajectory 10 / X-Ray 20 之后），面板自己 fetch、渲染、刷新。视图容器 `flex:1 + overflow-y:auto`，滚动归面板自己管（切页签不抖页面）。
- 缓存：`$DSH_HOME/release-notes/cache.json`，30 分钟；抓取失败降级为 502 JSON，不抛进会话。

## 验收

`node test/run.mjs`：断言 apply 只注册一条路由、不注册工具；路由 200/404/405；缓存与版本排序；**客户端注册 `conversation.view` 且不再出现 `settings.section`**、id/order/label 正确、面板能渲染出视图容器。

## 版本

0.2.0 起 GUI-only（0.1.x 注册 `release_notes` 工具，已删）。
