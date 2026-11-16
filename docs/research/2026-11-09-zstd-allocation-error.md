# 工具调用成批报「Allocation error : not enough memory」——zstd 会话压缩撞上系统提交内存耗尽

> 版本基准：`@deepseek-ai/dsh@0.2.2-rc.1`（本机安装树 `D:\code\env\node-v24.13.1-win-x64\node_modules\@deepseek-ai\dsh`，Node v24.13.1，Windows）。
> 起因：2026-11-09 深夜，web 会话一轮里四个互不相干的工具调用（schedule_list / 本地 grep ×2 / 外部网页搜索）全部返回同一句 `Error: Allocation error : not enough memory`，用户报「本轮运行失败」。

## 1. 报错出处：不是 DSH 的文案，是 libzstd 的

- 该字符串在 DSH fork 源码全文检索**零命中**；它是 **libzstd 错误码 11 的原生报错文案**（业界同款：zstd CLI 报 `zstd: error 11 : Allocation error : not enough memory`，PostgreSQL/Greenplum 的 zstd 解压失败也是这句）。
- Node v24 的 `node:zlib` 内置了 zstd 接口（`zstdCompress` / `zstdDecompress` / `zstdDecompressSync` 等，本机已实测存在），所以 Node 进程能把这句话原样抛出来。

## 2. 为什么一轮里所有工具一起报：会话日志压缩层

- DSH 安装树内官方包 **`@deepseek-ai/dsh-session-persistence-jsonl`**：`DEFAULT_COMPRESSION = "zstd"`，包内压缩枚举 `zstd | none` 默认 zstd；会话落盘文件名 `session.v4.jsonl.zstd`。
- 本机实测 `~/.dsh/sessions`：235 个会话文件**全部** `.zstd` 后缀。
- 工具执行结果要追加进会话日志 → **每次工具调用都过 zstd 压缩**。压缩环节分配内存失败时，该轮所有工具（不管工具本身是查数据库、读文件还是调外部服务）统一报这一句。这就是四个不相干调用报一模一样错误的原因——失败点不在各工具内部，在它们共用的落盘通道上。

## 3. 根因：本机「提交内存」耗尽，DSH 不背锅

「提交内存（commit）」= 物理内存 + 页面文件构成的总量配额；配额见底时，任何进程的新分配都可能失败。实测（128GB 物理内存）：

| 观察项 | 数值 |
|---|---|
| 罪魁：MiHoYo-Unpack 工作区 AnimeStudio.CLI（dotnet）×3 并行解包 | 私有提交内存 61.65 + 60.98 + 26.14 ≈ **148GB**，观察期内单个进程还在 61→76GB 上涨（期间一个退出） |
| 页面文件（系统托管，动态收缩） | AllocMB 72325（70GB，提交上限 198.5GB）→ 55432（54GB，上限 182GB）——压力越大上限反而被缩，形成恶化循环 |
| 提交水位（事后） | 169~174 / 182GB；报错时刻更高（第三个解包进程尚在，+26GB） |
| DSH 进程树本身 | 主进程 WS **0.36GB**（`--max-old-space-size=16384` 是防 V8 堆崩溃的另一档保险，与本次无关）；runner 子进程全部 <0.05GB |

## 4. 处置与预防

- **治本在外部负载**：重型批处理（本例 AnimeStudio 解包）限并发 / 错峰；页面文件改**固定大小**（C 盘余量 300GB，初始=最大，防系统动态收缩把提交上限拉低）。
- **排障口诀**：先看谁在吃 `PrivateMemorySize64`（`Get-Process | Sort-Object PrivateMemorySize64 -Descending`），不是先怀疑 DSH。已录入 ops 正典（momojie-assistant `ops/home/dsh/dsh.md` 症状速查表）。
- **DSH 侧可选项（不建议动）**：会话持久化压缩有 `none` 档可关 zstd，只是把「压缩分配失败」换成「磁盘占用 + IO 上升」，治标不治本。
- **与旧故障的区分**（两句报错不同、修法不同）：
  - `JavaScript heap out of memory` = DSH 自己的 V8 堆到顶（速查表既有行，已用 16GB 堆上限缓解）；
  - 本文的 `Allocation error : not enough memory` = **系统级提交配额**被外部进程挤压，zstd 只是第一个够不着内存的环节。
