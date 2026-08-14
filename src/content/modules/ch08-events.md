---
order: 8
title: "第8章：事件驱动 —— 三个事件域"
summary: "session 持久事件、agent 实时事件、capability 策略事件；waterfall 必须调用 next()。"
status: published
words: 4312
codeLines: 119
minutes: 22
updated: "2026-08-14"
---

# 第8章：事件驱动 —— 三个事件域

第 2 章我们认识了类型化事件和五种派发模式，第 5 章盯着 append-only 的会话日志看了一整章，第 7 章又拆开了工具的守卫式执行管线。但你可能已经注意到一个事实：日志、工具管线、agent 循环——它们之间全靠事件在通信。dsh 的事件系统像神经系统：插件不互相喊名字，而是往 ctx 上发布事件，谁关心谁订阅，谁也不需要知道谁在听。问题是，dsh 里的"事件"不是一种东西，而是三个域。`docs/architecture.md` 的原话是：**事件是扩展点，而选对事件域是大多数改动的第一个决策**。这一章就把这句话拆透：三个事件域各管什么、事件地图怎么查、类型化契约怎么保证、waterfall 的 next() 纪律怎么守，最后落到一个根本区别——哪些事件活在日志里，哪些只活在进程里。

---

## 一、三个事件域，一次讲清

一句话定义先立住：**事件域，是事件按"服务对象与存活方式"划分的三类扩展点——session 域记录持久事实，agent 域观察进行中的工作，capability 域给能力挂策略。**

### 1.1 Session 事件：追加进日志的持久事实

第一域是 session 事件。一句话定义：**session 事件是追加进会话日志的持久事实，通过 `session/event` 广播；需要跨重载存活的事实就选它。** 你在第 5 章见过的 `turn/start`、`step/start`、`user/message`、`assistant/chunk`、`tool/result` 全在这里。它们的载体不是 Cordis 的 `Events` 接口，而是一张可合并扩展的映射表 `SessionEventMap`（第 3 节细讲）。每一条 append 都有单调递增的 `seq` 和 `time`，构成一条 lossless JSON 的事件流；持久化插件订阅 `session/event`，把这条流原样写进磁盘。architecture.md 给它的判断标准只有一句：**当这个事实必须挺过一次重载，它就是 session 事件。**

### 1.2 Agent 事件：携带活的 Agent

第二域是 `agent/*` 事件。一句话定义：**agent 事件携带一个活的 `Agent`，用来观察或拦截正在进行的工作。** 它们声明在 `packages/core/agent/src/runtime-types.ts` 的 `declare module` 里，全部以 `agent/` 为前缀，payload 第一项几乎总是 `agent`——那个此刻正在跑的对象。architecture.md 概括了它们的覆盖范围：inbox、step、status、request、validation、continuation；事件地图里的 `agent/inbox/inserted`、`agent/pre-step`、`agent/status`、`agent/request`、`agent/error`、`agent/turn-stopping` 都是这个域成员。注意签名里的 `this: Scoped<Agent>`：agent 事件是作用域过滤派发的，挂在某个 agent 的 context 下的监听器只收到那个 agent 的事件——"活的 Agent"在类型系统里的投影就是作用域。

### 1.3 Capability 事件：策略与适配器

第三域是 capability 事件。一句话定义：**capability 事件把策略和适配器挂到某个能力缝上，不用 import 循环就能介入能力的执行。** 前缀暴露了它们服务的对象：`fs/*`、`tools/*`、`telemetry/*`。看一个真实声明，注意 `next()` 的默认行为如何体现"策略"——`fs/write-intent` 的 `next()` 得到的是裸 provider 的无条件写入，第一个返回意图的监听器拥有决策：

*来源：`packages/fs/fs/src/index.ts`（第 49–58 行），逐字摘录。*

```ts
    /**
     * Single-slot decision for the next {@link FileSystem.writeText}. Calling
     * `next()` yields the bare provider's unconditional write; the first listener
     * that returns an intent owns the decision rather than composing with peers.
     * @param target - the resolved target about to be written.
     * @param actor - the opaque tool-execution context the decider keys off.
     * @mode waterfall
     */
    'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
```

capability 事件的共同点是**不碰 agent 循环**：要管"文件能不能写"，听 `fs/write-intent`；要管"工具调用允不允许"，听 `tools/pre-execute`；要给会话记遥测，听 `session-telemetry/record`。策略插件注册监听器，挂在能力实现旁边，能力实现一行都不用改。

### 1.4 对比与选域决策树

三个域放一张表里对照：

| 域 | 声明处 | 存活方式 | 典型用途 | 例子 |
| --- | --- | --- | --- | --- |
| Session 事件 | `SessionEventMap`（core/session） | 持久：append 进日志，可重放 | 必须跨重启的事实、模型可见输入 | `turn/start`、`assistant/message`、`tool/result` |
| Agent 事件 | cordis `Events`（core/agent） | 实时：只在进程内，携带活的 `Agent` | 观察 / 拦截进行中的工作 | `agent/pre-step`、`agent/request`、`agent/turn-stopping` |
| Capability 事件 | 各能力包的 `Events` | 实时 | 给能力缝挂策略与适配器 | `fs/write-intent`、`tools/post-execute`、`session-telemetry/record` |

动手改代码前的决策树（依据 architecture.md 的 Events 一节整理）：

*决策树（笔者绘制，依据 architecture.md 的 Events 一节）。*

```text
你的改动要表达什么？
│
├─ 这个事实必须跨重启存活，或模型会直接看到它？
│     └─ 是 → Session 事件：扩展 SessionEventMap，走 session/event 广播
│
├─ 你要观察或拦截正在进行的 agent 工作？
│     └─ 是 → Agent 事件：agent/*，payload 携带活的 Agent
│
└─ 你要给某个能力挂策略或适配器？
      └─ 是 → Capability 事件：fs/*、tools/*、telemetry/*，挂在能力缝上
```

---

## 二、事件地图：producer 与 consumer

三个域有了，可 dsh 里事件上百，谁派发、谁监听，靠记性记不住。仓库给了一张现成的图：`docs/event-producer-consumer.md`，标题是 Event Producer And Consumer Matrix。**读任何事件相关代码之前，先查这张表**——这是这一节想让你养成的习惯。

文件开头就声明了自己的性质：这张矩阵列出"每个 harness 拥有的事件由哪些包派发、哪些包监听"。事件是多对多的，所以它用表格而不是一张大图；表格还覆盖了刻意绕过 `ctx.emit` 的受包含派发点（比如 subagent 生命周期收纳）。节选几行真实条目——注意 Mode 列和 Dispatchers 列的派发方法互相印证：

*来源：`docs/event-producer-consumer.md`（第 8–9 行表头，第 19、23、39、43、58 行节选），逐字摘录。*

```text
| Event | Mode | Declared in | Dispatchers | Listeners |
| --- | --- | --- | --- | --- |
| `agent/request` | `waterfall` | [`packages/core/agent/src/runtime-types.ts:244`](../packages/core/agent/src/runtime-types.ts) | [`agent-loop`](../packages/core/agent-loop) (`waterfall`) | [`agent`](../packages/core/agent) |
| `agent/turn-stopping` | `serial` | [`packages/core/agent/src/runtime-types.ts:278`](../packages/core/agent/src/runtime-types.ts) | [`agent-loop`](../packages/core/agent-loop) (`serial`) | [`hooks-claude-code`](../packages/hooks/hooks-claude-code), [`hooks-codex`](../packages/hooks/hooks-codex) |
| `llm/stream` | `waterfall` | [`packages/llm/llm/src/index.ts:64`](../packages/llm/llm/src/index.ts) | [`llm`](../packages/llm/llm) (`waterfall`) | [`agent-loop`](../packages/core/agent-loop), [`llm`](../packages/llm/llm), [`llm-replay`](../packages/test-support/llm-replay), [`session-checkpoint-policy`](../packages/session/session-checkpoint-policy), [`session-title`](../packages/session/session-title) |
| `session/event` | `emit` | [`packages/core/session/src/index.ts:76`](../packages/core/session/src/index.ts) | [`session`](../packages/core/session) (`events.dispatch`) | [`session-persistence`](../packages/session/session-persistence), [`session-telemetry`](../packages/session/session-telemetry), [`session-title`](../packages/session/session-title), ……（中略：其余监听者） |
| `tools/pre-execute` | `waterfall` | [`packages/core/tools/src/index.ts:152`](../packages/core/tools/src/index.ts) | [`tools`](../packages/core/tools) (`waterfall`) | [`hooks-claude-code`](../packages/hooks/hooks-claude-code), [`hooks-codex`](../packages/hooks/hooks-codex), [`tool-jobs`](../packages/jobs/tool-jobs) |
```

读法三条。第一，**按事件名查**：想知道 `agent/request` 是谁声明、谁派发、谁监听，一搜就有——声明文件与行号在 Declared in 列，Dispatchers 列告诉你"哪个包、用什么方法派发"，Listeners 列告诉你"哪些包注册了监听器"。第二，**按包查**：接手一个新包，先看它在 Listeners 列出现几次、都听了什么事件，比翻源码快得多。第三，**别把表当手写文档**：它由 `scripts/gen-doc-graphs.ts` 从仓库的 TypeScript Program 解析生成，文件头明说不要手改、跑 `pnpm run gen-doc-graphs` 重新生成。

一个容易看漏的点：**日志条目（`turn/start`、`step/start` 这些）并不在表里**。这张表只收 Cordis 声明合并出来的事件；session 日志条目走的是 `Session.append()`，它们的"广播"是 `session/event` 那一行——session 服务把每一条 append 以 `session/event` 派发出去，持久化、遥测、投影、标题生成都是它的监听者。所以当你想知道"某个 session 事件被谁消费"，去 `session/event` 的 Listeners 列找，而不是找 `turn/start` 的行。文件末尾还有一节 Non-harness or undeclared event strings，收编 `internal/dispatch` 这类未声明或非 harness 拥有的事件字符串——它们没有 Mode 列，因为根本没进声明合并。

---

## 三、类型化：声明合并与 @mode

三个域、一张地图，都建立在"类型化"之上。第 2 章说过：事件名和监听器签名在编译期就确定，漏听、听错都是编译错误。这一节把两个机制讲深：`SessionEventMap` 的合并可扩展，和 JSDoc `@mode` 标签作为契约的一部分。

### 3.1 SessionEventMap：可合并扩展的映射

session 事件的类型中枢是 `SessionEventMap`，JSDoc 第一句就是它的全部性格：**"The merge-extensible, append-only source of truth for an agent interaction."**——合并可扩展、append-only、单一事实源。它不是写死的联合类型，而是一张映射表：键是事件名，值是 payload 类型；插件可以合并进新键，新事件立刻获得全类型安全：

*来源：`packages/core/session/src/types.ts`（第 230–266 行，成员中略），逐字摘录。*

```ts
/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. Every event is lossless JSON and
 * sequence numbers stay contiguous, including raw chunks, so persistence can
 * store the canonical log verbatim.
 */
export interface SessionEventMap {
  /**
   * Opens turn `turn` before the loop claims queued input or runs pre-step.
   * ……（中略：拒绝、空输入、取消等收尾说明）
   */
  'turn/start': { turn: number }
  /** Closes turn `turn` with the {@link TurnEndReason} that ended it. ……（中略） */
  'turn/end': { turn: number; reason: TurnEndReason }
  /** Opens step `step` of turn `turn` — one model call plus the tool executions it requested. */
  'step/start': { turn: number; step: number }
  /** Raw stream chunk — token-level replay fidelity. */
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  /** ……（中略：user/message、assistant/message、tool/call、tool/result、todo/write、request/* 等成员） */
}
```

映射表下面跟着两个派生类型：`SessionEventType = keyof SessionEventMap`（"appendable event-type keys，插件合并的扩展也包含在内"），以及把键展开成判别联合的 `SessionEvent`——每条事件带 `seq`、`time`、`data`，`switch (event.type)` 直接收窄 payload。第 5 章的"模型可见即日志"在类型层面就是这个形状：**模型可见输入必须扩展这张表，并从日志渲染**。

### 3.2 @mode：可核对的契约

Cordis 事件这边，类型化的第二块拼图是 JSDoc 的 `@mode` 标签。primer 说得很直白：**派发模式是事件公开契约的一部分；新事件用 `@mode` 标注，生成目录拿它核对声明与派发点是否一致。** 所以 `@mode waterfall` 不是注释装饰，而是可被机器核对的事实——`docs/subsystems/core.md` 里每条事件标题直接渲染成 "`agent/pre-step` — waterfall"，派发点代码也受同一事实约束。看 `agent/request` 的完整声明，waterfall 的形状一目了然：

*来源：`packages/core/agent/src/runtime-types.ts`（第 232–244 行），逐字摘录。*

```ts
    /**
     * Replace the frozen call configuration. `await next()` yields the config
     * the machine would use (agent options on the first request, the logged
     * header afterwards); return a replacement to switch. Model-visible
     * content must use logged channels; this waterfall cannot mutate messages.
     * @param payload.agent - the agent making the model call.
     * @param payload.turn - the open turn number.
     * @param payload.step - the step whose request this is.
     * @param payload.signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/request'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; signal: AbortSignal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
```

对照 `agent/turn-stopping`——签名里**没有 `next` 参数**，标注 `@mode serial`：

*来源：`packages/core/agent/src/runtime-types.ts`（第 261–278 行，中略），逐字摘录。*

```ts
    /**
     * The turn is about to close: the model owes no response (no live tool
     * calls, no fresh steering). Awaited before the boundary commits — a
     * listener that objects steers (`agent.steer(...)`) and the machine
     * re-reads its inbox: fresh steering runs another step, none closes the
     * turn. Data decides, so listener order cannot change the outcome.
     * ……（中略：concludesTurn 与同 step 续作的说明）
     * @param payload.agent - the agent whose turn is at its stop boundary.
     * @param payload.turn - the turn about to close.
     * @param payload.signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode serial
     */
    'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void
```

顺带认一个标签：`@dshScopeScan unsupported`。作用域过滤派发要求"作用域键在 payload 里"，而 session 事件（`session/created`、`session/event`……）的 payload 里没有作用域键，所以它们用这个标签告诉生成目录"别扫，这里不支持"。

---

## 四、waterfall 与 next() 纪律

第 2 章讲过 waterfall 的基本语义，这里复习并深化。一句话定义：**waterfall 是环绕式中间件——监听器收到 `(...args, next)`，调用 `next()` 把（可能被包装过的）结果交给下一个监听器；不调用 `next()` 直接 return 就是短路。** 值通过 `next()` 的返回值传播，所以监听器要么改完 `return next()`，要么自己拍板直接 return。primer 给了判断标准：**对单决策事件，短路就是设计**——策略监听器可以在它拥有决策时直接 return，而只注解或观察的监听器必须委托。仓库纪律由此而生：**waterfall 监听器必须调用 `next()` 来委托；不调用就是故意的短路。**

忘掉 `next()` 的后果因事件而异：

- `agent/request` 上，一个只想观察配置的监听器若没 `await next()` 就返回，它就成了"拍板的人"——而它什么都没决定，机器拿到的配置没有经过下游任何加工。
- `llm/stream` 上更直观：适配器的流要经过 `next()` 才能到达。一个想记录 chunk 的监听器若忘了转发（`yield* next()`），它返回的迭代器就是模型拿到的全部——**回答凭空消失**。反过来这正是 retry / replay 插件的入口：JSDoc 明说 "yield your own chunks to short-circuit"，自己产流就是短路。

看 `llm/stream` 的声明，`next` 的返回类型直接暴露委托语义——它是 `AsyncIterable<StreamChunk>`，委托意味着"交出流"：

*来源：`packages/llm/llm/src/index.ts`（第 51–64 行，中略），逐字摘录。*

```ts
    /**
     * Waterfall around every streaming model call (retry, replay, routing).
     * Bound to the {@link LlmRuntime}; call `next()` to reach the resolved
     * adapter's stream, or yield your own chunks to short-circuit.
     * ……（中略：@param options 说明）
     * @mode waterfall
     */
    'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```

哪些事件是 waterfall？architecture.md 一句话列全：**`agent/pre-step`、`agent/request`、`llm/stream` 和三个 `tools/*` 事件都是 waterfall，监听器必须调用 `next()` 来委托；`agent/turn-stopping` 是 serial，没有 `next()`。** 工具管线的三个 waterfall 各管一段：`tools/pre-execute` 在派发前决定 allow / deny / ask（`next()` 委托给 allow）；`tools/execute` 包住派发本体做超时、重试、指标（`next()` 返回归一化结果，包装器只能换 `exec.signal`）；`tools/post-execute` 在派发后接受、替换、富化或拦截结果。看 `tools/post-execute`——和 M07 见过的 `tools/pre-execute` 同形，只是 `next()` 的默认行为从"允许"变成"原样接受"：

*来源：`packages/core/tools/src/index.ts`（第 164–175 行），逐字摘录。*

```ts
    /**
     * Accept, replace, enrich, or block a normalized dispatch result. `next()`
     * accepts it unchanged; thrown tools still reach this waterfall as errors. Async
     * listeners must observe `exec.signal`; after they settle, caller
     * cancellation replaces only a successful accepted outcome with the code
     * selected by whether the tool body was invoked.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
     * @param exec - the call that just ran (name, parsed arguments, caller agent).
     * @param result - the dispatch outcome a listener may accept, replace, or block.
     * @mode waterfall
     */
    'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
```

serial 没有 `next()` 可调，语义完全不同。`agent/turn-stopping` 在 turn 即将关闭前被 await 执行：监听器不能短路别人，只能表达自己——反对关闭的监听器调用 `agent.steer(...)`，机器重读 inbox，有新鲜 steering 就再跑一个 step，没有才关 turn。JSDoc 那句"数据决定，监听器顺序改变不了结果"点破了 serial 与 waterfall 的哲学差异：waterfall 里先注册的先包、次序即语义，serial 里次序只决定执行先后。事件地图里它的监听者恰好是 `hooks-claude-code`、`hooks-codex` 这类"关门前做最后汇报"的角色，两处对得上。

---

## 五、持久 vs 实时：两个时间尺度

把三个域放到时间轴上，是本章最值得停下来想的一节。一句话定义：**session 事件活在日志的时间尺度里（可以重放），agent 与 capability 事件活在进程的时间尺度里（进程死了就没了）。**

为什么 session 事件要 durable？因为它是"模型可见即日志"这条铁律的载体：消息历史从日志派生，任何到达模型的东西必须能从日志重建。日志本身是 append-only 的 lossless JSON 流，`seq` 单调连续，持久化后端可以逐字存储；持久化是一个插件关注点——`packages/core/session/src/index.ts` 的模块注释写得很清楚：**订阅 `session/event` 写入，在 `session/flush` 排空**。`session/event` 是提交后 fire-and-forget 的追加广播，监听者失败被记录但不影响提交；`session/flush` 则是四个派发模式里唯一的 `parallel`——所有监听者并发跑完、调用方全部 await，没有 waterfall 否决权，它是"把缓冲事件落到可靠存储"的检查点：

*来源：`packages/core/session/src/index.ts`（第 65–76 行），逐字摘录。*

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

为什么 agent 事件只 live？因为它携带的是一个**活的 `Agent` 对象**——inbox、驱动、取消信号全在里面。进程重启后这个对象不存在了，`agent/*` 自然不再派发；恢复靠重放日志（`agent/session-start` 的 `SessionStartSource` 里 `resume` 就是这个意思）。agent 事件存在的意义是"干预正在飞行的过程"，不是"记录发生了什么"——记录是 session 域的事。`docs/subsystems/core.md` 有一句精确的划分：**turn 与 step 的边界是持久 session 事件，不是 agent emit。**

把一次 step 放到两个时间尺度上看：

*示意图（笔者绘制，参照 architecture.md 的 turn flow）：上排实时事件干预"正在发生"，下排持久事件记录"已经发生"。*

```text
        进程内（实时）：agent/*、tools/*、fs/* —— 只活在这一刻
   ┌───────────────────────────────────────────────────────────┐
   │  agent/pre-step → agent/request → llm/stream               │
   │  → tools/pre-execute → tools/execute → tools/post-execute  │
   │  → agent/turn-stopping（turn 关闭前）                        │
   └────────────────────────────┬──────────────────────────────┘
                                │ 边界与结果逐条 append（Session.append）
                                ▼
        日志（持久）：session 事件 —— 跨重启存活，可重放、可派生
   ┌───────────────────────────────────────────────────────────┐
   │  turn/start → step/start → user/message → assistant/chunk* │
   │  → assistant/message → tool/call → tool/result → step/end  │
   │  → turn/end                                                │
   └───────────────────────────────────────────────────────────┘
```

两个尺度决定了排查方向：**"重启后行为变了"先问它在哪个尺度**——日志里找得到？是下排的事，重放路径的问题；日志里没有、但当时确实发生过？是上排的事，重启后本来就该消失，要么重演要么加一条 session 事件把它持久化。第 5 章那条"模型可见即日志"在这里有了完整的闭环：凡是模型会再看到的东西，都必须沉到下排去。

---

## 六、本章小结

一张卡片收束全章：**事件是 dsh 的扩展点，选对事件域是大多数改动的第一个决策。** session 事件把必须跨重启的事实 append 进日志，经 `session/event` 广播；agent 事件携带活的 `Agent`，观察与拦截进行中的工作；capability 事件把策略和适配器挂到 `fs/*`、`tools/*`、`telemetry/*` 上，不碰循环。改动前先查 `docs/event-producer-consumer.md`：谁声明、谁派发、谁监听，一表看清。类型化由两层保证：`SessionEventMap` 合并可扩展，`@mode` 标签让派发模式成为可核对的契约。waterfall 纪律只有一句：调用 `next()` 才叫委托，不调用就是故意的短路——日志监听器忘掉 `next()` 会让下游静默失效。最后记住两个时间尺度：日志里的持久事件可以重放，进程内的实时事件死了就没了。

下一章，我们顺着 capability 事件往下走。这些事件"把策略和适配器挂到能力缝上"——可"缝"本身是什么？**能力接缝（capability seam）是一个可替换能力，由三个角色组成：声明接口的 Service Definition、实现它的 Service Provider、使用它的 Consumer（通常是一个面向模型的工具）。一个角色不是缝；加能力意味着三个一起设计。** 事件把策略挂到缝上，接缝本身长什么样、三个角色怎么切分、一次 provider 换装为什么能带动整个产品——第 9 章见。
