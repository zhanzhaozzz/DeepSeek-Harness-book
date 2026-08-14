---
order: 6
title: "第6章：模型调用 —— llm 服务与流式适配"
summary: "消息与流的词汇表、适配器接缝：一行代码驾驭多个模型供应商。"
status: published
words: 4235
codeLines: 135
minutes: 21
updated: "2026-08-14"
---

# 第6章：模型调用 —— llm 服务与流式适配

对 agent 来说，模型是最熟悉的陌生人。从第 4 章的 turn flow 图你会记得，驱动引擎每走一步只做一件事：把一段配置和一个请求交给 `llm/stream`，然后拿回一长串 `assistant/chunk*`。引擎不关心你用的是哪家厂商、哪个模型，不关心请求在线上长什么样，甚至不关心回答是"一次性吐出来"还是"一个字一个字往外流"——它只依赖一个窄接口：`ctx.llm.stream()`。本章把这个窄接口拆开看。先立词汇表：`Message` 与 `StreamChunk` 长什么样；再看接缝：`ctx.llm` 服务如何把"声明"和"实现"分开，让换供应商只是配置的改动；然后用 DeepSeek provider 的真实代码演示一个适配器到底在做什么；接着把流式从 chunk 到日志的完整路径走一遍；最后回到 `agent/request`——模型调用被插件替换的正式入口。读完你就能回答：换一家模型供应商，到底要动哪些代码，又不用动哪些代码。

---

## 一、词汇表：Message 与流

### 1.1 内容块与消息

**一句话定义：会话就是消息的序列，一条消息是一个带类型的"内容块"数组。**

这一节的全部词汇声明在 `docs/subsystems/llm-streaming.md`，它对应 `packages/llm/llm/src/types.ts`。核心是 `ContentBlockMap`——一个可以合并扩展的 map：新增一种核心块类型（比如未来的音频）必须同时补上适配器、UI 与压缩（compaction）的支持，所以它刻意保持"merge-extensible"。当前有五种核心块：`text`（可见文本）、`reasoning`（思考内容，与可见文本严格区分）、`image`（持久化的图片附件）、`tool-call`（工具调用：`id` + 名字 + 原始 JSON 字符串参数）、`tool-result`（工具结果：可嵌套内容块，带 `isError?`）。块联合 `ContentBlock = ContentBlockMap[ContentBlockType]` 由这个 map 推导，新增一种核心块，所有代码都会随之编译。

一条 `Message` 是"一个带身份的、不可变的角色/来源/内容值"，交付、持久化历史、模型请求共用这一个表示：

*来源：`docs/subsystems/llm-streaming.md:54-64`（对应 `packages/llm/llm/src/types.ts` 原文）*

```ts
/** One immutable message representation shared by delivery, durable history, and model requests. */
interface Message {
  /** Stable identity preserved across every representation boundary. */
  readonly id: MessageId
  /** Provider-neutral conversation role. */
  readonly role: 'system' | 'user' | 'assistant'
  /** Exact model-facing blocks. */
  readonly content: ContentBlock[]
  /** Required source fields supplied by the producer. */
  readonly source: MessageSource
}
```

注意三个细节。第一，`id` 是"跨每个表示边界都保留"的稳定身份——日志里的消息、模型请求里的消息是同一件事。第二，`source` 回答"这条消息是谁产生的"：`kind` 区分 user / plugin / model / tool；`form` 回答"这是什么性质的信息"（instructions、catalog、snapshot、notice、relay、recall），两个轴独立，且词汇是语义的、绝不是视觉的。第三，模型产生的 assistant 消息携带 `AssistantProvenance`：产生它的 `provider` 路由、`model` id，以及可选的 `replayState`——适配器私有的、用于重放响应的无损 JSON 状态。这个字段是第 4 节讲"流式如何重放"的伏笔。

### 1.2 StreamChunk：原始流协议

**一句话定义：流式响应是一条 `StreamChunk` 序列——块开始、增量、块结束、用量、结束，每条都带块索引。**

*来源：`docs/subsystems/llm-streaming.md:169-181`（对应 `packages/llm/llm/src/types.ts` 原文）*

```ts
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | {
    type: 'finish'
    reason: FinishReason
    /** Adapter-private lossless-JSON state for replaying a successful response. */
    replayState?: unknown
  }
```

一个流式响应会交错出现多种块：文本、思考、多个工具调用。`index` 把每一条增量钉到它所属的块上；`block-end` 直接携带"组装完成"的 `ContentBlock`，消费方不必自己拼增量。`usage` 必须出现在 `finish` 之前、之后什么都不许再有（这是适配器契约，后面还会遇到）。`finish` 是终结符，带 `FinishReason`——同样可合并扩展：`stop` / `tool-calls` / `max-tokens` / `aborted` / `error`，后两种携带结构化的 `LlmFailure`。

它还是一个 **closed** 判别联合：对 `type` 做 `switch` 必须以 `assertNever` 收尾——新增一种变体，所有必须处理它的消费方都会编译报错。这是"加能力必须显式处理"的静态强制：流协议不会悄悄多出新形状。

### 1.3 失败与用量：两个配套类型

`LlmFailure` 是所有终态失败归一化后的可序列化载荷：`message`（人读的说明）、`code`（稳定的机器路由码）、可选的 `status`、`providerRetryAfterMs`（厂商要求等待的正延迟——是事实，不是重试决策）、`requestId`（不透明品牌字符串，供诊断）。**一句话定义：失败在流协议的终点被归一成一种类型，重试与否是策略的事，不是错误本身的事。**

`TokenUsage` 是单次调用的 token 账本，计数是**不相交**的：`inputTokens` 只算未命中缓存的输入，缓存命中单独报 `cacheReadTokens` / `cacheWriteTokens`，计费输入 = 三者之和；DeepSeek 的 `prompt_tokens` 把缓存命中折进了总数，适配器要减回去。`reasoningTokens` 是已包含在 `outputTokens` 里的信息性明细，总账不许再加一遍。

---

## 二、适配器接缝：ctx.llm 服务

### 2.1 三个角色，一个缝

第 2 章你见过 capability seam 的定义：一个能力缝是 **Service Definition / Service Provider / Consumer** 三件套，缺一不可。llm 能力缝正是如此：

- **Service Definition**：`packages/llm/llm`（`@deepseek-ai/dsh-llm`）——声明 `ctx.llm` 服务、消息/流词汇表、`LlmAdapter` 抽象契约；
- **Service Provider**：`llm-deepseek` 与 `llm-pi-ai` 两个适配器插件——各自实现 `LlmAdapter`，注册到各自的 provider 路由；
- **Consumer**：`agent-loop` 与任何直接调用 `ctx.llm.stream()` 的插件。

**一句话定义：定义方只写接口，实现方只写翻译，消费方只写调用——三方通过 `ctx.llm` 这一个入口见面。**

architecture.md 的核心包表里，`llm/llm` 这一行写得很直白：它"拥有消息与流词汇表，外加适配器接缝"，`ctx` 键就是 `ctx.llm`。接缝的服务端在 `packages/llm/llm/src/index.ts`。

### 2.2 服务注册：声明合并与 ctx.llm

`llm` 服务对 Cordis 的注册方式和你在第 2 章见过的所有服务一样：`LlmRuntime extends Service`，构造函数 `super(ctx, 'llm')`，默认导出。它对 `Context` 的贡献方式则很典型——**声明合并**，把 `llm` 键和 `llm/stream` 事件类型直接并入 Cordis 的 `Context` 与 `Events`：

*来源：`packages/llm/llm/src/index.ts:46-67`（原文摘录）*

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmRuntime
  }

  interface Events {
    /**
     * Waterfall around every streaming model call (retry, replay, routing).
     * Bound to the {@link LlmRuntime}; call `next()` to reach the resolved
     * adapter's stream, or yield your own chunks to short-circuit.
     * @param options - the full request. A LOOP-built request carries the
     *   process-local {@link markAgentLoopRequest} identity and arrives deep-frozen
     *   (mutation throws): its content is a pure function of the session log (the
     *   reconstructability Agent Note), so listeners read it, never rewrite it.
     *   Hand-built calls do not carry that marker; their messages already obey
     *   the immutable creation contract.
     * @mode waterfall
     */
    'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>

  }
}
```

声明合并意味着：任何插件写 `ctx.llm` 都有完整类型，任何插件监听 `llm/stream` 都被类型系统约束为这个签名——服务是"注入"的，不是某个插件"独有"的。而 `LlmRuntime` 本身是"一个适配器注册表加一个流式模型调用 API，可经 `llm/stream` 瀑布拦截"。注册的入口是 `registerAdapter(providers, adapter): AdapterRegistrationHandle`：把一组 provider 路由交给一个适配器实例，返回的 handle 既是 disposer，也带 `replace()` 做原子换路由。注册主体如下——注意 `ctx.effect` 的用法：

*来源：`packages/llm/llm/src/index.ts:344-354`（原文摘录）*

```ts
let released = false
const dispose = this.ctx.effect(function* (this: LlmRuntime) {
  if (providers.length === 0) throw new LlmError('an adapter must register at least one provider', 'INVALID_ADAPTER')
  this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned))
  yield () => {
    released = true
    for (const provider of owned) this.adapters.delete(provider)
    owned.clear()
    this.emitAdaptersUpdated()
  }
}.bind(this), 'llm.registerAdapter()')
```

这段代码把第 2 章的纪律都兑现了：注册走 `ctx.effect`，disposer 随 fiber 回收；路由冲突是 all-or-nothing 的 `DUPLICATE_ADAPTER` 失败；每次提交点发 `llm/adapters-updated` 通知观察者。适配器契约 `LlmAdapter` 是一个抽象类，**唯一必须实现的方法是 `stream()`**——其余 `providerInfo` / `listModels` / `resolveModel` 都有默认实现，只是"描述性"元数据，不影响路由与请求。

### 2.3 "一行代码换供应商"

那么"换供应商"到底要动什么？机制在 `GenerateOptions.provider`：它选中"已注册的 provider 路由"，路由决定适配器实例。所以换供应商 = 让另一个适配器插件注册你想要的 provider 路由——`llm-deepseek` 注册 `deepseek-official`；`llm-pi-ai` 则把配置文件里每个 profile 的键都注册成路由（OpenAI、Anthropic，以及任何你自指的网关），配置一变就原子换路由。两个插件可以同时在线、互不干扰；同一个路由名只允许一个适配器（`DUPLICATE_ADAPTER`）。于是"换模型"常常真的只是一行配置的改动——换 `provider` 字段，甚至只是换 `model` 字段；引擎、日志、工具调用链全都不变。这就是接缝的意义：**你改动的是配置，不是引擎。**

---

## 三、DeepSeek provider：真实实现

### 3.1 插件注册

`llm-deepseek` 是一个标准的函数插件：`name`、`inject`（声明注入 `llm` 服务）、`Config` 走 schemastery 校验。它只拥有一个 provider 路由：

*来源：`packages/llm/llm-deepseek/src/index.ts:41-47`（原文摘录）*

```ts
export const name = 'llm-deepseek'
export const inject = ['llm']

const NS = settingsNamespace('llm-deepseek')
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
/** The single provider route this plugin owns. */
const PROVIDER = 'deepseek-official'
```

`apply(ctx, config)` 里做两件注册：先声明"可通过配置激活的 provider"（配置界面据此在路由还没注册时就展示它），再真正注册路由：

*来源：`packages/llm/llm-deepseek/src/index.ts:250-256`（原文摘录）*

```ts
const adapter = new DeepSeekAdapter({ options, resolveApiKey, resolveUserId })
ctx.llm.registerConfigurableProviders([
  { provider: PROVIDER, displayName: 'DeepSeek', settingsNs: NS, settingsPath: [] },
])
// Route effects bind to this apply fiber via the stable `ctx` reference,
// even when a swap runs inside the scoped settings callback below.
const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
```

实现类的声明一句话就能概括：

*来源：`packages/llm/llm-deepseek/src/adapter.ts:158-161`（原文摘录）*

```ts
export class DeepSeekAdapter extends LlmAdapter {
  constructor(private readonly config: DeepSeekAdapterOptions) {
    super()
  }
```

它的文档自述是 "transport-only"：连接事实（baseURL、默认值、目录）通过一个 thunk 每次操作重新解析，Bearer token 通过每次请求的 resolver 解析。于是**配置改动无需重启就作用于下一次请求**——`options` 读的是每次调用时的最新快照，而一个正在流式传输的请求保持它开始时拿到的快照。

### 3.2 请求构造：从 GenerateOptions 到 HTTP body

`stream()` 内部走 `request()`：`serializeRequest(options, connection.defaults)` 把装配好的请求翻译成 DeepSeek chat-completions 的 body。看返回部分就够了——永远 `stream: true`，可选字段缺省不发（让厂商默认值生效），而不是发 null：

*来源：`packages/llm/llm-deepseek/src/serialize.ts:173-186`（原文摘录）*

```ts
return {
  model: options.model,
  messages,
  stream: true,
  stream_options: { include_usage: true },
  ...resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {},
  ...resolvedThinking.reasoningEffort !== undefined
    ? { reasoning_effort: resolvedThinking.reasoningEffort }
    : {},
  ...tools !== undefined && tools.length > 0 ? { tools } : {},
  ...options.temperature !== undefined ? { temperature: options.temperature } : {},
  ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
  ...options.stop !== undefined ? { stop: options.stop } : {},
}
```

`messages` 的序列化规则同样值得记住：`system` 角色原样映射；assistant 消息的文本进 `content`、工具调用进 `tool_calls`，思考内容只在工具调用回合作为 `reasoning_content` 回传（官方 passback 规则，省 token）；`tool-result` 块展开成独立的 `role: 'tool'` 消息。核心图片块被显式拒绝——这条线路是纯文本的。

headers 也一目了然。注意 `attributionHeaders()` 是每个厂商请求都必须带的（`User-Agent` 归属头，有 wire 级测试证明），而 `x-deepseek-harness-*` 是会话与用途元数据：

*来源：`packages/llm/llm-deepseek/src/adapter.ts:283-295`（原文摘录）*

```ts
const headers = {
  'authorization': `Bearer ${apiKey}`,
  'content-type': 'application/json',
  'accept': 'text/event-stream',
  ...attributionHeaders(),
  'x-deepseek-harness-user-id': String(userId),
  ...options.sessionId !== undefined
    ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
    : {},
  ...options.purpose === 'compaction'
    ? { 'x-deepseek-harness-compact': '1' }
    : {},
}
```

### 3.3 传输与错误归一化

`fetch` 失败（DNS、拒连、TLS、代理）被包成 `LlmError('TRANSPORT', { cause })`，保留可诊断的原因链；非 2xx 响应解析厂商错误体，映射到稳定的机器码：401/403 → `AUTH`、429 → `RATE_LIMIT`、400 且命中上下文溢出特征 → `CONTEXT_WINDOW_EXCEEDED`、5xx → `SERVER`。厂商的 `retry-after` 变成 `providerRetryAfterMs`，`x-request-id` 变成 `requestId`。**一句话定义：适配器 = 把 `GenerateOptions` 翻译成某家厂商的 HTTP 请求、再把厂商的流翻译回 `StreamChunk` 的翻译器，途中所有失败归一成 `LlmFailure`。**

---

## 四、流式：从 chunk 到日志

### 4.1 llm/stream 瀑布与 adapterStream

`LlmRuntime.stream()` 的实现很薄：`streamWithRegistration` 把调用包进 Cordis 瀑布——`this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))`。`llm/stream` 是类型上绑定在 `LlmRuntime` 上的 waterfall 事件：监听器要么调用 `next()` 放行到已解析的适配器流，要么自己 yield chunks 短路整次调用。`adapterStream` 是**最终适配器边界**：适配器选择、派发、迭代的失败都会归一成一条终结的 `finish {kind:'error'|'aborted'}` chunk，而不是让异常漏出去砸到调用方；middleware 与消费方的失败则保持抛出。

### 4.2 从原始 chunk 到 assistant/message

现在把第 4 章那条链路 `agent/request -> llm/stream -> assistant/chunk* -> assistant/message` 补全。loop 拿到 `StreamChunk` 流之后，用同一份 chunks 做两件事：**逐条记日志**——`assistant/chunk*` 原始事件保真，回放与 UI 都靠它；**同时喂给共享的 `BlockAssembler`** 折叠成完整的 `ContentBlock`、usage、finish reason 与 replay state，流结束时以 `assistant/message` 落盘，折叠结果带着产生它的 provider 与 model：

```text
agent-loop（每个 step 一次）
  ① agent/request 瀑布：改写 provider/model/采样 ──► ② llm/stream 瀑布：包装/短路流
  ──► DeepSeekAdapter.stream()：fetch POST {baseURL}/chat/completions
  ──► translate() ──► StreamChunk 流（block-start / *-delta / block-end / usage / finish）
  ──► 同一份 chunks 走两条路：
       ├─ session log：assistant/chunk*（逐条原始事件，保真可回放）
       └─ BlockAssembler ──► assistant/message（折叠结果 + usage + finish + replayState）
```

### 4.3 结束语义：usage 在 finish 之前

适配器契约里有一条最容易被违反、也最值得记住的排序：**`usage` 必须在 `finish` 之前，`finish` 之后什么都不许再有**。DeepSeek 适配器用最朴素的策略遵守它：`translate()` 把 `block-end`、`usage`、`finish` 全部推迟到 SSE 的 `[DONE]` 哨兵，一次性收尾：

*来源：`packages/llm/llm-deepseek/src/translate.ts:101-118`（原文摘录）*

```ts
for await (const payload of payloads) {
  if (payload === DONE) {
    for (const block of order) {
      yield { type: 'block-end', index: block.index, block: closeBlock(block) }
    }
    if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
    const reason = pendingFinish ?? { kind: 'stop' as const }
    yield {
      type: 'finish',
      reason: reason.kind === 'stop' && order.length === 0
        ? {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
        }
        : reason,
    }
    return
  }
```

这段同时展示两个语义细节：思考增量先于文本（thinking mode 交错），首个空字符串增量不开块；以及"空完成是可重试错误"——`stop` 结束却没有打开任何块，映射成 `finish {kind:'error'}`，code 是规范的 `EMPTY_RESPONSE`，`dsh-llm-retry` 默认重试它。usage 映射时，DeepSeek 的 `prompt_tokens` 包含缓存命中，`mapUsage` 会把缓存读数减回不相交口径。而 token 的消费方之一 `dsh-token-meter` 从会话日志重放出一份"请求压力与位置定价"快照——这再次印证上一章的不变量：**模型可见即日志**，流式的每个原始增量都进了日志，事后怎么算都有据可依。

---

## 五、agent/request：模型调用被插件替换的入口

### 5.1 waterfall 纪律回顾

第 2 章讲过 Cordis 的 waterfall 语义：监听器**必须调用 `next()` 才放行**，不调用就短路整条链。这个纪律在模型调用路径上有两个落点：`agent/request` 与 `llm/stream`（外加三个 `tools/*`）。前者是"改配置"的正式入口，后者是"包装或替换流"的兜底——两个瀑布让模型调用可以在引擎不知情的情况下被插件替换。

### 5.2 请求前的配置改写

`agent/request` 收到的是一个**冻结的 call-config 种子**，监听器可以返回一个替换值，切换 provider、model、reasoning effort 或采样参数。这个种子的类型是 `LlmCallConfig`：

*来源：`docs/subsystems/llm-streaming.md:606-613`（对应 `packages/llm/llm/src/types.ts` 原文）*

```ts
interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: string[]
}
```

每个字段与同名 `GenerateOptions` 字段一一对应；loop 从已记录的请求头重建请求，而不是每次接受新配置。时序上有三个细节值得记住：

1. **瀑布之前**：loop 先移除被标记为"适配器默认值"的字段（`reasoningEffort` / `maxTokens` 若是适配器补的，就不该留在提案里和精确模型解析打架），未标记的显式设置留在提案中。
2. **瀑布之后**：精确模型解析（`prepareCall` / `resolveCallConfig`）对不支持的显式 effort 直接拒绝（`UNSUPPORTED_REASONING_EFFORT`），不做钳制或别名化；适配器补的默认值会记进日志头部。
3. **llm/stream 入口**：适配器查找发生在 `llm/stream` 瀑布的末端延续上——监听器可以在查找前短路调用，或改写一次性请求；到达适配器的 loop 请求是深度冻结的，改写即抛错，其内容必须是会话日志的纯函数（上一章的重建不变量）。

**一句话定义：`agent/request` 是"这次调用用哪家、哪个模型、怎么采样"的决策点，决策可以被任意插件改写，而引擎不感知。**

---

## 六、本章小结

这一章把模型调用这条窄接口拆到了底，你带走了三层东西。**词汇层**：会话是 `Message` 序列，消息是类型化内容块数组；流式是带块索引的 `StreamChunk` 序列，`usage` 在 `finish` 之前，`finish` 之后一无所有，失败归一成一种 `LlmFailure`。**接缝层**：`ctx.llm` 服务 = 适配器注册表 + 流式调用 API；Service Definition 只写接口，provider 插件只写翻译，消费方只写调用；换供应商改的是配置，不是引擎。**路径层**：`agent/request` 改配置 → `llm/stream` 包装流 → `assistant/chunk*` 逐条落日志 → `BlockAssembler` 折叠成 `assistant/message`，全程没有一处假设"模型是谁"。模型是引擎最熟悉的陌生人——接口越窄，替换越便宜，日志越全，回放越真。

下一章走进工具系统：`ctx.tools` 的注册、作用域与执行管线——`tool/call*` → `tools/pre-execute` → `tools/execute` → `tools/post-execute` → `tool/result*`。模型请求里的 `ToolSchema` 只是线缆上的描述，真正的执行管线在那一章。
