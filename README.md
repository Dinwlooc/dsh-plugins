# dsh-plugins

DeepSeek Harness 插件集合。每个子目录是一个独立的 DSH bundle，可单独安装、单独发版。

| 目录 | npm 包 | 状态 | 说明 |
|---|---|---|---|
| `dsh-request-guard/` | `dsh-request-guard@0.1.1` | 已发布 | 三层请求守卫：写入层补空 tool-call id、请求层修消息数组、错误层配对 400 重试一次 |
| `dsh-exploration-guard/` | `dsh-exploration-guard@0.3.0` | 已发布 | 按任务进展熔断探索黑洞（不是按重复判据） |
| `meta-tools/` | `dsh-meta-tools@0.1.0` | 已发布 | 元层路由 / 签发 / 任务类型注册表 / 模型库身份别名 |
| `budget-watch/` | `dsh-budget-watch` | 内部使用 | 只提醒不中断的 token 预算看门狗（专用口径，不发布） |
| `tools/session-repair/` | — | 工具 | 会话日志诊断与修复脚本（不依赖插件） |
| `godot-creator/`、`harness-skills/` | — | 内部 | Godot 侧插件与技能包 |

## 安装（从 npm）

```bash
dsh plugin --profile desktop add dsh-request-guard
dsh plugin --profile desktop add dsh-exploration-guard
dsh plugin --profile desktop add dsh-meta-tools
```

## 本地开发

每个包都是独立的 DSH bundle（`cordis.patch.yml` + `dsh.bundle.patch`），以 `link:` 方式装进 profile：

```bash
dsh plugin --profile desktop add link:/abs/path/to/<pkg>
```

改代码后需重装（remove → add）才会被宿主加载。

## 测试

```bash
node dsh-request-guard/test/run.mjs        # 10/10
node dsh-exploration-guard/test/run.mjs    # 9/9
node meta-tools/test/run.mjs               # 20/20
```

## 发布

见 [docs/publishing.md](docs/publishing.md)（含 pnpm 分阶段发布的坑与 npm CLI 解法）。

## 许可证

各包均为 MIT，见各自目录下的 `LICENSE`。
