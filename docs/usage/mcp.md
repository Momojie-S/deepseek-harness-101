# MCP 配置

> 每个外部 MCP server = 一个 `@deepseek-ai/dsh-mcp-client` 插件实例。配在 patch YAML 里，HMR 热生效。

## 配置文件（patch YAML，不是 JSON）

| 文件 | 范围 |
|---|---|
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | 该 profile |
| `~/.dsh/cordis.patch.yml` | 全局，所有 profile |

Windows 上 `~/.dsh` = `C:\Users\<你>\.dsh`。

## 最小配置模板

### stdio（npx 启动）

```yaml
- insert:
    - id: mcp-<name>
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: <name>              # 工具名前缀 mcp__<name>__*
        transport: stdio
        command: npx
        args: ['-y', '<package>']
        env:
          API_KEY: '<裸值，见踩坑>'
```

### streamable-http（已有 server）

```yaml
- insert:
    - id: mcp-<name>
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: <name>
        transport: streamable-http
        url: http://127.0.0.1:<port>/mcp
```

## config 字段速查

| 字段 | transport | 说明 |
|---|---|---|
| `serverName` | 两者 | 工具名命名空间，`[A-Za-z0-9_-]{1,32}`，全局唯一 |
| `transport` | 两者 | `stdio` 或 `streamable-http` |
| `command` / `args` | stdio | 要 spawn 的命令和参数 |
| `env` | stdio | 传给子进程的环境变量 |
| `url` | http | MCP server 的 URL |
| `headers` | http | 额外请求头（如 Authorization） |
| `toolCallTimeoutMs` | 两者 | 单次工具调用超时，默认 60s |

完整字段（reconnect 配置等）见 DSH 源码 `packages/mcp/mcp-client/README.md`。

## 排查工具不出现

```shell
# 1. 看配置进树没
dsh web --dump-config 2>&1 | Select-String 'mcp-|not a group'
# 2. insert 必须不带 id（顶层追加），带 id 嵌套会静默 not a group
# 3. stdio 认证：process.env 引用受环境快照冻结，启动后改 .env 不生效 → 用裸值或重启
```

## 重连机制（内建，了解即可）

- 断线自动重连，指数退避 500ms → 30s
- 连续失败 10 次放弃，卸载工具等 reload
- 重连期间旧工具保持注册但调用失败
- 连接存活超 30s 重置预算（偶尔崩的能无限恢复，crash-loop 的被掐掉）
- **已知盲区（官方 mcp-client）**：streamable-http server 重启/会话驱逐后的 `Session not found`（HTTP 404）不触发 `onclose`，官方 supervisor 唯一断线信号就是 onclose → 不重连，工具持续失败；只能"强制重连"（删 patch 条目存盘再贴回）或重启 DSH。stdio 不受影响（进程退出必触发 onclose）

项目级 `workspace-mcp` 插件（≥0.2.0）移植了同一套 supervisor，行为一致；重连参数可在插件 patch config 的 `reconnect.*` 或 `.dsh/mcp.servers.yml` 各 server 条目逐项覆盖（见插件 README「配置」）。**≥0.2.1 补上了上述盲区**：工具调用/重同步识别 `Session not found` 类错误即自动判定断线换代重连（一次调用失败后自愈，偶发 5xx 不误判），机制见插件 ADR-0005。**≥0.3.0 官方对齐补齐**：stdio 子进程继承 scrubbed 父环境（yml `env` 变为覆盖层，与全局 MCP 一致）、`structuredContent` 输出契约、非法工具列表/注册冲突整代拒绝回滚，机制见插件 ADR-0006。

## 项目级 MCP 补充（workspace-mcp）

**注册时机与竞速**：注册在 `agent/created` 即启动（web 开会话与首条消息之间的秒级窗口内完成握手）→ 首个模型请求就含这些工具。例外：create 后立刻发消息的竞速场景（headless 单步任务）第一步可能没有，第二步必有。

**排查日志**：挂载 config 开 `verbose: true` 后，连接/注册日志含 `[ws-mcp] server "xxx": 注册 N 个工具`（stdio 场景在 stderr）。

**headless/tui profile 临时挂载**：这两个 profile 没挂 workspace-mcp，需要时用 `--patch` 临时挂 `file:///` 行指向其 lib（`D:/code/workspace/deepseek-harness-101/plugins/dsh-workspace-mcp/lib/index.js`；纯 host 半部插件可临时这样挂，带浏览器半部的插件不行——见合集 AGENTS.md「部署形态」）。

**与全局 MCP 同名冲突（实测结论）**：两边工具名都是 `mcp__<serverName>__<tool>`，冲突语义来自 DSH 工具注册表——agent 作用域遮蔽全局（per-tool，按名字逐个遮蔽）：

| 场景 | 行为 |
|---|---|
| serverName 不同 | 共存，两组工具模型都可见（正常用法） |
| 同 serverName（工具名撞车） | 项目级赢：模型看到并调用的都是项目版（web 从第 1 步起；竞速输了的场景第 1 步可能暂用全局版，第 2 步起项目版）。全局版对没配此 server 的其它 workspace 不受影响 |
| 全局 patch 里两条同 serverName | 后者整代注册回滚，日志报 `already registered`，该 server 一个工具都没有 |
| 同一个 yml 里重复 server 键 | YAML 后键覆盖前键 |

同名遮蔽是刻意覆盖的正规姿势（如把全局 server 指向本地 dev 实例调试）；无意撞名就改 serverName。若两边工具列表不完全一致，只有重名的那部分被遮蔽，其余各自可见。