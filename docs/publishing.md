# 发布笔记（npm）

账号 `dinwlooc`。发布前确认：`keywords` 含 `dsh-plugin`、`LICENSE` 在包内、`author`/`license` 齐全、`private` 已移除、回归全绿。

## 一次性准备

```powershell
$nodeDir = '<path to>/node/bin'      # 必须有 node 在 PATH，否则 npm 子进程报 'node' is not recognized
$env:PATH = "$nodeDir;$env:PATH"
$pnpm = '<path to>/pnpm/bin/pnpm.cjs'
```

token 写在 `~/.npmrc`：`//registry.npmjs.org/:_authToken=<token>`。不发布时建议 revoke。

## 发布

**不要用 `pnpm publish`**：pnpm 11 走分阶段发布，只发一个占位版 `0.0.0-stage`，真实版本不可见；再发同版本会报
`E409 Cannot publish over previously staged version`。

用 npm CLI：

```powershell
& node $pnpm dlx npm@11 publish --access public
```

约 1–2 分钟后 `https://registry.npmjs.org/<pkg>` 的 `dist-tags.latest` 应指向新版本。

## 已知噪声

占位版 `0.0.0-stage` 删不掉：

```
npm unpublish <pkg>@0.0.0-stage
→ 403 Granular access tokens that bypass two-factor authentication may not perform this action
```

Granular Access Token 不允许破坏性操作。占位版不是 `latest`，不影响安装；要清理得用带 2FA 的网页会话。

## 版本规则

已发布版本不能覆盖。被占位版锁住的版本号要跳过（例：`dsh-request-guard` 的 `0.1.0` 被 staged 占用，实际发的是 `0.1.1`）。
