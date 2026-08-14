---
order: 5
title: "第5章：会话日志 —— append-only 事件流"
summary: "会话日志是模型所见上下文的唯一来源：「模型可见即日志」的不变量如何被强制。"
status: published
words: 4661
codeLines: 104
minutes: 23
updated: "2026-08-14"
---

# 第5章：会话日志 —— append-only 事件流

M04 的 turn flow 图里有一行，你可能一眼就扫过去了：`derive model history from the log`——"从日志派生模型历史"。当时我们没展开：日志是什么？为什么模型看到的历史要"派生"，而不是直接存一份对话记录？本章就把这一行背后的整个子系统讲透。答案是一个贯穿全书的决定：**对话历史不是"存起来的记录"，而是"唯一的事实来源"——日志先于一切存在**。模型上下文从它投影，UI 从它渲染，fork/resume 从它重建，telemetry 从它派生，持久化不过是把它写盘。下游再多，都是同一条日志的不同读法。本章五步走：先看日志里每一行的类型，再看为什么只能追加，然后看模型历史怎么投影出来，接着用一条运行时不变式把"模型可见即日志"钉死，最后看日志怎么广播给全世界。

---

## 一、SessionEvent：日志里的每一行

**一句话定义：SessionEvent 是一条 append-only 的持久事实——带类型的、不可变的、JSON 可序列化的日志行，是整个对话历史唯一的记录单元。**

### 1.1 事件词表：SessionEventMap

日志里能写什么，由一张"事件词表"决定。它的真名是 `SessionEventMap`——一个声明在 `packages/core/session/src/types.ts` 里的接口。先看它的头：

*来源：`packages/core/session/src/types.ts` 第 230–236 行，逐字摘录。*

```ts
/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. Every event is lossless JSON and
 * sequence numbers stay contiguous, including raw chunks, so persistence can
 * store the canonical log verbatim.
 */
export interface SessionEventMap {
```

三句话把整章的结论都说了：**merge-extensible**（可合并扩展）、**append-only**（只追加）、**lossless JSON 且 seq 连续**（持久化可以逐字存）。中间略去 `turn/start`、`turn/end`、`step/start`、`step/end` 这些边界事件，直接看真正"进对话"的消息事件——用户消息、原始流块、组装好的助手消息（`tool/call` 与 `tool/result` 这对在第 274–297 行，这里不逐字贴出，但 4.2 的运行时断言摘录里你会再见它们）：

*来源：`packages/core/session/src/types.ts` 第 257–273 行，逐字摘录。*

```ts
  /**
   * A user-role message on the model-visible surface: a direct human prompt
   * (the queued message claimed for this turn), a synthetic `agent.inject()`
   * context (file-change notices, subdir AGENTS.md, skill content, cron
   * notifications, …), or an entered goal continuation round. All three
   * project their `content` verbatim; `source` tells them apart.
   */
  'user/message': UserMessage
  /** Raw stream chunk — token-level replay fidelity. */
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  /**
   * Assembled assistant message for one step (derived history uses this).
   * Carries the step's `usage` when the adapter reported token accounting, so
   * the model output and its accounting travel together (there is no separate
   * usage record). `usage` is absent when the adapter reported none.
   */
  'assistant/message': { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }
```

逐个读：

- `user/message`：用户角色的消息，三种来源——直接的人类提示（本轮认领的排队消息）、`agent.inject()` 合成的上下文（文件变更通知、子目录 AGENTS.md、skill 内容、cron 通知……）、进入的 goal 续跑轮。三种都**逐字投影** `content`，靠 `source` 区分。
- `assistant/chunk`：**原始流式块**，注释四个字点题：token-level replay fidelity——token 级重放保真。
- `assistant/message`：组装好的助手消息，注释说得很清楚："derived history uses this"——**派生模型历史用的是它**。`usage` 随行携带，没有单独的 usage 记录。
- `tool/call` + `tool/result`（完整声明在 types.ts 第 274–297 行）：模型请求一次工具调用——`name` 加模型产出的**原始 `arguments` JSON 字符串（未解析）**，`callId` 把调用和结果配对；结果侧是 `message: ToolResultMessage` 加可选的内部失败 `error` 与工具私有 `meta`。`meta` 对 core 不透明，但**必须 JSON 可序列化**——append 时用 `isJsonValue` 校验，不合格直接在源头被拒。

### 1.2 一张会生长、能扩展的词表

`SessionEventMap` 是接口，所以它有两个关键性质。

第一，**声明合并（declaration merging）**：任何插件都可以 `declare module` 往这张表里加新键，日志的词表随插件生长。session.md 举的例子：compaction seam 加了 `compaction/start` / `compaction/summary` / `compaction/end`，`@deepseek-ai/dsh-hook-protocol` 加了 log-only 的 `hook/invoked` / `hook/result`。这类插件事件**不是** `SurfaceEventType`（不携带 `surfaceOp`，不产生消息），但同样是合法的日志行。

第二，**`SessionEventType = keyof SessionEventMap`**：所有事件类型就是这张表的键集合。`SessionEvent` 是**按 `type` 的 proper discriminated union**（不是独立的 `type`/`data` 联合），所以 `switch (event.type)` 能直接收窄 `event.data`，不需要任何 cast。因为词表可扩展，switch 不能用 `assertNever`——插件加的新变体是合法的未知值，处理已知情形后落到 `default` 即可。另外词表增长不需要 bump 格式版本：`SessionEvent` 信封上的 `ignorable: true` 标记告诉读者"遇到不认识的事件可以安全跳过"，缺省则视为必需——忘了打标记最多是过度拒绝（不方便），绝不会静默恢复一个被掏空的会话。

### 1.3 键名拼错，编译期就报错

`Session.append` 的签名把词表和调用点焊在一起了：

*来源：`packages/core/session/src/index.ts` 第 604–608 行（`Session.append` 签名），逐字摘录。*

```ts
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T> {
```

三处值得注意：

1. `type: T` 和 `data: SessionEventMap[T]` 用**同一个类型参数 T** 索引——键名拼错（不在词表里），T 无法满足约束，编译期直接报错；键名对但 payload 类型不匹配，同样报错。
2. `...opts` 是一个**条件元组**：`T extends SurfaceEventType ? [opts: SurfaceIntent] : []`。产生消息的事件（`user/message`、`assistant/message`、`tool/result`）**必须**传 surface 元数据（`surfaceOp` + `sourceEventSeqs`）；log-only 事件（`turn/start`、`assistant/chunk`）**禁止**传——编译器在调用点强制执行，传了就编译不过。
3. 类型之外还有运行时保险：`data` 必须通过 `isJsonValue` 的 lossless-JSON 校验，详见 2.1。

---

## 二、append-only 语义——只追加、不修改

### 2.1 为什么只追加

session.md 的开篇一句话把定位说死了（原文照抄）：

> The in-memory, event-sourced model of `dsh-session`. A `Session` is an **append-only log** of typed `SessionEvent`s — the single source of truth for an agent's whole interaction history. The LLM message history is *derived* from the log, never stored separately; replay is re-derivation from the same events.

*来源：`docs/subsystems/session.md` 第 5 行。*

**只追加意味着两件事：一是重放保真**——"重放"不是恢复一份快照，而是把同一条日志**再派生一遍**（replay is re-derivation from the same events），日志里少任何一行，重放结果就不同；**二是审计与不可变**——事件一旦入 log 即提交，之后没有任何人（包括 cast 和普通 JS）能改写它。

"不可变"在实现上是三条硬保证，都在 `Session.append` 里：

1. **JSON 可序列化**：`snapshotJsonValue(data)` 一遍递归地读、校验、复制。BigInt、函数、symbol、undefined、负零、非有限数、循环引用、稀疏数组、Map/Set/Date/类实例，全部在 append 处 throw——**坏事件在源头失败，而不是在后端落盘时才失败**。同时这一遍递归让"校验用的值"和"入库的值"是同一个值：有状态 getter 不可能给校验一套、给存储另一套。
2. **seq = log.length**：每个事件的 seq 就是追加那一刻日志的长度，天然连续、严格递增、无空洞。`session.seq` 的注释直说这是契约："always the log length (the `seq = log.length` contiguity contract)"。
3. **深冻结**：事件连同嵌套 data 在接纳时 `deepFreeze`；`session.events` 返回的是复用的不可变快照——"neither a cast nor ordinary JavaScript can rewrite durable history"。

日志生长示意（拿一轮对话的头部为例，事件顺序就是 M04 turn flow 的顺序）：

```text
seq 0   turn/start          { turn: 1 }                ← 打开第 1 轮
seq 1   step/start          { turn: 1, step: 1 }       ← 一次模型调用 + 其工具执行
seq 2   user/message        { role: 'user', ... }      ← 进入 step 的消息（content 逐字）
seq 3   request/header      { header: {...} }          ← 本 step 请求的完整信封（log-only）
seq 4   assistant/chunk     { delta: '我' }            ← 原始流块（token 级重放保真）
seq 5   assistant/chunk     { delta: '是' }
seq 6   assistant/message   { message: {...}, usage }  ← 组装好的助手消息（派生历史用）
seq 7   tool/call           { callId: 'c1', ... }      ← 模型请求一次工具调用
seq 8   tool/result         { message: {...}, meta }   ← 与 callId 配对的工具结果
seq 9   step/end            { turn: 1, step: 1 }
seq 10  turn/end            { turn: 1, reason: ... }
          │
          ▼  只往尾部追加：seq 严格递增且连续，历史行永不改写
```

### 2.2 in-memory store 与 Session

`Session` 是普通类（不是 Service），`ctx.sessions`（`SessionStore`）是内存 store。两者关系的分工，index.ts 的类注释一句话讲完：

*来源：`packages/core/session/src/index.ts` 第 786–791 行（`SessionStore` 类注释），逐字摘录。*

```ts
/**
 * In-memory session store (`ctx.sessions`).
 *
 * Persistence is intentionally not implemented here — persistence plugins
 * subscribe to `session/event` and flush on `session/flush` / dispose.
 */
```

注意那个 "intentionally"：**持久化故意不在这里实现**。store 只负责活的会话对象与广播；落盘是插件的事——插件订阅 `session/event` 拿到每个事件、在 `session/flush` 时把缓冲写盘。这是第 12 章的前置预告，5.2 节我们还会回到这条链路上来。另有一个生命周期细节值得记住：store 的 `create()`/`prepare()`/`enter()`/`announce()` 是四段式，agent 工厂把会话生命周期折进它自己的**一个** `ctx.effect` 里，保证卸装时 store 先于 driver 拆除、driver 的收尾事件不会丢。

---

## 三、deriveMessages：模型历史从日志投影

### 3.1 架构文档的原话

architecture.md 的 Session log 一节，四句话定义了整个子系统：

> The session log is the source of the context the model sees. `deriveMessages()` projects model history from it, and raw `assistant/chunk` events preserve replay and UI fidelity. Fork, resume, transcripts, telemetry, and persistence all derive from this stream.

*来源：`docs/architecture.md` 第 94 行。*

逐句拆：

- **日志是模型所见上下文的来源**——不是"之一"，是 "the source"。
- **`deriveMessages()` 从它投影模型历史**——投影（project），不是拷贝。
- **原始 `assistant/chunk` 保留重放与 UI 保真**——见 3.3。
- **fork、resume、transcripts、telemetry、persistence 全部从这条流派生**——第 4 节会论证为什么这件事成立。

### 3.2 投影规则

`deriveMessages()` 的做法（session.md 的说法）：沿 `surfaceOp` 标记维护的消息事件序列走一遍，对每个 surface 节点 fold 纯函数 `deriveEventMessage`。规则一共五条：

- `user/message` → 一条 user 消息，`content` 逐字。
- `assistant/message` → 一条 assistant 消息，带上产出它的 provider 与 model。**空内容的 `assistant/message` 跳过**——max-tokens 截断时那条只为了装 usage/provider/model 而记的消息，不能以空助手回合的形式进模型上下文。
- `tool/result` → 一条带 `tool-result` block 的 user 消息。
- 原始 `assistant/chunk` **跳过**——组装好的消息才是权威（assembled message is authoritative）。
- 其余（`turn/*`、`step/*`、插件自有事件）是结构性事件，不投影成任何消息。

缓存上有两个值得记住的细节：每个 surface 节点**只投影一次**（首次见到时），所以每次调用的成本是 O(新节点)；返回的数组每次是**新鲜快照**，但里面的 `Message` 对象是**共享且深冻结**的——想通过投影视图改动日志历史，在类型系统里就表示不出来。

### 3.3 为什么保留原始 chunk

既然 `assistant/message` 已经是组装好的权威消息，为什么日志还要存一堆 `assistant/chunk`？两个原因：

1. **UI 保真 / token 级重放**：chunk 是模型输出的原始流块，逐 token 记录了"这条消息是怎么长出来的"。聊天界面想逐字重现打字效果、回放想忠实还原流式过程，靠的都是它。
2. **durability 契约**：持久化必须逐事件无损存下**包括 chunk**——`seq` 必须连续，所以 chunk 不能被过滤出 canonical 日志（session.md 的 Durability contract 原话："persists every event losslessly, **including** `assistant/chunk`"）。

派生与存档是两条不同的路：**模型上下文用组装消息，存档与回放要原始流**。人类可读的 transcript 又不一样——它读的是 append 原点的表面事件，而不是派生表面，因为派生表面会故意遮蔽被 compaction 替换掉的区间。telemetry 则最精打细算：每个 `(turn, step)` 只发第一条 `assistant/chunk`（stream-started 信号），其余在捕获点就丢弃，所以 wire 上 `seq` 有空洞是常态，不是丢数据（session-telemetry.md）。

### 3.4 投影文档的要点

session-projection.md 描述的是另一个投影体系（给 UI 提供"整值"），但它的分工原则值得记：**框架驱动、领域计算**——registry 只订阅一次 `session/event`，把每个已提交事件 fold 过所有已注册的投影单元；领域插件不持有任何订阅，只交三个纯函数（`init` / `apply` / `view`），客户端拿到的永远是算好的整值。它还有一条"整值事件规则"：带状态的日志事件携带**变更后的完整状态**，绝不只带 delta——每个转换都便宜，每个值都自描述（last-wins for consumers）。

---

## 四、模型可见即日志：一条运行时不变式

### 4.1 架构文档的原话

architecture.md 紧接着 Session log 一节，给了全仓库最著名的一条纪律（原文照抄）：

> **Model-visible means logged.** Anything that reaches a model request must be reconstructable from the log, and a runtime invariant asserts it. This is why a new model-visible input requires a new session event: extend `SessionEventMap` and render from the log.

*来源：`docs/architecture.md` 第 96 行。*

两个断言：**凡是到达模型请求的东西，都能从日志重建**；而且这不是口号——**有一条运行时不变式在断言它**。

### 4.2 运行时断言长什么样

`packages/core/session/src/invariant.ts` 是 `dsh-session` 自己的 invariant companion（随 `dsh-invariants` 加载启用）。它为每个会话维护一个游标（`lastSeq` / `openTurn` / `openStep` / `nextTurn` / `nextStep` / `pendingCalls`），对每个候选事件**提交前校验、提交后应用**（校验是纯函数，通过弱键暂存转移，谁 veto 都不污染会话状态）。看两段真断言。

第一段：seq 必须严格递增——append-only 的第一性：

*来源：`packages/core/session/src/invariant.ts` 第 54–62 行，逐字摘录。*

```ts
/** Validate one candidate event without mutating the committed trace. */
function validateEvent(
  trace: SessionTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): SessionTraceTransition {
  if (event.seq <= trace.lastSeq) {
    fail(`seq must strictly increase: saw ${event.seq} after ${trace.lastSeq}`)
  }
```

第二段：`tool/result` 必须与**同一 step** 里先出现的 `tool/call` 配对——"有结果必有调用"：

*来源：`packages/core/session/src/invariant.ts` 第 122–144 行，逐字摘录。*

```ts
    case 'tool/call': {
      requireOpenStep(trace, 'tool/call', event.data.turn, event.data.step, fail)
      pendingCalls = { kind: 'add', callId: event.data.callId }
      break
    }
    case 'tool/result': {
      // Session has already validated a content rewrite that cites its replaced event.
      // It is durable turn work, not a second execution of the original call.
      if (event.surfaceOp !== 'append') {
        if (trace.openTurn === null) {
          fail('tool/result surface replacement appended outside any open turn')
        }
        break
      }
      requireOpenStep(trace, 'tool/result', event.data.turn, event.data.step, fail)
      const callId = event.data.message.source.callId
      const syntheticNotStarted = event.data.message.content[0].isError === true && event.data.error?.code === TOOL_NOT_STARTED
      if (!trace.pendingCalls.has(callId) && !syntheticNotStarted) {
        fail(`tool/result for ${callId} with no prior tool/call in this step`)
      }
      pendingCalls = { kind: 'delete', callId }
      break
    }
```

同类断言还有一串：`turn/start` 不能叠在开着的 turn 上、turn 号必须按 `nextTurn` 递增；`step/start` 必须在开着的 turn 里且 step 号连续；`step/end` 时清空 `pendingCalls`；`todo/write`、`request/header`、`request/context` 必须在某个开着的 turn 内（core 执行事件必须 turn-enclosed）。注意最后的 `default` 分支：**merge-extensible 事件的关系属于声明它的插件**，core 不会仅仅因为"没有开着的 turn"就拒绝一个不认识的事件。

### 4.3 推论：新增模型可见输入 = 新增 session 事件

把 4.1 的纪律反转过来，就是开发准则（AGENTS.md 的原话）：**"Model-visible ⟺ logged: anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event."** 想让模型看到任何新东西，只有一条合法路径：扩展 `SessionEventMap`、append 事件、从日志渲染。不存在"绕过日志直接塞上下文"的旁路——即使真有，那也是违反不变式的 bug。

这套设计换来的就是 3.1 说的"日志可重建一切"：**fork**（`ctx.sessions.fork` 从某个稳定前缀 seed 出子会话）、**resume**（重启后用存下来的日志重新构造 Session）、**transcripts**（人类可读的对话记录）、**telemetry**（ledger 记录镜像日志事件）、**persistence**（后端逐事件存 canonical 日志）——全是同一条日志的不同读法。连请求信封本身都是日志状态：`request/header` 事件携带完整 `EpochHeader`（call config、渲染好的 system prompt、组装好的 tool schemas），`foldRequestHeader(events)` 取最新快照重建——所以**每次对话请求都是日志的纯函数**。

---

## 五、session/event 广播：日志如何走向世界

### 5.1 事件声明

日志自己不会动。它走向世界的唯一出口是 `session/event` 这个 Cordis 事件，声明在 `packages/core/session/src/index.ts`：

*来源：`packages/core/session/src/index.ts` 第 65–76 行（`'session/event'` 事件声明），逐字摘录。*

```ts
    /**
     * Post-commit, fire-and-forget append feed. The listener snapshot resolves
     * before the log push, but callbacks run after it; observer failures are
     * logged and contained without making the committed append fail.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only events from sessions entered through that agent's context.
     * @param session - the session whose log grew.
     * @param event - the appended event, exactly as recorded.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
```

### 5.2 语义：post-commit、fire-and-forget

`@mode emit` 是 Cordis 的分发模式注解——广播出去，不等结果。逐词拆：

- **Post-commit**：先 `log.push(event)`（提交点），再广播。监听器快照在 push **之前**解析、回调在 push **之后**执行——顺序有保证，但任何监听器都无法阻止这次 append。
- **Fire-and-forget**：append 的 hot path 永远不等 I/O。每个监听器的失败被**记录并隔离**（logger.warn），既不影响返回值，也不影响后面的监听器看到同一个已接受事件。
- **Scope-filtered**：agent-scoped 的监听器只收到"从该 agent 的上下文进入 store"的会话的事件——多 agent 部署里各收各的。
- **构造 seed 不广播**：resume/fork/replay 经构造器进来的历史事件（seq < `firstLiveSeq`）**从不**在 `session/event` 上发布；seed 会话会写一条 `session/end-seed` 标记"种子到此为止"。想"以广播代替重放"的消费者（比如 telemetry 的 adoption）从 `firstLiveSeq` 开始补读。

广播流向长这样：

```text
session.append(type, data)
      │ ① 校验 data（lossless JSON）与 surface 元数据
      ▼
   log.push(event)                  ← 提交点：进入日志即不可变
      │ ② 提交后广播（fire-and-forget，逐监听器隔离失败）
      ▼
   'session/event'(session, event)
      │
      ├──► 持久化插件：缓冲事件，session/flush 时写盘（M12）
      ├──► telemetry 捕获：ledger 记录镜像日志事件
      ├──► 投影 registry：fold 每个事件，刷新整值
      └──► Web 前端：把事件渲染成 chat 节点
```

最后一个预告：**持久化插件就是订阅 `session/event` 的监听器之一**。它把事件缓冲起来，在 `session/flush`（`@mode parallel`，调用方 await 所有监听器）时真正落盘。M12 我们会看到 JSONL 后端怎么把连续 seq 的事件批写盘、崩溃后怎么修复孤儿 turn——到那时你回头看这一节的图，会发现持久化只是"日志的第四个消费者"。

---

## 六、本章小结

这一章的核心可以压成一句话：**日志是唯一的事实来源，其余一切都是它的投影**。`SessionEvent` 是带类型的 append-only 日志行——词表可扩展（声明合并）、键名拼错编译期就报错、payload 必须 lossless JSON；日志只追加不修改，因为重放就是"同一条日志再派生一遍"，任何改写都会破坏重放保真与审计；模型上下文不是存出来的，是 `deriveMessages()` 投影出来的，原始 chunk 留下是为了 UI 与 token 级重放；"模型可见即日志"不是口号，`invariant.ts` 里 seq 递增、turn/step 嵌套、tool 配对这些断言在运行时把它钉死；最后，日志通过 `session/event` 广播走向世界——post-commit、fire-and-forget，持久化插件就是订阅者之一。写代码时的推论很简单：想让模型看到什么新东西，就去扩展 `SessionEventMap`，然后从日志渲染。

下一章（M06）我们进入模型调用：**llm 服务与流式适配**。你会看到 `assistant/chunk` 是怎么从 provider 的流变成日志行的——`llm/stream`、`StreamChunk` 的形状、adapter 怎么把流翻译成类型化事件。到那时，第 5 章里"日志里的每一行"就凑齐了最后一块拼图：它们究竟是从哪条流里生出来的。
