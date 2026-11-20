# ADR-0005: 工具面收成单一 bili 入口，命令知识移入 skill

状态: accepted（2026-11-13 用户决策）

## 背景

v0.2 的 17 工具面镜像上游 MCP 的 curated 形态。两个压力让它不可持续：

1. **上下文成本**：17 份工具 schema 常驻每个运营会话；上游 CLI 0.6.0→1.3.0 新增 26 条命令（data 八件套、dm watch、danmaku peaks 等），照旧「一条命令一个专用工具」地补，工具面很快滚到 30+，schema 常驻成本线性膨胀。
2. **维护倒挂**：CLI 每次升级都要人工评估补哪些工具、更新哪些参数；上游不加新 MCP 工具时（1.3.0 仍 17 个），差距全落在本插件肩上。

同时上游自带一份结构成熟的 skill（SKILL.md + references 三层渐进披露），本来就是为「少量入口 + 文档承载命令知识」的形态写的。

## 备选

- **继续加专用工具**：上下文继续膨胀；每条新命令一次评估；放弃。
- **按域分组几个工具**（bili_video / bili_dm / …）：缓解但治标，组内参数漂移依旧；分组边界随上游演进难以稳定；放弃。
- **单一入口 + 识别表审查 + skill 承载命令知识**：一个 `bili` 工具，args 传操作数组；写命令识别表（commands.ts 硬编码六条）提取正文过审查门，其余直通；skill 改写自上游（结构与说明手法保留，调用形态适配）。

## 决策

单一 `bili` 工具（args / text / context / out_file / max_chars 五参数）：

- **识别表**：comment post/reply、dm send、dynamic post 恒审；upload video、dm autoreply set 各受独立配置开关控制（默认开）。正文优先级 `text` > 位置参数 > `--file <path>`（读文件）；识别为写操作但正文提取不出 → fail-close 拦截。`--dry-run` 跳过审查（预览不发）。正文含 `<…>` 占位符（reply_with 未替换的典型症状）直接拦。
- **审查覆盖实际扩大**：原 `bili_run` 直通通道的写操作不过审（ADR-0002 拍板的已知豁免）；统一入口后六类写操作全部过门。
- **大输出落盘**：`out_file` 写完整结果返摘要；不落盘时 `max_chars`（默认 8000）截断保护。`schema` 这类 68KB 输出永不直接进上下文。
- **skill**：改写自上游 bili-cli skill（MIT；结构与说明手法保留，调用形态改为 `bili(args=[...], text=...)`，agent 可见文本去 CLI 化——ADR-0004 判定标准延伸覆盖 skill），存放插件仓 `skills/bili-operator/`，host 启动与 agent 创建时 junction 到运营 workspace 的 `.agents/skills/`（单一真源；绝不写用户全局 skills 根；已存在条目不动）。上游 skill 更新时按同一套替换规则重套一遍，diff 可 review。
- 演练章程、场景章程默认值、运营会话白名单（`bili_` 前缀 → `bili`）同步更新。用户已保存的旧自定义章程里可能仍引用旧工具名，升级后需自查。

## 后果

- 常驻上下文从 17 份 schema 降到 1 份；命令知识按需经 skill 渐进披露。
- agent 拼错参数的校验从「工具 schema 强类型」退化为「底层 invalid_argument + hint 自纠」，多一次往返；skill 教学质量变得关键。
- 识别表与 CLI 参数布局可能漂移（上游改 flag）：未知 flag 一律 fail-close 并提示改用 `text`，错误形态安全；升级 CLI 时的核对流程与 skill 重套规则见 [../maintenance.md](../maintenance.md)。
- `mcp`/`skills` 两个一级 root 继续拒绝；`asr` 按既有决策放行（配置类但用户明确要求支持）。
- ADR-0002 的白名单方案正式退役，其 superseded 注记所述「直通不过审」形态被本 ADR 收窄。
