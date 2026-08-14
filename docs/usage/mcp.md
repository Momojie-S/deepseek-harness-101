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