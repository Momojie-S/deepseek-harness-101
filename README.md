# deepseek-harness-101

个人 DeepSeek Harness (DSH) 插件开发集。每个插件是独立仓库，以 git submodule 形式挂载到 `plugins/` 下。

## 插件目录

| 插件 | 路径 | 作用 |
|------|------|------|
| @momojie-s/dsh-workspace-mcp | `plugins/dsh-workspace-mcp` | 按 workspace（session cwd）自动加载/卸载 MCP server，工具注册到 agent scope |
| @momojie-s/dsh-workspace-env | `plugins/dsh-workspace-env` | pwsh 命令自动注入 workspace `.env` 环境变量，实现 workspace 级环境变量隔离 |
| @momojie-s/dsh-subagent-model | `plugins/dsh-subagent-model` | `subagent_model` 工具：委派子代理时可按次指定模型路由（provider/model/max_tokens），fork 自官方 tool-subagent |

## 使用心得笔记

- [docs/usage/dsh-plugin-development.md](./docs/usage/dsh-plugin-development.md) — DSH 插件开发指南（形态、依赖注入、HMR 缓存、patch 限制、踩坑速查）
- [docs/usage/mcp.md](./docs/usage/mcp.md) — 怎么在 DSH 添加 MCP server（插件 + patch + 踩坑）

## 使用

```shell
git clone --recurse-submodules https://github.com/Momojie-S/deepseek-harness-101.git
# 或 clone 后补拉子模块
git submodule update --init --recursive
```

## 新增插件

1. 在 GitHub (Momojie-S 账号) 建独立插件仓。
2. 在本仓执行：
   ```shell
   git submodule add https://github.com/Momojie-S/<plugin-name>.git plugins/<plugin-name>
   ```
3. 更新本 README 的插件目录表。
