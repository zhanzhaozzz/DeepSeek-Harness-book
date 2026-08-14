---
order: 10
title: "第10章：提示词与上下文工程 —— system-prompt 组装与注入"
summary: "prompt 分节与工具 schema 组装；agent.inject 让上下文落地到下一次请求。"
status: published
words: 4759
codeLines: 118
minutes: 24
updated: "2026-08-14"
---

# 第10章：提示词与上下文工程 —— system-prompt 组装与注入

如果让你给模型写 system prompt，你的第一反应大概是"精心打磨一段文字"：开头立人设，中间列规则，结尾叮嘱"请一步步思考"。dsh 不这么想。在 dsh 里，system prompt 不是一段文本，而是一棵分节树：每个插件挂一节，最后一并组装。系统身份是一节，部署的 persona 是一节，工具的引导语是一节，Web 表层又补一节——它们各自带着一个 order 排好队，组装时按顺序拼接成完整的 system prompt；而工具根本不写进这段文本，它以 schema 的形式与 prompt 一起进入模型请求。本章回答四个问题：这棵分节树长什么样、谁往里面放东西、什么时候组装、以及如何在分节树之外"注入"一段动态上下文（`agent.inject`）。最后用 token-meter 把"有限窗口怎么装"这个问题打开一个口子——那是第 12 章压缩的引子。

---

## 一、system-prompt 服务：分节组装

**一句话定义：`ctx.systemPrompt` 是一个注册表服务——插件往里注册"段"（section）、动态上下文（context）、工具 schema 提供者（tools）和提示词变量（variable），每次模型请求前把它们组装成一份 PromptAssembly。** 它占用的 `ctx` 键是 `systemPrompt`，架构文档的 Core packages 表里写得很清楚：`core/system-prompt` owns "Prompt-section and tool-schema assembly"。

核心类型 `PromptSection` 有四个字段：`name`（唯一名，重名注册直接抛错）、`order`（升序拼接顺序）、`text`（静态字符串，或按次求值的函数；可含 `{{variable}}` 引用，渲染时才插值）、`complete`（独占标记——命中它，组装后整份 prompt 只剩这一节；多于一个 effective complete 段会让组装失败）。order 的约定值得记住（JSDoc 原文）：`-100` 是 harness 身份段，`0` 是部署 persona，工具引导语用 100–199，其他负序段都渲染在 persona 之前。

真正的注册方法看 `packages/core/system-prompt/src/index.ts`。`section` 与 `tools` 的形态如下（省略各自 JSDoc）：

*来源：`packages/core/system-prompt/src/index.ts` 第 381–390 行（section 方法），逐字摘录。*

```ts
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.sections.insert(section.name, section),
      { label: 'systemPrompt.section()' },
    )
  }
```

*来源：`packages/core/system-prompt/src/index.ts` 第 430–436 行（tools 方法），逐字摘录。*

```ts
  tools(provider: (context: AssembleContext) => ToolProviderResult): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.toolProviders.append(provider),
      { label: 'systemPrompt.tools()' },
    )
  }
```

这就是 M02 讲的"注册即 effect"在 prompt 领域的直接落地：**两个方法都返回"the exact Cordis effect disposer"**——注册挂在调用插件的 fiber 上，插件卸载时这段 prompt 自动消失，不需要任何人手动"撤销提示词"。同文件里 `context()`、`variable()`、`suppressRuntimeContext()` 是同一家族的另三个注册口，无一例外都走 `this.layers.effect(...)`。它们的分工值得逐个记住：`context()` 注册动态上下文（`PromptContext`），组装时解析、按 order 排序，最终物化成一条持久的 user 角色快照（system-prompt.md 的原话："Dynamic model context materialized as a durable user-role snapshot"）；`variable()` 注册提示词变量，变量名必须匹配 `[a-z][a-z0-9_]*`，provider 可以返回 `undefined`，但任何引用它的 section 在渲染时都会失败；`suppressRuntimeContext()` 则在不改动"拥有这些事实的服务"的前提下，抑制调用 scope 内的全部动态 runtime context 贡献。此外还有两个配套机制：`renderPrompt(assembly)` 负责把组装结果变成最终文本——插值、丢弃空段、用空行拼接；`system-prompt/change` 事件在任何提供者变化时广播，而且**不按 scope 过滤**——因为全局变化影响每一个 scope。

背后的存储是一个 `ScopedLayers`：全局一层 + 每个 agent scope 一层；作用域段遮蔽同名全局段——这正是 agent preset 能"给某个会话换 prompt"的机制（见下一节）。`AssembleContext` 是这个服务的"每次组装上下文"，携带 scope 与本次请求的 AbortSignal，是合并可扩展的：dsh-agent 再往上面加一个可选的 live `agent` 字段。

---

## 二、谁往提示词里放东西

**一句话定义：凡是"想让模型知道"的插件，都在往这棵分节树上挂东西；挂的方式只有一种——在 `ctx.systemPrompt` 上注册。** 这一节看三个真实的贡献者：工具系统、部署 persona、agent preset。

第一个贡献者是 dsh-tools 的 `ToolRuntime`。M02 我们在它的构造器里见过 `ctx.systemPrompt` 的身影，现在看它到底注册了什么：

*来源：`packages/core/tools/src/index.ts` 第 826–837 行（ToolRuntime 构造器），逐字摘录。*

```ts
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tools')
    // The schema already defaulted an omitted mode; the ?? narrows the
    // optional-input type for direct (non-Loader) construction in tests.
    this.defaultMode = config.mode ?? 'native'
    this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls)
    ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
    if (this.defaultMode !== 'native') {
      ctx.systemPrompt.section(this.collapseSection())
      ctx.systemPrompt.section(this.sdkSection())
    }
  }
```

`ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))`——工具系统把自己的"可见工具集"作为 schema 提供者挂进组装：`wireSchemas(scope)` 返回 `{ schemas, knownNames }`（一个 `ToolProviderResult`），把当前作用域可见的每个工具定义投影成模型可见的 `ToolSchema`（name/description/parameters）；`knownNames` 是限制前的名字全集，用来区分"配置拼错了工具名"与"这个工具在本作用域被故意隐藏"。code 模式下它甚至只留 `run_code` 一个 schema。这就是 M07 讲过的"工具 schema 进入模型视野"的落点：**工具不是写进 prompt 文本，而是作为结构化 schema 与 prompt 一起组装**。模式不是 native 时还会多挂两节引导文本（code-only 折叠规则与 SDK 说明），它们的 order 落在 100–199 的工具引导区。

第二个贡献者是 persona——部署级的一段话。M03 我们见过 web-app 的 patch：`- id: system-prompt` 这一行按 id 覆盖 base 的 system-prompt 行，把 persona 从空串换成：

*来源：`packages/bundle/web-app/cordis.patch.yml` 第 16–19 行，逐字摘录。*

```yaml
- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
```

base 的 system-prompt 行（`packages/bundle/base/cordis.patch.yml` 第 429–432 行）只写 `persona: ''`，因为"部署 persona 是部署的选择"，值随模式变的行留给模式 bundle 复述——这正是 M03 的分层准则。这行配置在 `SystemPrompt` 构造器里变成一段注册：`this.section({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: config.persona })`，其中 `PERSONA_SECTION = 'deployment:persona'`、`PERSONA_ORDER = 0`——它就是模型读到的第一段。构造器还会在 `includeHarnessIdentity`（默认 true）时注册 `harness:identity`（order -100），文本是固定的"You are an AI agent powered by DeepSeek Harness."。`{{model}}`、`{{cwd}}` 是 prompt 变量：组装时由 `variable()` 注册的提供者求值，`renderPrompt` 渲染时才插值；引用未注册、畸形或值为 `undefined` 的变量都会抛错——插值是 strict 的，不是"能替换就替换，不能就留着"。变量还有一层作用域规则：assemble 时先取全局层的值，再沿 scope 链从远到近覆盖，最近的 scope 赢同名——所以同一段 persona 模板，在不同 agent 的作用域里可以渲染出不同的值。

第三个贡献者是 agent preset。M03 提过 web 是"每会话挂 agent preset，工具集由 preset 决定，而不是进程级统一"。preset 通过 `agentPresets.mount(agentCtx, id)` 组合一个 agent：先确保 preset 的 standing mount，再把 agent 的 scope key 挂到它下面，让 mount 的注册与监听器覆盖这个 agent——其中自然包括 prompt 段与工具注册；**scope 层注册遮蔽全局同名注册，所以 preset 能整组替换某个会话看到的 persona 与工具**。`PERSONA_SECTION` 的 JSDoc 明说了这个槽位的设计：composition 可以替换它——agent preset 用自己的 persona 遮蔽部署 persona，两边命名同一段，替换才成立而不是重复。此外 web-runtime 还会在 `surfaceContext` 开启时注册 `app:web-surface` 段（order -98）与 harness-source 段。预设之间还有一层"继承"：`composeFrom(agentCtx, parentCtx)` 让子代理绑定父代理正在运行的同一代组合，而不是重新解析一份预设——这正是 M11 子代理能力继承的机制，本章先知道有这个口子即可。

把三者放进一张图：

```text
                         ctx.systemPrompt（注册表：全局层 + 每 agent scope 层）
  插件（注册即 effect）        │
  ──────────────────          │
  dsh-system-prompt  ── section('harness:identity', -100)  系统身份（默认开）
  web-runtime        ── section('app:web-surface', -98)    Web 表层（surfaceContext 时）
  dsh-tools          ── tools(provider → ToolSchema[])     工具 schema 提供者
  base / web-app 配置 ── section('deployment:persona', 0)   persona，{{变量}} 渲染时插值
  agent preset       ── section(...) 挂进 scope 层          遮蔽同名全局段，可换 persona/工具
  ──────────────────          │
                              ▼ 每次模型请求前：assemble(context)
                    ┌─────────────────────────────┐
                    │ PromptAssembly              │
                    │  sections + contexts        │
                    │  tools（排序后）+ variables  │
                    └──────────────┬──────────────┘
                                   ▼ renderPrompt() → system prompt 文本 + ToolSchema[]
                              模型请求
```

*示意图（笔者绘制）。*

---

## 三、组装时机：assemble prompt sections + tool schemas

什么时候组装？架构文档的 Turn flow 节把这一步画在 step 的开头——"claim next-step input plus one queued message"之后、`agent/pre-step` 之前：

*来源：`docs/architecture.md`（Turn flow 节，第 67–82 行），逐字摘录（中略）。*

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step ...
  // ……（中略：模型请求、工具循环、step/end 与 turn/end）
```

M04 讲过 step 与 turn 的转动，这里的关键是：**组装不是"启动时做一次"，而是每个 step 都做一次**。architecture.md 的原话："Each step reads the prompt sections and tool schemas that plugins registered." 为什么每次都要重新组装？因为提供者是"按次求值"的——`text` 可以是函数，`tools` 提供者每次收到携带 scope 与 AbortSignal 的 `AssembleContext`，工具集可能随作用域变化，变量（比如 `{{cwd}}`）也可能变。组装是"实时快照"，不是"缓存模板"。

真实实现看 agent-loop 的 `preStep`——它先 claim inbox，再 assemble，然后才进 `agent/pre-step` 瀑布：

*来源：`packages/core/agent-loop/src/agent.ts` 第 225–243 行（preStep 方法），逐字摘录。*

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

拿到 `PromptAssembly` 之后，真正发请求的 `step` 里是两行：`const system = renderPrompt(assembly)`，然后 `buildRequest(turn, step, assembly.tools, system, ...)`（同文件第 337、341 行）——**渲染出的 system prompt 文本与排序后的 ToolSchema 一起进入模型请求**。assemble 内部还做了几件事：合并全局层与 scope 链的提供者（最近的 scope 赢）、`structuredClone` 每个工具的 parameters（防止提供者事后改动污染已组装的结果）、按配置的 `toolOrder` 排序（未列出的工具在保留标记 `<unlisted-tools>` 处按字典序插入，配置里没有该标记会在加载期直接报错）、最后跑一遍 `system-prompt/assemble` 瀑布，让专家监听器还能改写整个 assembly。注意 `agent/pre-step` 瀑布发生在 assemble 之后——所以"模型这一轮到底看到什么"的最终裁决权仍在 pre-step 监听器手里（M08 的三个事件域）。

preStep 里还有一行容易忽略的细节，它把 M05 拉回了现场。`this.inbox.claim(target, position.turn)` 的语义是：**在 turn 边界取走全部 next-step 输入，外加一条 next-turn 消息**（core.md 对 claim 的定义），这两类消息合成本轮 step 的批次。紧接着的三行——`renderContextSections(assembly)` 把动态上下文按 order 渲染成命名片段，`joinContextSections` 给它们加上 "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." 前缀，`runtimeContext.project(...)` 把快照做成一条 user 角色消息追加进本轮——这就是 system-prompt.md 说的"动态模型上下文物化成持久 user 角色快照"：**runtime context 不是塞进 system prompt 文本，而是作为一条会写进日志的 user 消息**。于是"模型可见即日志"在这里闭环：无论是 system prompt、工具 schema 还是动态上下文，模型看到的每一块都能从会话日志里重建。

再注意 `assembleContextFor(this, signal)` 这个名字本身：它把当前 agent 与本次 step 的取消信号一起装进 `AssembleContext`。组装结果因此天然携带"这是谁、这次请求能被谁取消"的信息——`tools` 提供者可以据此决定某个 agent 的作用域下暴露哪些 schema。system-prompt 文档还提醒一句纪律：这个 signal 只控制本次显式组装请求，绝不能留着去控制后面的轮次。

---

## 四、agent.inject：把上下文塞进下一次请求

组装是"每步重新算"，但有一种输入不在分节树里：**运行途中产生的、想塞给模型的上下文**——比如某个监听器想告诉模型"你的结果被剪枝了"，或者外部系统想给会话补充一段事实。这类输入的落点是 `agent.inject()`。架构文档的 Where new behavior goes 表给了它一行定位："Add model-facing context | call `agent.inject()`; it lands in the next admitted request"——加模型可见上下文，就调 `agent.inject()`，它落在下一次被接纳的请求里。

core.md 把语义写得很细：inject **不唤醒 driver**，只是把消息排进 inbox 的 next-step 列表；正在跑的 driver 会在最近的下一个 step 边界认领它；空闲的 driver 让它一直挂着，直到 follow-up 或 steering 把它唤醒；它可能错过一次请求——如果某个 step 的 pre-step 已经认领了批次，这次注入要等下一个边界；取消或 dispose 会丢弃挂起的注入。架构文档还有一句呼应 M04 的话："Input reaches the driver through one inbox. Some messages wake it immediately; injected context waits in the inbox until another message does."——**注入的上下文在 inbox 里等另一个消息唤醒**。

`Agent` 接口上的 inject 定义在 dsh-agent 的类型面：

*来源：`packages/core/agent/src/types.ts` 第 132–140 行（Agent 接口的 inject 方法），逐字摘录。*

```ts
  /**
   * Queue model-facing context for the next pre-step without waking the
   * driver. A running driver claims it at the nearest later step boundary;
   * idle drivers leave it pending until follow-up or steering
   * wakes them. It may miss a request whose pre-step already claimed its
   * batch. Cancellation or disposal may discard pending context.
   * @param message - identified injected context and the source that supplied it.
   */
  inject(message: UserMessage): void
```

接口在 dsh-agent，具体实现在 dsh-agent-loop——core.md 明说 `Agent` 的 concrete 实现是 agent-loop 包内部，循环之外没有任何东西依赖它，这正是 M02"面向接口编程"的实例。看实现你会发现 inject 只是个"别名"：所有投递都汇聚到一个 `send`：

*来源：`packages/core/agent-loop/src/agent.ts` 第 113–132 行（send / followup / steer / inject），逐字摘录。*

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

四个方法的差别就两个参数：`target`（'next-turn' 还是 'next-step'）与 `wakeup`（是否唤醒 driver）。followup = 普通下一轮 + 唤醒；steer = 最近一步 + 唤醒；inject = 最近一步 + **不唤醒**。把 steer 与 inject 放在一起对比最有教学价值：steer 带 `wakeup: true`，是"正在跑的司机请在这步边界改道"；inject 带 `wakeup: false`，是"悄悄把话放桌上，等下一个醒着的人带走"。前者改变轨迹，后者补充事实——语义上的区别完全由两个布尔参数编码，没有第二套投递代码。inbox 是两条有序待处理列表（`next-turn` / `next-step`）的增量投影（`Inbox` 类，inbox.ts），投影的原料是持久的 `agent/inbox/spliced` 事件——它是 dsh-agent 用声明合并加进 `SessionEventMap` 的成员（types.ts），**任何 pending 变化都先 `session.append(...)` 写进会话日志、再改内存投影**。所以注入本身是可重放的，符合"模型可见即日志"（M05）：注入的消息最终在 pre-step 被 claim，随后在 turn 循环里 `this.session.append('user/message', message, ...)` 作为 user 角色消息进入 step——**注入的上下文走的是与用户消息同一条登录与投影管道**，只是它不唤醒、不独占一个 turn。

---

## 五、有限窗口怎么装：token-meter

分节树和注入解决了"放什么"，没解决"装得下吗"。模型上下文窗口是有限的，而会话是 append-only 的——每一轮对话都在长大。谁负责把"装不下"这件事量化？`ctx.tokenMeter`。

**一句话定义：token-meter 从会话日志的持久尾部做一次"独立回放"，产出一份不可变的测量快照——请求压力（totalTokens）与按位置计价的 surface（surfaceTokens + nodes），并标出这次测量消费到的日志修订号（logRevision）。** 它不是服务端用量统计的搬运工：`baseline.kind === 'usage'` 表示最近一次成功的 provider 调用有可复用的保守用量锚点，否则就用固定启发式把完整信封与 surface 重新定价；`surfaceDeltaTokens` 带符号记录相对匹配锚点的增长与收缩。每个 `TokenSurfaceNode` 是"一个 surface 事件的序号 + 该节点投影消息的启发式 token 数"，surface 顺序是权威的——替换节点的序号可以比后面的位置节点更大。快照不可变，底层回放折叠继续前进它也不会跟着长；`measure(session, requestHeader?)` 每次调用都克隆位置节点，所以是 O(surface)。

*来源：`docs/subsystems/token-meter.md`（TokenMeasurement 类型，与 `packages/llm/token-meter/src/types.ts` 一致），逐字摘录。*

```ts
/** Detached immutable request-pressure and surface snapshot at one consumed log revision. */
interface TokenMeasurement {
  /** Number of durable events consumed; equal to the next unread event seq. */
  readonly logRevision: number
  /** Provider or heuristic anchor used for this measurement. */
  readonly baseline: TokenMeasurementBaseline
  /** Signed repricing of current surface content relative to the baseline anchor. */
  readonly surfaceDeltaTokens: number
  /** Non-negative current request-and-response pressure. */
  readonly totalTokens: number
  /** Total heuristic tokens across the current surface. */
  readonly surfaceTokens: number
  /** Current surface nodes in positional head-to-tail order. */
  readonly nodes: readonly TokenSurfaceNode[]
}
```

注意一个设计取向：测量是"从持久尾部回放"的——它消费的是会话日志，不是内存里某段缓存的字符串。这跟 M05 的"日志是单一事实来源"完全一致：计量的对象永远是日志，重放同一个日志就得到同一个数。`logRevision` 把测量钉在日志的某个确定位置：它等于这次测量消费掉的持久事件数，也就是下一个未读事件的 seq——两次测量比较，`logRevision` 大的一方看到了更新的历史。服务还暴露了 `estimateMessage(message)`，为单条模型可见消息按固定启发式定价（内容 + 角色框架 token），它是 `estimate.ts` 里纯函数导出的实例化包装。至于"装不下之后怎么办"——压缩（compaction）、保留策略、摘要如何回到日志里，那是 M12 的主角；token-meter 这把"尺子"届时会再登场。

---

## 六、本章小结

这一章我们把"模型看到什么"这条链路走完了。system prompt 不是一段文本，而是 `ctx.systemPrompt` 上的一棵分节树：系统身份、Web 表层、persona、工具引导语各占一节，插件注册即 effect、卸载即消失；工具不进文本，而是作为 schema 提供者与 prompt 一起组装。组装发生在每个 step：inbox claim 之后、`agent/pre-step` 之前，agent-loop 调 `assemble()` 拿到 PromptAssembly，再 `renderPrompt()` 拼出 system prompt 文本，连同排序后的 ToolSchema 一起进模型请求。分节树之外的动态上下文走 `agent.inject()`——它把消息排进 inbox 的 next-step 列表但不唤醒 driver，等另一个消息把它带进下一次请求；inject 只是 `send(message, 'next-step', false)` 的别名，接口在 dsh-agent、实现在 dsh-agent-loop。最后，窗口装不装得下由 token-meter 测量：一份从日志尾部回放出来的不可变快照，既是压力的读数，也是 M12 压缩那根尺子。

下一章（M11）我们讲**子代理与工作流：让 Agent 分身**。同一个 `Agent` 接口背后，子代理 provider 可以从"全新子 agent"跨度到"另一个产品里的委托回合"；工作流则把工作扇出给许多子代理、用阶段与结构化结果编排。你会发现，分身出来的每个子代理，都带着自己的分节树、自己的 inbox、自己的 token 账本——第 10 章的一切，在下一章以"每 agent 一份"的方式重演。
