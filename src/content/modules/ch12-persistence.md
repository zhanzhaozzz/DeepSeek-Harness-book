---
order: 12
title: "第12章：持久化、压缩与遥测 —— 会话如何存活"
summary: "会话恢复、上下文压缩与标题/遥测：日志流派生出的一切。"
status: published
words: 5773
codeLines: 121
minutes: 29
updated: "2026-08-14"
---

# 第12章：持久化、压缩与遥测 —— 会话如何存活

关掉进程，会话还活着吗？这是持久化要回答的问题，也是这本书要回答的最后一个问题。M05 立下了全书的地基：会话日志是唯一的事实来源，模型上下文从它投影，UI 从它渲染，"模型可见即日志"。但日志不能只活在内存里——进程一停，事实就没了。这一章把"唯一"兑现成"可靠"：日志要活到磁盘上，活过进程重启，活到你能把一段对话捡回来继续。docs/architecture.md 的 Session log 一节把这件事说得很完整：

> The session log is the source of the context the model sees. `deriveMessages()` projects model history from it, and raw `assistant/chunk` events preserve replay and UI fidelity. Fork, resume, transcripts, telemetry, and persistence all derive from this stream.

"Fork, resume, transcripts, telemetry, and persistence all derive from this stream"——分叉、恢复、转录、遥测、持久化，全都从这一条流派生。M11 结尾说 M12 是"模型可见即日志"的最终归宿；本章就按派生的顺序走：先看持久化怎么把日志写盘（M05 预告过的"第四个消费者"），再看恢复怎么把日志读回来，接着解决 M10 留下的有限窗口问题（压缩），最后看标题与遥测这两张从日志里长出来的"名片"与"病历"。

---

## 一、持久化：JSONL 后端

**一句话定义：会话持久化是把 append-only 的会话日志变成磁盘状态的持久性接缝——`ctx.sessionPersistence` 定义接口，JSONL 与 SQLite 两个后端实现它，全程不发明第二种"持久化事件类型"。**

### 1.1 从 M03 的那行配置说起

M03 装配 base 层时，有一行你可能扫过就忘了：`session-persistence-jsonl`（`root: !!js dshHomePath('sessions')`）。`!!js` 在挂载时插值出 `~/.dsh/sessions` 之类的根目录，持久化插件就住在这里。它的配置形状是这样的：

*来源：`packages/session/session-persistence-jsonl/src/index.ts` 第 126–133 行，逐字摘录。*

```ts
  static Config: z<Config> = z.object({
    root: z.string().required(),
    packChunks: z.boolean().default(DEFAULT_PACK_CHUNKS),
    compression: JsonlCompressionSchema,
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })
```

逐字段读：`root` 必填——会话文件放哪；`compression` 默认 `zstd`——逻辑 JSONL 被压成**带校验和的拼接 Zstandard 帧**，也可以配置成裸行；`packChunks` 默认开——连续的 `assistant/chunk` 增量在写盘时合并成 `text-chunks` / `reasoning-chunks` / `tool-call-chunks` 存储行，读取时布局无关（`scanLog` 总是解码成行），所以这个开关只改变**新写下的字节**，不改变读到的内容；`writeBatchMaxDelayMs` 是批写窗口的长度，马上就会见到它。磁盘布局是每会话一个文件：`root / 项目目录 / 会话 id 目录 / session.jsonl.zstd`，第一行是 `SessionHeader`，之后每行一个事件。列举会话时只读头行——列表的开销随会话数、不随日志大小增长。

### 1.2 写盘：session/event 订阅者（M05 呼应）

M05 结尾预告过："持久化插件就是订阅 `session/event` 的监听器之一。它把事件缓冲起来，在 `session/flush` 时真正落盘。"现在看实现——persistence 的 coordinator 正是这么挂的：

*来源：`packages/session/session-persistence/src/coordinator.ts` 第 1122–1129 行，逐字摘录。*

```ts
    // Keep a persistence-owned copy of each frozen event and start its bounded window.
    ctx.on('session/event', (session, event) => {
      const live = this.initFor(session)
      live.writes.enqueue(event)
    })

    // Callers use flush as the immediate durability barrier for buffered writes.
    ctx.on('session/flush', session => this.flush(session))
```

注意注释里的措辞：**persistence-owned copy**。事件被 `structuredClone` 进持久化自己的队列，从这一刻起与产生它的会话生命周期解耦——生产者的热路径只是入队，永远不等磁盘。每个会话配一个 `SessionWriteBehind` 控制器，它的 `enqueue` 是批写窗口的心脏：

*来源：`packages/session/session-persistence/src/write-behind.ts` 第 40–56 行，逐字摘录。*

```ts
  /**
   * Copy one event into the persistence-owned queue and start a fixed deadline
   * when the automatic path is idle.
   * @param event - frozen live event to retain independently of its producer.
   */
  enqueue(event: SessionEvent): void {
    const wasEmpty = this.pending.length === 0
    this.pending.push(structuredClone(event))
    if (this.barrier !== undefined) return
    if (this.automaticPaused) {
      this.automaticPaused = false
      this.deadlineExpired = false
      this.armTimer()
    } else if (wasEmpty) {
      this.armTimer()
    }
  }
```

第一个事件启动一个固定 deadline（就是 `writeBatchMaxDelayMs`），后续事件加入同一批但**不重置**截止时间；到期开始一次后台写盘，写盘期间新到的事件领到自己的 deadline、组成下一批。这就是 docs 里说的 flush checkpoint：`session/event` 是同步通知，写盘是异步批处理，`session/flush` 取消等待并**排干到静默点**（quiescence）——所以 agent loop 在认领下一轮 turn 之前，拿它当排序与错误观察的屏障。后台写失败时事件被保留、自动重试暂停；显式 flush 立即重试，失败通过 `agent/error` 和 logger 上报，绝不会变成已关闭 turn 之后的会话事件。

批写最终落在 JSONL 后端：

*来源：`packages/session/session-persistence-jsonl/src/index.ts` 第 421–429 行，逐字摘录。*

```ts
  /** Durably append a batch, lazily materializing the file when not yet present. */
  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    await this.ensureRootEncoding()
    if (isMaterialized) {
      await this.appendLines(meta, events)
    } else {
      await this.materialize(meta, events)
    }
  }
```

`isMaterialized` 区分两条路：文件还不存在，就**物化**（原子地写头行 + 第一批）；文件已存在，就**追加行**。物化的注释一句话点破原子性：

*来源：`packages/session/session-persistence-jsonl/src/index.ts` 第 513–518 行，逐字摘录。*

```ts
  /** Atomically write the header line + first batch (temp-write, fsync, publish). */
  private async materialize(meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const project = projectDir(this.root, meta.cwd)
    const dir = sessionDir(this.root, meta.cwd, meta.id)
    const finalPath = logPath(this.root, meta.cwd, meta.id, this.compression)
    await this.rejectOppositeArtifact(meta.cwd, meta.id)
```

temp-write（临时文件）→ fsync（目录同步）→ publish（原子改名发布），三步把"文件第一次出现"变成崩溃安全的。追加路径同样较真：写前记下文件大小，写完 `writeFile` 再 `fsync`；若写一半失败，把文件回滚到之前的大小再抛错——因为游标没有前进，重试会重写同一批事件，留下半截字节就会造出重复的 seq。append 的契约是"**resolve 只在 durable 之后**"：`append` 返回，事件就已落盘。

### 1.3 append-only 与日志的关系

把这一节放在 M05 的光下看，会得到一个贯穿的事实：**持久化从未发明第二种事件类型**。写盘的就是 `SessionEvent` 本身——带类型的、lossless JSON 的、seq 连续的事件。内存里的 `Session` 与磁盘上的 JSONL 是同一份日志的两个视图：内存视图来自投影，磁盘视图来自追加；因为 seq 必须连续、历史行永不改写，磁盘文件天然就是"append-only 日志的镜像"。SQLite 后端是同一契约的另一个实现——一行一个 `SessionEvent`，行字段 `(session_id, seq, type, time, data, source_event_seqs, surface_op)` 与事件一一对应，同样没有平行的持久化 schema 要同步。两个后端都通过共享的 `runPersistenceContract` 契约套件，所以换后端改的是配置行，不是任何消费方。另外 `SessionPersistence.locate(meta)` 能同步解析出"这个会话的制品路径"——JSONL 返回项目目录里的绝对路径，SQLite 返回 `undefined`（所有会话共享一个库文件）；它是位置提示，不是授权令牌，也不承诺文件已存在或是最新。

---

## 二、恢复：把日志读回来

### 2.1 resume：进程重启后的第一件事

architecture.md 说 "Fork, resume, transcripts, telemetry, and persistence all derive from this stream"。resume 是其中最直白的一个：把持久化的日志读回来，重建一个活的 `Session`，继续跑。入口是 `ctx.agents.resume({ resumeSessionId })`：

*来源：`packages/core/agent-loop/src/index.ts` 第 653–659 行，逐字摘录。*

```ts
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    return this.resumeWith(ownerCtx, persistence, options)
  }
```

没有持久化后端就明确拒绝——resume 的语义是"从磁盘恢复"，不是"凭空再来一遍"。resume 走的读路径是 `persistence.prepare(id)`：后端保留一个精确的、未发布的 `Session`（协调器用一个有界 LRU 缓存它，重复的历史读取与后续的 `prepare` 共享一次读盘、解压、校验、冻结与构造），返回 disposable 的 `SessionPreparation`，loop 用它完成 setup 并发布成活的 `AgentHandle`。而"resume 之前这份日志能不能安全重建"由 resume preflight 负责——它读取 `SessionLogSnapshot`：一次完整的、detached 的、**replay 校验过**的原始日志快照（session-query 的 `readSession`）。读都读不通的日志，不会被放进一个活会话里。

### 2.2 元数据旁置：SessionHeader

日志正文旁边还有一份元数据：格式版本、cwd、血缘、种子边界。为什么它们不放进事件流？因为它们是**存储关注点，不是对话事件**——放进 `SessionEventMap` 会让它们进入 `deriveMessages()` 的投影范围，污染模型视野。所以 `SessionHeader` 独立于事件流存在：

*来源：`packages/core/session/src/types.ts` 第 56–61 行，逐字摘录。*

```ts
export const SESSION_FORMAT_VERSION = 0

/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
export interface SessionHeader {
```

头行随日志一起存储，但语义上"在日志旁边"。它的字段值得逐个认识：`version`——磁盘格式版本，创建时从 `SESSION_FORMAT_VERSION` 盖戳，后端加载时拒绝任何其他版本（没有迁移，常量注释直说）；`id` / `createdAt` / `cwd`；`parentSession`——从哪个会话 fork 出来的种子血缘；`seedLength`——前导事件里有多少是种子继承的，resume/replay 靠它区分父历史与子工作；`origin: 'subagent'`——粗粒度产品分类，方便导航隐藏子代理行；`delegationDepth`——子代理委托深度，**持久化它**是因为递归预算要活过重启，否则恢复出来的孩子会被当成顶层；`agentPreset`——组装该会话 agent 的 preset id，**持久化它**是因为 preset 决定工具的 prompt，恢复出不同的组合等于让模型面对它无法执行的历史。

版本拒绝是硬性的：加载一个版本号超前于本构建的事件日志，抛 `SessionFormatUnsupportedError`，报错文案直接给出方向——"written by a newer harness — upgrade the harness to open it"（这是方向信息，不是损坏）；版本落后则说明本构建没有升级路径。JSONL 后端从**原始头行**就拒绝外来版本——在校验当前头形状、解码任何事件行之前，因为一个结构不同的未来格式本就不该满足今天的结构检查。这就是为什么"损坏"（`SessionPersistenceCorruptionError`）和"格式不支持"是两种不同的错误。

### 2.3 崩溃恢复：孤儿 turn 的葬礼

持久化最尖锐的问题：进程写到一半崩了怎么办？后端重载日志时，发现一个打开的 `turn/start` 没有配对的 `turn/end`。它**不截断**——长任务里一轮 turn 可能巨大（很多步、很大的工具输出），而这些事件在崩溃前就已 durable 追加。它用一个合成的 `turn/end { reason: { kind: 'interrupted' } }` 关掉孤儿 turn——`interrupted` 是唯一一个 loop 永远不会自己发出的结束原因。只有物理上撕碎的尾记录（torn tail）才被截掉：

*来源：`packages/session/session-persistence-jsonl/src/index.ts` 第 691–701 行，逐字摘录。*

```ts
  /** Truncate the log file to `offset` bytes and fsync (discard the crash tail). */
  private async repair(meta: SessionHeader, offset: number): Promise<void> {
    const path = logPath(this.root, meta.cwd, meta.id, this.compression)
    await truncate(path, offset)
    const handle = await open(path, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
```

`repair` 截断到已提交的字节偏移并 fsync；完整解码出来的尾事件与合成的 closing 事件会补写回去（`commitRepair` 的两步：先截断，再追加）。恢复只针对**冷会话**：live 会话的 `load` 会等权威内存快照 durable，并且只在日志平衡时才返回；打开的 live turn 直接拒绝，而不是被塞进合成的中断边界。整条链路画出来：

```text
进程重启
   │
   ▼
SessionPersistence.prepare(id)
   │  读 session.jsonl.zstd：头行 → SessionHeader
   │  解码事件行 → 校验 seq 连续、lossless JSON
   │  发现孤儿 turn/start → 追加合成 turn/end { reason: 'interrupted' }
   ▼
重建不可变的 Session（日志即历史；外部副作用不重放）
   │
   ▼
ctx.agents.resume({ resumeSessionId }) → 活的 AgentHandle → 继续下一轮 turn
```

注意重建这一步的含义：**resume 重建的是日志，不是世界**。工具调用的外部副作用（文件改了、请求发了）不会重放；恢复的是"对话到这个位置为止"的完整记录，以及从它投影出的模型视野。被遮罩的部分（下一节会讲）同样从日志重建——`foldSurface()` 的投影规则在内存和磁盘上是同一套。

### 2.4 投影：冷读的另一条路

还有一个"把日志读回来"的近亲：session-projection。**一句话定义：投影注册表只订阅一次 `session/event`，把每个已提交事件折叠进每个注册单元（`init` / `apply` / `view`），为客户端提供会话当前状态的整值快照——框架驱动，领域只计算。**它和持久化互补：持久化回答"日志在磁盘上吗"，投影回答"从日志派生出的当前状态是什么"。冷读一条持久化会话时，投影缓存走"缓存行 + 持久化 `readFrom` 尾部 + 注册表 `restore`"的阶梯，避免整日志加载；每个投影单元必须纯同步、状态必须 plain JSON——这是持久化缓存的前提，异步单元会撕破客户端的一致性切面。

---

## 三、上下文压缩：当对话太长

### 3.1 为什么压缩：有限窗口（M10 呼应）

M10 的主题是提示词与上下文工程——模型每次请求看到的上下文是一个**有限窗口**：token 上限、KV cache 预算、每次请求都要重发的成本。M05 说模型视野由日志投影，所以**日志无限增长，窗口却有限**——对话足够长之后，迟早有内容放不进模型视野。压缩就是对这对矛盾的回应：与其让旧内容挤掉窗口、或者让请求因超限失败，不如把一段旧表面**替换成一个摘要**。

**一句话定义：上下文压缩是把一段"旧表面"（一段用户/助手/tool 的对话范围）在模型视野里替换成一个摘要节点，同时把这次压缩的完整过程记进日志的操作。**

### 3.2 压缩发生时：三阶段锁

压缩由 `compaction/*` 三个日志事件标记——注意它们全部是 **log-only**：记录锁、摘要、被遮蔽的范围、token 数与模型调用，但**不进表面、不产生消息**（`SurfaceEventType` 故意没有被扩展）：

*来源：`packages/compaction/compaction/src/types.ts` 第 18–23 行，逐字摘录。*

```ts
    /**
     * Marks the start of a compaction — log-only, holds the lock until
     * `compaction/end`. A numbered owner is strictly enclosed by that open turn;
     * `null` identifies a standalone manual transaction between turns.
     */
    'compaction/start': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null }
```

*来源：`packages/compaction/compaction/src/types.ts` 第 67–71 行，逐字摘录。*

```ts
    /**
     * Marks the end of a compaction — log-only, releases the lock. Its owner
     * matches `compaction/start`; `error` records an unsuccessful attempt.
     */
    'compaction/end': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null; error?: string }
```

锁包住**整个**操作：`compaction/start` 先落盘，然后摘要化、`compaction/summary` 记录、替换用 `user/message`（带 `surfaceOp: { op: 'replace', start, end }`——这是摘要压缩执行的**唯一**表面变更）全部落地，最后 `compaction/end` 释放锁。锁最后释放，崩溃就留下可检测的孤儿锁（有 start 无 end），而不是一个谎称压缩完成的 end。`compaction/summary` 携带摘要内容块、被遮蔽的范围与 seq 列表、估算 token 数、以及摘要调用的 provider/model——一次性请求从"日志 + 代码"即可重建，M05 的重建不变量在压缩这里依然成立。

什么被保留？两个层面，务必分清。**日志层面：什么都没删**——被压缩的原始事件原样留在日志里，`shadowedSeqs` 记录哪些表面节点被遮蔽；**表面层面：旧范围被摘要在原位取代**——模型视野里的旧内容变成一段摘要，但"对话的历史事实"一条不少。**压缩不是删除，是遮蔽。**这也解释了为什么压缩后历史仍可审计：原始事件还在，遮蔽范围还在，从日志重建完整历史永远可能。

什么时候触发？自动策略跑在串行的 `agent/pre-step`（请求派生之前）：`compactIfNeeded(agent, trigger)`，trigger 分两种——`pressure`（常规压力）与 `context-overflow`（provider 确认的上下文溢出，允许比常规更激进的缩减）；空闲时 `compactNow` 做一次维护性缩减（即使低于压力阈值，只要存在有用的范围）；`compactRegion` 显式压一段包含的范围。可选的 `ctx.toolResultPruner` 在选范围之前先修剪超预算的工具结果——确定性的 head/middle/tail 修剪，按 Unicode 码点计量，可以不动摘要就让表面瘦身。

### 3.3 compaction 是能力接缝（M09 呼应）

M09 我们读过能力接缝的三角色模型。压缩正是教科书式的一例：Service Definition（`dsh-compaction`，`ctx.compaction`）声明接口；Service Provider（`dsh-compaction-basic`）实现触发策略、保留策略与摘要化；Consumer（`dsh-command-compact`）是人类可用的压缩命令。它**不是 agent-loop 主干的一部分**——一个可选能力，不装它 loop 照常跑，只是对话会一直长下去。token 计量也不在压缩缝内：单例 `ctx.tokenMeter` 直接拥有估算与重放，`dsh-compaction-basic` 拥有保留、事件排序与路由摘要调用。换一个摘要后端（tokenizer 式、模板式）就是换一个 sibling 包——接口不变，模型看到的行为不变。

---

## 四、标题与遥测：会话的"名片"与"病历"

### 4.1 标题：会话的名片

`ctx.sessionTitle` 是 `SessionTitleService`——"Log-backed title fold plus asynchronous fallback generation"：从日志折叠最新标题，加上异步的备选生成。M03 的 base 里见过它的配置行（`session-title-llm` 系列）：

*来源：`packages/session/session-title/src/index.ts` 第 263–267 行，逐字摘录。*

```ts
  static Config: z<Config> = z.object({
    fallbackMaxWords: z.number().step(1).min(1).required(),
    fallbackMaxBytes: z.number().step(1).min(1).required(),
    maxTitleBytes: z.number().step(1).min(1).required(),
  })
```

服务的关键在"从日志派生"：标题是 `session/title` 事件（log-only、latest-wins），`get(session)` 从日志折叠出最新标题——不另存一份"标题状态"。三种来源：内置 fallback（取第一条人类消息文本、按 `fallbackMaxWords` 截断）、注册的 provider（`register()`，自动模式 `first-prompt` / `all-prompts`，异步生成，可被取代与取消）、用户显式改名（`rename()`——**钉住**标题，自动生成停止调度，`refresh()` 是刻意的解钉）。标题请求本身也被记录（`SessionTitleLlmRequestEventData` 重现模型可见的 system 与消息输入、路由、输出上限）——"模型可见即日志"连辅助请求都不放过。

### 4.2 遥测：会话的病历

遥测把会话日志镜像成可上报的记录。`SessionTelemetryRecord` 是捕获契约的完整对外词汇：

*来源：`packages/session/session-telemetry/src/index.ts` 第 57–66 行，逐字摘录。*

```ts
/**
 * One logical record handed to a backend — the capture contract's whole outbound
 * vocabulary. Ledger records mirror session-log events one-to-one;
 * operational records (`channel: 'ops'`) carry the two signals with no log
 * home (`agent-error`, `shutdown`) and deliberately omit `event.seq`-style
 * identity so they can never be mistaken for ledger rows.
 */
export interface SessionTelemetryRecord {
  /** Ledger (session-log mirror) or ops (operational signal) channel; backends keep the two under separate instrumentation scopes. */
  channel: 'ledger' | 'ops'
```

两条信道：**ledger**（账本）——会话日志事件的一对一镜像；**ops**（运维信号）——两个在日志里没有家的信号（`agent-error`、`shutdown`），故意不带 seq 身份，永远不会被误认成账本行。遥测也是接缝：Service Definition（`dsh-session-telemetry`，`ctx.sessionTelemetry`）拥有捕获点与最小后端契约，Service Provider（`dsh-session-telemetry-otel`）是 OpenTelemetry JS SDK 的日志管线——M03 见过它在 base 里**默认 DISABLED**，需要时由部署装载。边界公理：**harness 的职责止于 `emit()`**；批处理、重试、排队、丢失策略全归上报 SDK。传输是 best-effort：游标标记的是"已移交"不是"已送达"，记录可能丢（崩溃、重载窗口）也可能重复（游标丢失后的重新收养、SDK 重试），所以接收方按 `(session.id, event.seq)` 去重账本记录。一个容易误读的细节：每个 `(turn, step)` 只上报第一条 `assistant/chunk`（流开始的信号），其余在捕获点丢弃——线上的 seq 有空档是常态，不是丢失信号。隐私落在 `session-telemetry/record` 瀑布——脱敏规则由部署挂载，seam 自己**不带任何规则**；脱敏只作用于导出副本，规范日志永不重写。

### 4.3 从日志派生，不另起炉灶

把这一章出现的所有东西放在一起，你会看到同一个模式：**持久化、恢复、压缩、标题、遥测，没有一样另起炉灶**。持久化把日志写盘；恢复把日志读回来；压缩在日志上追加 log-only 事件并替换表面；标题从日志折叠 latest-wins；遥测镜像日志事件。M05 说"日志是唯一事实来源"，M12 把它兑现成工程的每一个角落——这就是"Fork, resume, transcripts, telemetry, and persistence all derive from this stream"的字面意思：**会话的一切派生都从这一条流来，会话的生死也都系于这一条流。**

---

## 五、全书回望：一棵树的完整旅程

把十二章的路线图放在一张图里，你会看到整本书就是一棵从配置长出来的树：

```text
M03  cordis.yml 装配（base + 模式 patch：!!js 插值、行替换、insert——配置即组合）
  → M02 插件树（注入图：services / events / effects——一切都是插件）
  → M04 turn flow（step = 一次模型请求 + 其工具执行；agent/pre-step 先行）
  → M05 会话日志（append-only SessionEvent，唯一事实来源；"模型可见即日志"）
  → M06 模型调用（ctx.llm 适配器；llm/stream 包装流 → assistant/chunk* 落日志）
  → M07 工具系统（ctx.tools：注册、作用域、执行管线）
  → M08 事件与广播（session/event：post-commit、fire-and-forget，append 即提交）
  → M09 能力接缝（Service Definition / Provider / Consumer 三件套）
  → M10 提示词与上下文（system-prompt 分节、工具 schema 组装——模型视野有窗口）
  → M11 子代理与工作流（ctx.subagents：一个接口，多个分身）
  → M12 持久化、压缩与遥测（日志写盘 → 读回 → 压缩 → 标题/遥测派生）
```

这本书到此读完。下一步不再是"读书"，而是"读源码本身"。建议的路径：先重读 `docs/architecture.md`——全书地图，改 `packages/` 前必读；然后打开 `packages/core/` 下每个包的 README——每个包一份契约（配置、语义、限制、扩展点）；最后顺着 `src/` 读实现，从 `packages/core/session/src/` 的 `Session` 开始，你会发现自己已经认得每一个类型。这本书也会随仓库演进：章节在 `dsh-book/src/content/modules/*.md`，已发布章的 `words` / `codeLines` / `minutes` 用 `node scripts/meta.mjs` 重算，本地 `npm run dev` 起站、`npm run build` 出静态产物。若你在源码里发现与本书不符之处，欢迎按 `docs/` 的规范提修正——书是活的，和代码一样。

---

## 六、本章小结与全书结语

### 6.1 本章小结

把"会话如何存活"压成几条笔记。**持久化**是日志的磁盘镜像：`session/event` 订阅者把冻结事件缓冲进有界窗口，`session/flush` 排干到静默点，JSONL 后端 append-only 批写、temp-write + fsync + rename 原子物化、写一半回滚，全程不发明第二种事件类型。**恢复**是把日志读回来：`prepare` / `load` 重建不可变 `Session`，孤儿 turn 用合成 `interrupted` 关闭、只有撕碎的尾记录才截断，`SessionHeader` 把元数据放在日志旁边，版本不符明确拒绝。**压缩**回应有限窗口：log-only 的 `compaction/start` 锁住整个操作，摘要骑在 `user/message` 的 replace 上，原始事件永不删除、只是被遮蔽。**标题与遥测**都是从日志派生的：latest-wins 折叠与 ledger 镜像，不另起炉灶。十二个字收束全章：**日志活，会话就活。**

### 6.2 全书结语：读完这本书之后

这本书从 `cordis.yml` 的一行配置开始，到磁盘上的一个 JSONL 文件结束——中间隔着插件树、turn flow、日志、模型、工具、事件、接缝、上下文、分身，最后是会话的生死。你带走的最重要的东西不是任何一个 API，而是一把判断尺子：**在这个仓库里，一切派生都从日志来，一切扩展都从接缝走**。带着它去读任何一份源码，你都会比大多数读者更快地找到"事实"在哪里、"缝"在哪里。现在，打开 `packages/core/session/src/types.ts`——你已经认识 `SessionEventMap` 的每一个键了。源码见。
