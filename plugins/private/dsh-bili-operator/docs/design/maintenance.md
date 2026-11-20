# 与上游 bili-cli 的对齐维护

插件的三层能力都跟着上游 bili-cli 走：CLI 本体（子命令与参数）、识别表（六类写命令的参数布局）、skill（命令知识与流程表）。上游发新版后按本文对齐。当前基准：**bili-cli 1.3.0**（2026-11-04 发布）。

## 1. CLI 升级

```powershell
# 装/升级时钉住 typer（见下方坑），uv tool 的 pin 语义见第 4 节
uv tool install bili-agent==<版本> --with "typer<0.28" --force
& $env:USERPROFILE\.local\bin\bili.exe --version     # 确认版本
& $env:USERPROFILE\.local\bin\bili.exe auth status   # 登录态不受影响（凭证在 BILI_CLI_HOME）
```

**⚠ typer 坑（1.3.0 实测）**：上游 `pyproject.toml` 约束 `typer>=0.12` 无上界；typer 0.29 移除了 `TyperOption.type` 内部属性，`bili schema` 命令直接崩（`AttributeError`，落盘只有 221 字节错误 JSON），其余命令不受影响——不跑 schema 发现不了。所以安装必须带 `--with "typer<0.28"`。上游修复（加上界或改用稳定 API）后解除。

**升级后第一件事**：跑一次 `bili schema` 确认输出完整 JSON（命令数 1.3.0 是 117）；坏了先查 typer 版本再查上游 issue。

## 2. 识别表核对（`src/host/commands.ts`）

识别表硬编码六类写命令的参数布局。上游改参数（加 flag、改短旗标、改位置参数顺序）而表没跟上时：**新 flag 会被当未知 flag fail-close**（安全但误伤正常操作），短旗标/位置错位会让正文提取失败或提取错。

升级后核对流程：

1. schema 落盘：`bili schema > .temp/schema-<版本>.json`（注意 cmd 重定向，PowerShell `>` 会写坏编码）
2. 对照六条写命令的参数表：`comment post` / `comment reply` / `dm send` / `dynamic post` / `dm autoreply set` / `upload video`——逐条比对 `valueFlags`（带值 flag）、`boolFlags`、`bodyPosition`（正文位置参数索引）
3. 重点看三类变化：**新增 flag**（补进清单）、**新增短旗标别名**（补进 `SHORT_FLAG_ALIASES`）、**位置参数增减**（调 `bodyPosition`）
4. 跑 `node test-commands.mjs`（20+ 用例覆盖提取/剔除/fail-close 路径），必要时补新参数形态的用例
5. `node scripts/build.mjs` 后重启 DSH 生效

历史教训（1.3.0 对 0.6.0 的偏差实例）：短旗标 `-t/-f/-i` 未归一化导致位置错位；`dm send` 新增 `--image`（带图私信）被误拦；`upload video` 新增 `--topic/--season/--staff/--reserve` 被误拦。

## 3. skill 重套（`skills/bili-operator/`）

skill 改写自上游包内的 `_skills/bili-cli`（源：`<uv tools 目录>\bili-agent\Lib\site-packages\bili_cli\_skills\bili-cli`）。**结构与说明手法保留上游**，只做以下替换（上游 skill 更新后拿新版重套一遍，git diff 即审查）：

| 替换项 | 规则 |
|---|---|
| 调用形态 | `bili xxx yyy "正文"` → `bili(args=["xxx","yyy"], text="正文")`；代码块去掉 bash 标注 |
| 写命令正文 | 正文一律引导走 `text` 参数；`--file`/stdin 相关说法改为「用 text 传」 |
| 去 CLI 化（ADR-0004 延伸） | agent 可见文本不出现：CLI、命令行、终端、Python、pip、uv、安装、bili-cli 字样；「命令」→「操作」；退出码/stdout 概念删除 |
| frontmatter | `name: bili-operator`；description 里 `through the bili CLI` → `through the bili tool`；`adapted` 字段记改写性质；上游 attribution 不放 skill（放本文件与 README，人类层） |
| 插件层语义 | 开头的附加参数段（text/context/out_file/blocked）、规则里「被拦截就改写」条目、错误码表的两条插件层返回——这三处是我们的增量，重套时保留 |
| 死链检查 | 上游 skill 引用的 references 若在新版不存在（1.3.0 曾引用已删的 commands.md），改为 schema+out_file 查法 |

重套后验证：`Select-String -Pattern 'CLI|命令行|终端|Python|bili-cli|```bash'` 应零命中。

## 4. 其他约定

- **uv tool 的 pin**：`uv tool upgrade` 对 exact pin 安装无效（只升依赖），升版本用 `uv tool install bili-agent==<新版本> --with "typer<0.28" --force`
- **上游 issue 通道**：`gh api repos/kukemc/bili-cli/issues`；typer 0.29 schema 崩溃这个 bug 若上游未修，值得报（最小复现：装 typer 0.29 跑 `bili schema`）
- 基准更新后同步改：本文头部版本号、README「环境要求」的版本
