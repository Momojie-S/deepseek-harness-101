# 错误码

失败时返回 `{"ok": false, "error": {"code", "message", "hint", "detail"?}}`。按 `code` 处理：

| code | 含义 | 你该做什么 |
|---|---|---|
| `invalid_argument` | 参数错误 | 看 `message` 修正 args；全部参数可用 `bili(args=["schema"], out_file=…)` 落盘查 |
| `not_logged_in` | 未登录 | 走登录流程（要人类扫码） |
| `auth_expired` | 凭证失效 | 同上，重新登录 |
| `not_found` | 视频 / 评论 / 字幕等不存在 | 检查 ID；资源可能被删或不可见 |
| `risk_control` | 被 B 站风控（-352、-412、重复评论等） | **停止写操作**，告诉用户 |
| `captcha_required` | 需要人工验证码 | **停止**，请人类在网页 / App 完成一次相同操作 |
| `rate_limited` | 本地或 B 站限流 | 等 `detail.retry_after` 秒再试，不要绕过 |
| `network_error` | 网络错误 | 稍后重试一次 |
| `login_pending` | 二维码还没扫 / 没确认 | 等人类扫码后再 `bili(args=["auth","status","--wait","120"])` |
| `login_expired` | 二维码过期 | 重新 `bili(args=["auth","login"])` |
| `api_error` | 其他 B 站错误（`detail.bili_code` 为原始代码） | 看 `message`；不确定就告诉用户 |
| `internal_error` | 服务内部错误 | 告诉用户，附上完整输出 |

`detail.bili_code` 是 B 站的原始错误码，例如 12015（需要验证码）、12051（重复评论被判刷屏）、21007（私信过长）。

另外两种插件层返回：

| 返回 | 含义 | 你该做什么 |
|---|---|---|
| `blocked: true` | 发布类操作被合规审查拦截，内容**没有发出** | 按 `reason` 修改正文（`text`）后重试，或放弃该条；不要换姿势绕 |
| `truncated: true` | 输出超长被截断 | 重跑时加 `out_file` 落盘，用文件读取工具看完整内容 |
