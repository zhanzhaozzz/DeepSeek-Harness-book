---
order: 4
title: "第4章：Agent Loop —— step 与 turn 的转动引擎"
summary: "一次模型请求加它调用的工具是一个 step，一轮对话是一个 turn。本章拆解驱动引擎。"
status: published
words: 5482
codeLines: 148
minutes: 27
updated: "2026-08-14"
---

# 第4章：Agent Loop —— step 与 turn 的转动引擎

前两章我们认识了零件（Cordis 插件框架）和装配（profile、bundle、patch），现在该看发动机了。想象一台引擎：它不关心你说了什么，只关心"下一步该做什么"——收到一条消息，该不该开一轮新对话？开了之后，该不该向模型发一次请求？模型说要调用工具，工具跑完了还要不要再来一次请求？什么情况下可以熄火收工、把这一轮归档？这台引擎就是 agent-loop，dsh 的默认驱动器。它读你的输入、决定模型看到什么、向模型要输出、把工具结果喂回去，直到"无事相欠"。它的计量单位是 step 与 turn；它的全部行为浓缩在 architecture.md 的一张小图里；它的真实实现主要落在两个文件——`packages/core/agent-loop/src/agent.ts` 与 `tool-calls.ts`。本章从这两个单位开始，把那张图逐行拆完。

---

## 一、两个基本单位：step 与 turn

### 1.1 step：一次模型请求，加上它调用的工具

**一句话定义：step 是一次模型请求加上它调用的那些工具。**

architecture.md 的原话（照抄）：

> A **step** is one model request plus the tools it calls.

拆开看：一次"请求—响应"周期，加上这一轮响应里模型点名要调的工具。注意工具是被包含在 step 里的——step 的边界不是"模型说了句话"，而是"模型说完了、它要的工具也跑完了"。这正是后面你会看到的：只要工具还欠一个请求，这个 step 就不能结束。

### 1.2 turn：从"第一个输入被认领"到"无事相欠"

**一句话定义：turn 是零个或多个 step——它在第一个输入被认领之前打开，在"无事相欠"时关闭。**

原文：

> A **turn** is zero or more steps: it opens before its first input is claimed and closes once nothing is owed.

两个要点。第一，"零个 step"：turn 可以在一个 step 都没跑的情况下关闭——比如首个提议被 `agent/pre-step` 拒绝，第 4 节会细讲。第二，"无事相欠"（nothing is owed）：没有未决的工具调用、没有新的 steering、没有排队等认领的下一步输入。另外注意"打开在第一个输入被认领之前"——`turn/start` 事件先于任何 claim 落日志，这个顺序是刻意的：认领发生在已经打开的 turn 里，所以被认领的批次天然属于这个 turn，日志里 turn 与它的 step 从第一行起就对得上。

### 1.3 两者关系

```text
turn：一轮对话的持久边界（turn/start 打开 → turn/end 关闭）
├─ step 1：一次模型请求 + 它调用的工具
│     └─ 工具还欠一个请求，或 next-step 输入已到 → 继续
├─ step 2：下一次模型请求 + 它的工具
└─ step N（N ≥ 0：被拒绝的首个提议 → 0 个 step）
      然后：agent/turn-stopping 终检 → turn/end
```

补充一句：turn 与 step 在日志里都是持久事件（`turn/start`/`turn/end`、`step/start`/`step/end`），但职责不同——turn 是"一轮对话"的归档单位，step 是"一次模型调用"的工作单位。一个 turn 可以只装一个 step，也可以装一串 step，比如模型连续调了三轮工具。

---

## 二、turn flow 全图

### 2.1 架构文档的原图

architecture.md 的 Turn flow 一节用一张文本图概括了整个引擎。它是理解这个仓库最核心的一张图，逐字摘录如下：

*来源：`docs/architecture.md` 第 68–81 行（Turn flow 一节），逐字摘录。*

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                   reject | enter(messages)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     append entered messages as user/message
     derive model history from the log
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

逐行读：

- **turn/start**：持久边界打开。此时还没有任何消息被认领——"打开在第一个输入被认领之前"。
- **claim next-step input plus one queued message**：从 inbox 取走"下个 step 的全部输入 + 一条排队消息"。这是 turn 打开后做的第一件事，第 3 节专门拆它。
- **assemble prompt sections + tool schemas**：`system-prompt/assemble` 把插件注册的 prompt 段和工具 schema 装配起来——每个 step 都重新读一遍插件当时注册的内容。
- **agent/pre-step**：决策点，返回 `reject | enter(messages)`。拒绝、或首次 enter 被改写成空 → 直接关 turn，一个 step 都不花。
- **step/start**：持久边界，一个 step 正式开工。
- **append entered messages as user/message**：进入的消息逐条追加为 `user/message` 日志事件——模型可见的内容先落日志。
- **derive model history from the log**：模型历史不是存的，是从日志 `deriveMessages()` 派生出来的——这是 M05 的主角，本章先记住它在请求前的这一步。
- **agent/request → llm/stream → assistant/chunk* → assistant/message**：请求经 waterfall 冻结配置 → 走 llm 流式适配 → 每个流块落 `assistant/chunk` → 组装成 `assistant/message`。
- **tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result***：工具回合，一次模型请求可以带出多条工具调用（第 6 节）。
- **step/end**：step 收尾。
- **tools owe another request, or next-step input arrived → claim → next step**：回边——工具还欠一个请求、或 next-step 输入到了，就再 claim、再开一个 step。这张图的"循环"就在这一行。
- **agent/turn-stopping**：串行终检，无人反对才关 turn。
- **turn/end**：持久边界关闭。

### 2.2 哪些是持久事件，哪些是实时扩展点

现在把这张图里的事件分成两类。**持久 session 事件**：`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*`——它们 append 进日志、经 `session/event` 广播，是重放与 UI 的事实来源。**实时扩展点**：其余全是——`agent/*` 携带活 Agent（inbox、step、status、request、validation、continuation），`llm/stream` 是模型适配缝，`tools/*` 是工具策略缝。architecture.md 的 Events 一节把事件分成三个域：session 事件（持久事实）、agent 事件（观察或拦截在飞工作）、capability 事件（把策略和适配器挂到接缝上）。

再看分发模式：`agent/pre-step`、`agent/request`、`llm/stream` 和三个 `tools/*` 事件是 **waterfall**——监听器必须调用 `next()` 委托给链上下一环，不调用就是短路（也就是改写了决策）；`agent/turn-stopping` 是 **serial**——按注册序逐个等待，没有 `next()`。持久事件落日志后还会经 `session/event` 广播给所有订阅者（post-commit、fire-and-forget，逐监听器隔离失败）——这是重放与 UI 的通道，广播的机制 M05 会细讲。这里先记一条贯穿全书的分工原则（agent-lifecycle.md 的原话）：**durable replay facts 放 `session/event`，live control/status 放 `agent/*`**。想要可重放的数据，消费 `session/event`；想要指挥在飞的工作，监听 `agent/*`。

---

## 三、输入通道：inbox 与注入

### 3.1 唯一 inbox：两条有序待处理列表

**一句话定义：inbox 是 agent 拥有的待认领工作投影——两条有序列表 `next-turn` 与 `next-step`，一切输入从这里进，claim 从这里出。**

architecture.md 的原话：

> Input reaches the driver through one inbox. Some messages wake it immediately; injected context waits in the inbox until another message does.

"唯一 inbox"是刻意的：没有"直接塞给模型"的旁路。而且 inbox 不是内存里的临时队列——它是一份**可重放投影**：每次增删改都先记一条持久的 `agent/inbox/spliced` 日志事件，再改内存列表（core.md 对 Inbox 的说明：append、prepend、replace、remove、clear、splice、claim 都记下标准化的持久变更）。所以哪怕进程重启，inbox 也能从日志重建。agent-lifecycle.md 的时序图上，用户 `followup(content)` 之后先是 `agent/inbox/spliced`、`agent/inbox/inserted`，然后才是"queued work wakes driver"——队列先落盘，再唤醒。

### 3.2 claim：下一个 step 的批次

认领是"批量取走"，不是逐条弹出。看 `Inbox.claim` 的实现：

*来源：`packages/core/agent/src/inbox.ts` 第 71–78 行，逐字摘录。*

```ts
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') {
      claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    }
    for (const message of claimed) this.notifications.claimed(message, turn)
    return claimed
  }
```

两行 mutate 就是全部规则：**`next-step` 全取**（从 0 删到列表末尾），**`next-turn` 只取一条**（`0, 1`）——而且只有 turn 边界（target 是 `next-turn`）才取。删除是"纯删除 splice"，不发 discarded 通知；被取走的每条消息单独发一次 `agent/inbox/claimed`，携带所属 turn。core.md 的原话：claim 移除的是"proposed step batch——全部 next-step 输入，外加 turn 边界上的一条 next-turn 消息"。

### 3.3 三个入口：followup / steer / inject

`Agent` 接口把"输入 + 目标 + 是否唤醒"统一成 `send(message, target, wakeup)`，`followup`、`steer`、`inject` 只是三种固定组合：

*来源：`packages/core/agent-loop/src/agent.ts` 第 113–132 行，逐字摘录。*

```ts
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }
```

逐个读：

- **followup**：普通后续消息 → `next-turn` + 唤醒。它成为"自己那一轮 turn 里的唯一一条普通消息"。
- **steer**：steering → `next-step` + 唤醒。idle 时开一轮新 turn，运行中则在下一个 step 边界被消费。
- **inject**：注入上下文 → `next-step` + **不唤醒**。这正是 3.1 那句"injected context waits in the inbox until another message does"——注入的上下文静默排队，等别的消息把 driver 叫醒后，在最近的 step 边界被认领。
- `send` 里还有个细节：唤醒输入不能加入已中止的活动，所以 `wakingAfterAbort` 时目标被改判为 `next-turn`——它总是开下一轮，而不是混进正在收尾的旧活动。

"唤醒"也别想得太重：`wakeDriver` 并不直接开跑，它只是把 phase 从 idle 推进 running（`agent/status` 同步发出），然后以 `ctx.agents.withInitiator(this, () => this.kick())` 起一条驱动链——initiating Agent 就挂在链条上，工具回合里 `requireInitiator()` 拿到的就是它。

---

## 四、agent/pre-step：模型看到什么由谁决定

### 4.1 一个 waterfall 决策点

**一句话定义：`agent/pre-step` 决定"这个即将进入模型的 step，消息是什么"——waterfall 监听器可以改写已认领的消息，也可以直接拒绝。**

payload 带四样东西：agent、已认领的独占批次 `messages`、提议 step 的坐标 `turn`/`step`、当前 turn 的取消信号 `signal`。返回类型 `PreStepDecision`：

*来源：`packages/core/agent/src/runtime-types.ts` 第 52–55 行，逐字摘录。*

```ts
/** Whether and with which messages the loop enters a proposed step. */
export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[] }
```

`reject` 不开 step；`enter` 提供进入 step 的完整消息批次——**被最终决策省略的已认领消息就留在删除状态**（不回 inbox），而认领之后新插入的输入仍然挂起。core.md 的说法：entered batch is authoritative——决策是权威的，不是建议。

### 4.2 驱动里的 preStep

真实驱动在 agent-loop。看 `preStep()` 怎么把 claim、装配、waterfall 串起来：

*来源：`packages/core/agent-loop/src/agent.ts` 第 225–243 行，逐字摘录。*

```ts
  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    const sections = renderContextSections(assembly)
    const context = this.runtimeContext.project(joinContextSections(sections), sections)
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: context === undefined ? claimed : [...claimed, context],
      }),
    )
    signal.throwIfAborted()
    return decision.kind === 'reject' ? decision : { ...decision, assembly }
  }
```

顺序值得抄进笔记本：**先 claim，再装配，再派发 waterfall**。默认决策（没人改写时）是 `enter`，消息 = 已认领批次 + 动态运行上下文快照（`RuntimeContextProjection` 只在内容真正变化时才生成快照消息，见 runtime-context.ts）。waterfall 的监听器可以改 `messages`、可以 `next()` 保留，也可以直接返回 `reject` 短路。agent-lifecycle.md 补了一句：监听器如果包着 `next()` 委托，就保留下游消息——除非替换是故意的。

### 4.3 "拒绝/改空"仍关闭一个没花 step 的持久 turn

这是最容易漏掉的语义。看 `turn()` 里对决策的处理：

*来源：`packages/core/agent-loop/src/agent.ts` 第 266–277 行，逐字摘录。*

```ts
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        // A removed waking message or an enter decision rewritten to empty
        // still owns the initial turn boundary, but it spends no model call.
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
```

`reject` → turn 以 `blocked` 收场；首次 enter 被改写成空 → turn 以 `completed` 收场。两种都是**关掉了一个持久 turn，但一个 step 都没花**——注意 `turn/end` 在 `finally` 里无论如何都会 append，所以日志记录的是这次"尝试"。这跟 agent-lifecycle.md 的 alt 分支完全对上："claimed batch stays removed, the open turn spends no step"。已认领的消息到此为止：既不会以 `user/message` 进入日志，也不会回到 inbox——它被这次失败的提议"消费"了。

---

## 五、请求与流：agent/request → llm/stream → assistant/chunk* → assistant/message

### 5.1 agent/request：替换冻结的调用配置

**一句话定义：`agent/request` 是一个 waterfall——`await next()` 给你机器本来要用的调用配置，返回一个替代品就完成了换配置。**

core.md 的原话：

> Replace the frozen call configuration. `await next()` yields the config the machine would use (agent options on the first request, the logged header afterwards); return a replacement to switch. Model-visible content must use logged channels; this waterfall cannot mutate messages.

注意 "frozen"：waterfall 拿到的是冻结的种子配置，不是活对象；也注意最后一句——**这个 waterfall 不能改消息**，想改模型可见内容必须走日志渠道（这正是 M05"模型可见即日志"纪律的源头）。驱动里 `buildRequest()` 的中间一段：

*来源：`packages/core/agent-loop/src/agent.ts` 第 428–441 行，逐字摘录。*

```ts
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
```

种子来源二选一：首个请求用 agent options（provider、model、reasoningEffort、maxTokens），之后的请求从已记录的 `request/header` 事件折叠出"提案"（`requestProposal` 还会去掉 adapter 派生的值，好让插件重新提议）。waterfall 之后，配置经 `llm.prepareCall` 解析 adapter 默认值，并 append `request/header`、`request/context` 事件。整条链的意义：**换模型、换 provider、加中间件，都在这一处完成，不动循环本体**。

### 5.2 流式落地：chunk 如何变成日志行

请求发出后是流式响应。`step()` 里的核心循环：

*来源：`packages/core/agent-loop/src/agent.ts` 第 339–351 行，逐字摘录。*

```ts
    while (true) {
      const { request, preparedCall } = await this.buildRequest(
        turn, step, assembly.tools, system, this.session.deriveMessages(), signal,
      )
      const assembler = new BlockAssembler()
      const chunkSeqs: number[] = []
      const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
      signal.throwIfAborted()
      for await (const chunk of stream) {
        signal.throwIfAborted()
        chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
        assembler.push(chunk)
      }
```

第一行就把 M05 的原料摆出来了：`this.session.deriveMessages()`——**模型历史从日志派生**。然后每个流块做两件事：append 一条 `assistant/chunk`（记下 seq，供后面的 message 引用），同时推进 `BlockAssembler`。注意流是在 `signal.throwIfAborted()` 的包围里消费的——每个 chunk 落地前都会检查取消，所以用户在流式途中取消，循环会在下一个 chunk 处干净地停下来，而不是让 provider 流跑完再收拾。流结束后，若 finish 是 error 或 aborted，先走 `agent/request-error` waterfall——监听器可以返回 `{ kind: 'retry' }` 让本 step 重试，默认把失败留给 turn 收尾；否则 append 一条 `assistant/message`，用 `sourceEventSeqs: chunkSeqs` 精确列出它由哪些 chunk 拼成。agent-lifecycle.md 强调：**每次成功的 provider 调用都会记 `assistant/message`**，包括空内容和 max-tokens 截断的；空内容不会进派生历史，但持久事件保留 usage 与 chunk 引用清单。流式这一段的细节（`StreamChunk` 的形状、adapter 怎么把 provider 流翻译成类型化事件）是 M06 的主题，这里先看它在循环里的位置。

---

## 六、工具回合：tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*

### 6.1 调度入口

**一句话定义：工具回合把一条 assistant 消息里的 tool-call block 变成配对的 `tool/call` 与 `tool/result` 持久事件——串行调用形成屏障，并行调用走有界滚动池。**

入口是 `executeToolCalls`：

*来源：`packages/core/agent-loop/src/tool-calls.ts` 第 59–89 行，逐字摘录。*

```ts
export async function executeToolCalls(
  ctx: Context,
  turn: number,
  step: number,
  toolCalls: ToolCallBlock[],
  signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
): Promise<{ concluded: boolean }> {
  const agent = ctx.agents.requireInitiator()
  const { session } = agent

  // Inputs are distinct because tools/execute wrappers may replace `exec.signal`.
  const planned: PlannedCall[] = toolCalls.map(block => ({
    block,
    exec: {
      callId: block.id,
      name: block.name,
      arguments: parseArguments(block.arguments),
      agent,
      signal,
    },
  }))

  let next = 0
  let concluded = false
  while (next < planned.length) {
    // Commit before classifying again so registry changes affect unstarted calls.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    const first = planned[next]!
    const mode = ctx.tools.executionMode(first.exec).kind
    const group = mode === 'parallel' ? planned.slice(next) : [first]
```

第一个细节：`requireInitiator()`——工具回合的 initiating Agent 来自驱动边界。第二个细节：**每次循环都重新分类**（"reclassify before start"）——注册表在运行中变了，没开始调用的工具就按新模式走。`executionMode` 返回 `exclusive` 时，`group` 只有当前一条（屏障：等它和它的结果落定）；返回 `parallel` 时，`group` 是剩下的整批（有界滚动池，`ctx.agentLoop.config.maxParallelToolCalls` 控制并发上限，配置字段默认 `DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10`，见 constants.ts 第 6 行与 index.ts 第 251 行）。

### 6.2 三段瀑布与模型序提交

architecture.md 把这段定义为三个 waterfall 事件：`tools/pre-execute` → `tools/execute` → `tools/post-execute`。驱动代码里，它们由 `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 的 `prepare` → `dispatch` → `finalize`（或 `finish`）分阶段实现：prepare 决定 dispatch、post-result、final-result 三路；dispatch 并发执行；finalize/finish 产出最终 `ToolExecutionResult`。关键纪律是**模型序提交**：结果按模型产出调用的顺序落日志，而不是按完成顺序——`commitReady` 只推进连续的开头槽位，前面的没落定，后面的不能先写。为什么必须按模型序？因为 `tool/result` 是下一个请求的上下文素材，结果顺序乱了，模型看到的因果就乱了。每条启动的调用先 append `tool/call`（记下 seq），结果到达后 append `tool/result`，用 `sourceEventSeqs: [callSeq]` 指向那次调用。结果里的 `additionalContexts` 会被 accept 进 next-step inbox，成为下一个 step 的输入；`concludesTurn: true` 则记入 `concluded`。取消时的收尾也在这里：已启动的调用排空并提交，未启动的调用记一条合成的"aborted before dispatch"结果——重放保持有效，不伪造结果。

### 6.3 "工具还欠一个请求"如何驱动下一步

`step()` 在工具回合之后这样收尾：

*来源：`packages/core/agent-loop/src/agent.ts` 第 393–399 行，逐字摘录。*

```ts
      const toolCalls = message.content.filter(block => block.type === 'tool-call')
      if (toolCalls.length === 0) return { kind: 'completed' }
      const { concluded } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
      )
      return concluded ? { kind: 'completed' } : null
```

`return null` 就是"step 没结束，工具还欠一个请求"的信号。回到 `turn()`：step 结果不是终态 → 不满足关闭条件 → `target = 'next-step'` → 回到循环顶部再 claim、再 preStep、再开一个 step——**循环的动力就来自这个 null**。附带一提 max-tokens 的粘性：一旦某个 step 顶到 max-tokens，turn 结果就记成 `max-tokens`，后续正常完成的 step 也不能把它降级（agent.ts 第 285–290 行的注释原话："max-tokens is sticky"）。

---

## 七、turn 的结束与取消

### 7.1 agent/turn-stopping：串行终检

**一句话定义：`agent/turn-stopping` 是 turn 关闭前的最后一个串行检查点——没有 `next()`，监听器若反对就调用 `agent.steer()`，机器会重读 inbox 再跑一个 step。**

core.md 的原话：

> The turn is about to close: the model owes no response (no live tool calls, no fresh steering). Awaited before the boundary commits — a listener that objects steers (`agent.steer(...)`) and the machine re-reads its inbox: fresh steering runs another step, none closes the turn. Data decides, so listener order cannot change the outcome.

驱动里的触发点在 `turn()` 的循环底部（agent.ts 第 294–299 行，原样）：`if (turnEnds && this.inbox.nextStep.length === 0) { await this.dispatch.serial('agent/turn-stopping', { turn, signal }) }`，然后**再查一次 inbox**——steer 进去的消息会开一个真 step，没有才 break 关 turn。"数据决定，所以监听器顺序改变不了结果"。反向控制也是数据：工具结果带 `concludesTurn: true` 就在 step 处提前结束 turn——但已提交的 next-step 工作（same-step `additionalContexts` 或 racing steering）不会被短路，inbox 排空才真正关 turn。

### 7.2 取消与错误恢复

`Agent` handle 上的 `cancel(cause, options)` 是唯一的中断入口，core.md 的 JSDoc 说得很全：

> Clear queued and steering work — unless `keepInbox` — and abort the active turn or between-turn task. The first cause wins for that activity. With no active activity, cancellation is a no-op and does not arm later work.

拆开记三点：

- **默认清空队列与 steering**，然后 abort 活动；`keepInbox` 保留未开始的工作，只中止当前活动。中止后提交的唤醒输入排进下一轮，等被中止的活动收敛到 idle 再跑。
- 原因 `AgentCancelCause` 是 TypeScript 强制的同进程输入：`user | parent | { hook, reason } | disposed`。活动的中止方把它拷进 `AbortSignal.reason`，而**持久的 `turn/end` 只保留粗粒度 `{ kind: 'aborted' }`**——谁要求取消是运行时事实，不属于日志（core.md 的原话："recording who requested cancellation would require a separate durable event rather than overloading the terminal result"）。
- 错误与取消在驱动边界被包含：`kick()` 的 `while (await this.turn()) {}` 外套着 try/catch/finally（agent.ts 第 210–223 行），任何失败要么已经通过 `agent/error` 报告（emit：step 或 turn 出错，携带 turn、step、error），要么是取消——都在 `finally` 把 phase 归位 idle。`agent/request-error` 则是模型请求失败的恢复缝：在失败的 step 关闭后、turn 关闭前运行，`{ kind: 'retry' }` 让循环重试，默认 `undefined` 让失败保持终态。

最后记状态机：只有两态 `idle` ⇄ `running`（`agent/status` 每次翻转都发）。`running` 描述的是 driver 的整个排水区间，可能横跨连续多个排队 turn——**它不证明 turn 还开着**。turn 是否开着，要看日志里有没有配对的 `turn/start`/`turn/end`。handle 上还有 `whenIdle()`：它 resolve 于整个 agent 活动收敛到 quiescence，跟随的是"整台机器"，不承诺某条特定消息的结算——想知道某条消息的下文，得去日志里找。

---

## 八、本章小结

把这一章压成一张图：**turn 是持久边界，step 是工作单位，循环由"无事相欠"来判定**。输入经唯一 inbox 进入——`next-step` 全取、`next-turn` 取一条的 claim 规则决定每个 step 的批次；`agent/pre-step` 是模型看到什么的第一道闸，可以改写可以拒绝，但拒绝或改空仍会关闭一个没花 step 的持久 turn；请求经 `agent/request` 换配置、`llm/stream` 出流、chunk 落日志、message 归档；工具回合按 executionMode 分屏障与滚动池，结果按模型序提交，"还欠一个请求"的 null 驱动下一个 step；最后 `agent/turn-stopping` 串行终检，取消只留粗粒度的 aborted 痕迹。所有模型可见的东西都先落日志——这正是下一章的主角。

下一章（M05）进入会话日志：**append-only 事件流**。你会看到日志里每一行的类型、为什么只追加不修改，以及 `deriveMessages()` 怎么把日志投影成模型历史——"模型历史从日志 derive 出来"正是本章 `agent/request` 那一步的原料。到那时，本章图里"持久事件"那一半就有了完整的形状。
