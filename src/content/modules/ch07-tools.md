---
order: 7
title: "第7章：工具系统 —— 注册、作用域与执行管线"
summary: "工具注册表与守卫式执行管线：pre-execute、execute、post-execute 如何管住 Agent 的手脚。"
status: published
words: 5167
codeLines: 155
minutes: 26
updated: "2026-08-14"
---

# 第7章：工具系统 —— 注册、作用域与执行管线

读到这里，你已经知道 Agent 的"大脑"怎么工作：M06 讲模型调用，M04 讲循环如何驱动一次 step。但大脑要动手做事，还得有"手脚"——读写文件、执行命令、搜索网页、派生子 agent，这些动作在 dsh 里统一由**工具**承载。这一章我们解剖工具系统：`ctx.tools` 这个作用域注册表怎么收编工具（一、二），工具 schema 怎么进入模型视野（三），一次调用怎么穿过 pre-execute → execute → post-execute 的执行管线（四），以及"模型发起 → 日志记下"的完整链路（五）。贯穿始终的是一句提醒：工具是 Agent 的能力，而能力必须被管住——注册是受检的，可见性是分作用域的，执行是要过审的。准备好了，我们从注册开始。

---

## 一、注册：ctx.tools.register

一句话定义：**`ctx.tools` 是作用域工具注册表——工具在这里注册、按作用域解析、也在这里执行。** `docs/subsystems/tools.md` 对它的定位是 "Tool registry and execution pipeline"，架构文档则把"加一个模型可见能力"直接映射成 "register on `ctx.tools`"——工具注册表是整个能力缝的锚点。

### 1.1 注册 API：返回 disposer

工具注册的入口是 `ToolRuntime.register`。注意它的返回值：**disposer**。这正是 M02 讲过的"注册即 effect"——`register` 内部走 `this.layers.effect(...)`，注册挂在调用它的插件上，插件卸载时自动撤销；同一个作用域里重名、或者撞上保留名 `run_code`，注册直接失败：

*来源：`packages/core/tools/src/index.ts`（ToolRuntime.register，行 1031–1062，中略校验段），逐字摘录。*

```ts
  /**
   * Register globally or in the calling agent scope. Scoped tools shadow
   * globals; duplicates within one layer and the reserved `run_code` name fail.
   * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
   * @returns the exact disposer that unregisters the tool.
   */
  register(definition: ToolDefinition): () => void {
    const name = definition.name
    // ……（中略：校验 output / schema / timeoutMs，保留 run_code 名字）
    return this.layers.effect(
      this.ctx,
      layer => layer.tools.insert(name, definition),
      { label: 'tools.register()' },
    )
  }
```

注意 JSDoc 第一句：**"Register globally or in the calling agent scope"**——注册的落点由"调用它的 ctx 是不是 agent 作用域"决定，这正是下一节的主角。中略掉的校验段我们也会在 1.2 提到。

### 1.2 一个工具定义长什么样

一个工具的完整定义是 `ToolDefinition`——它 extends `ToolSchema`（模型可见的 `name` / `description` / `parameters`，来自 M06 见过的模型请求 wire 类型），再加一个强制性的 `output` 规范声明、一个 `execute` 函数，以及一组可选回调：

*来源：`packages/core/tools/src/index.ts`（ToolDefinition，行 221–235，中略可选回调），逐字摘录。*

```ts
/** A registered tool: its schema plus the execution function. */
export interface ToolDefinition extends ToolSchema {
  /** Mandatory canonical output declaration. */
  readonly output: ToolOutputDefinition
  /**
   * Run one accepted call and return only its canonical lossless-JSON value.
   * Async work must observe or forward `exec.signal` and settle only after its
   * owned work reaches quiescence. The registry preserves caller cancellation
   * through around-dispatch signal replacement and does not abandon this
   * promise, but it cannot hard-kill same-process code.
   * @param args - losslessly snapshotted, frozen model arguments.
   * @param exec - execution identity, cancellation signal, and context deferral.
   * @returns the canonical value declared by `output.schema`.
   */
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  // ……（中略：finalizeContent / timeoutMs / isConcurrencySafe / presentCall / presentResult）
}
```

逐个拆解。`output` 是**工具自有的 canonical 输出契约**：`schema` 是注册时就要校验的原始 JSON Schema，`render` 把校验过的值投影成模型看到的 `ContentBlock[]`，`presentationMeta` 是可选的纯投影。`execute(args, exec)` 收的是 `unknown`——**工具自己校验自己的输入**，一方工具用的 `defineTool` 会基于 schema 推断参数类型并做校验。可选的 `finalizeContent` 是同步的"最后一英里"内容变换，恰好调用一次；`timeoutMs` 是协作式超时预算（由 `tools/execute` 的一个 wrapper 强制，**绝不发给模型**）；`isConcurrencySafe` 决定这个调用能不能和兄弟调用并行；`presentCall` / `presentResult` 是纯函数式的 UI 呈现意图——"card"-tagged 联合类型，UI bridge 按 `card` 分发，见 `packages/core/tools/src/presentation.ts`（比如 `bash` 声明 `card: 'terminal'`，编辑器就能把它画成一个终端卡片）。这些呈现方法都只依赖参数与结果的纯投影：UI 在实时流式时能调，会话日志重放时也能调，同一份 args 永远渲染出同一张卡片。

这套定义还隐含一条纪律：**注册是受检的，不是照单全收**。`register` 拒绝没有 `output` 的工具；`output.schema` 走 `assertSupportedJsonSchema` 强制校验原始 JSON Schema 子集——不合规的 `oneOf` 分支、指向不存在属性的 `required` 这类问题直接拒绝，而不是收下再悄悄不执行。一方工具用 `defineTool({ name, description, parameters, output, execute, … })` 声明：参数 schema 会推断出 TS 类型并校验（参数不合法抛 `ToolArgsError` / `INVALID_ARGS`），输出 schema 会同时约束 `execute` 的返回值与 `render` / `presentationMeta` 的投影（违反抛 `ToolOutputError` / `INVALID_TOOL_OUTPUT`）。这些错误都走普通工具错误路径——结构化、可路由，而不是把插件炸掉。

---

## 二、作用域：谁的工具谁看见

一句话定义：**作用域是"一个 opaque 身份键 + 一套按层继承的注册视图"——它同时决定"注册进哪一层"和"事件派发给谁"。** dsh 的 scope 包（`@deepseek-ai/dsh-scope`）提供这个原语；注意它不是 Cordis 服务（architecture.md 核心包表格里它没有 `ctx` key），而是被 `ctx.tools`、`ctx.systemPrompt` 这类注册表内部使用的库。scope 文档的原话是：它让"一个注册上下文同时意味着 per-agent 可见性和共享的生命周期所有权"。身份键就是 `ScopeKey`——一个不透明对象，shipped 的循环直接用**活的 `Agent` 对象**当自己的 key：

*来源：`packages/core/scope/src/index.ts`（ScopeKey，行 14–15），逐字摘录。*

```ts
/** An opaque, identity-compared scope key. */
export type ScopeKey = object
```

### 2.1 遮蔽、继承与限制

工具注册表按"层"组织：一个**全局层**（部署级，`dsh-base` 挂的通用工具）加每个 agent 一个**精确作用域层**。解析某个 scope 看到什么，是一次"层遍历"（`view()`），规则有三条。第一，**继承**：scope 继承全局层加它祖先链上每一层的注册。第二，**遮蔽**：自己的注册压过继承的同名项——JSDoc 原话 "Scoped registrations shadow globals"。第三，**限制**：`restrict({ allow? / deny? })` 只过滤**继承面**（`allow` 保留名单 / `deny` 移除名单），绝不动自己层的注册——这是子 agent 的委托工具始终可见的原因；多个限制取交集。

`view()` 的遍历顺序值得说清楚：先按"最远祖先在前"取 scope 链上的层，与全局层一起构成**继承面**；再用链上每一层的限制做交集过滤；然后叠加该 scope 自己的注册——own 层是链外单独 peek 的，**不受限制影响**；最后，非 native 模式把保留的 `run_code` 运输追加进可见集。产物折叠成三个集合：`visible`（真正会投影给模型的定义）、`knownNames`（限制前的能力全集，供 prompt-order 校验）、`restrictableNames`（当前全局名，供 restrict 校验名字是否合法）。

`restrict` 本身也很挑剔：空过滤器（`{}`）是 no-op 直接报错，未知的全局名、作用域本地名、保留的运输名全部失败——它只会出现在"我确实想裁掉什么"的地方。组合起来的效果是：一个子 agent 既被父级限制了能力，又能保留委托运行时为它注册的报告与结构化输出工具，因为那些注册落在它自己的层里，不在过滤范围内。

### 2.2 事件分发也是 scoped

作用域不只是注册表的组织方式，还管**事件派发**。`'tools/pre-execute'` 这类事件的 `this` 类型是 `Scoped<ToolRuntime>`——由 `scopeTarget` 构造的"只做路由的接收器"，真正的事件载荷携带实体的 agent（第 4 节会看到每个事件 JSDoc 里那句 "Scope-filtered dispatch"）。挂在 agent 作用域上的监听器只收到该 agent 的调用；挂在祖先上的监听器也能收到后代派发的。这段关系在 scope 包里是一条父链：`bindScopeParent` 把 key 绑到父 key（带环检测），`scopeChainOf` 给出从 key 到根的链——**注册视图沿链向下继承，事件准入沿链向上延伸**。画个图把层收进眼里：

```text
       全局层（部署级通用工具：bash · write · edit · grep …）
                     │ 继承（farthest ancestor first）
   ┌────────────────┼─────────────────┐
   ▼                ▼                 ▼
 agent A 层        agent B 层        agent C 层（own 注册/遮蔽/restrict）
```

*示意图（笔者绘制）：每个 agent 一层，继承全局面；own 注册遮蔽继承项，restrict 只裁剪继承面。*

---

## 三、schema 组装：工具如何进入模型视野

### 3.1 从注册表到系统提示

工具注册进注册表，不等于模型就能看到它。模型看到的是一份 **schema 清单**——每次装配 prompt 时，`systemPrompt` 把所有 tools provider 的返回收集起来、剥离参数、按 `toolOrder` 排序、放进系统提示。还记得 M02 里 ToolRuntime 构造器那段吗？真正把工具送进系统提示的就是这一行：

*来源：`packages/core/tools/src/index.ts`（ToolRuntime 构造器，行 826–837），逐字摘录。*

```ts
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tools')
    // ……（中略：解析 mode / maxParallelSubCalls 默认值）
    ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
    if (this.defaultMode !== 'native') {
      ctx.systemPrompt.section(this.collapseSection())
      ctx.systemPrompt.section(this.sdkSection())
    }
  }
```

`ctx.systemPrompt.tools(...)` 把"按 scope 生成 schema"的 provider 挂上；装配时 `assemble()` 逐个调用 provider、`structuredClone` 剥离参数（细节在第 10 章 prompt 与上下文展开）。这个 provider 返回什么，取决于**呈现模式** `Config.mode`：

*来源：`packages/core/tools/src/index.ts`（Config，行 650–666，略去 ToolPresentationMode 类型行），逐字摘录。*

```ts
/** Plugin config: how the registered tools are presented to the model. */
export interface Config {
  /**
   * Model presentation. `native` (default) sends every visible schema; `code`
   * sends only `run_code` plus a generated SDK prompt and collapses the
   * executor to the same surface (a model-direct call may only name
   * `run_code`; `run_code` SDK sub-dispatches keep every visible tool); `both`
   * sends both forms. Code modes require a `ctx.codeRuntime` whose `language`
   * has a registered SDK renderer (TypeScript or Python) and fail prompt
   * assembly when it is absent or has no renderer. Under `code`, native names
   * in `toolOrder` are invalid.
   */
  mode?: ToolPresentationMode
}
```

### 3.2 三种呈现模式：native / code / both

三种模式的含义都在 JSDoc 里：`native`（默认）把每个可见 schema 都发给模型；`code` 只发 `run_code` 加一份生成的 SDK prompt——模型直接调任何其他工具名都会在管线前被拒成 `UNKNOWN_TOOL`（这叫 "collapse"：模型必须从程序内部调工具）；`both` 两种形式都发。code 模式要求一个 `ctx.codeRuntime`，语言没有注册的 SDK renderer 时装配直接响亮失败。`wireSchemas` 就是按模式裁切清单的地方：

*来源：`packages/core/tools/src/index.ts`（wireSchemas，行 980–1001，中略注释段），逐字摘录。*

```ts
  private wireSchemas(scope?: ScopeKey): ToolProviderResult {
    const view = this.view(scope)
    const mode = this.modeFor(scope)
    if (mode === 'native') {
      const schemas = [...view.visible.values()].map(definition => this.schemaOf(definition, false))
      return { schemas, knownNames: [...view.knownNames] }
    }
    // ……（中略：code 模式先校验 code runtime 语言，再投影全部可见 schema）
    const schemas = [...view.visible.values()].map(definition => this.schemaOf(definition, false))
    if (mode === 'code') {
      return {
        schemas: schemas.filter(schema => schema.name === RUN_CODE_NAME),
        knownNames: [RUN_CODE_NAME],
      }
    }
    return { schemas, knownNames: [...view.knownNames, RUN_CODE_NAME] }
  }
```

注意 `code` 分支：`schemas.filter(schema => schema.name === RUN_CODE_NAME)`——把其余全部滤掉，只留运输工具。`code` 模式为什么要连 prompt 一起管？因为模型只能从 prompt 里知道规则：`CODE_ONLY_INSTRUCTION` 那句话把后果和出路都写明白了——"`run_code` 是唯一可以直接调的工具——调任何其他工具都会失败。程序内部可以调用 SDK 声明的所有工具"。这个 collapse 段排在第 99 位，先于每工具 100-199 的指导段，让模型在读"有哪些工具"之前先读到"只能这么调"——一条只能靠被拒绝才能发现的规则，是模型纠正得太晚的规则。`both` 分支则落回最后的 `return`：全部 schema 照发，`knownNames` 里再加上 `RUN_CODE_NAME`。

### 3.3 白名单投影：只有三个字段

而无论哪种模式，投影单个定义时都走同一个 `schemaOf`，它只取三个字段：

*来源：`packages/core/tools/src/index.ts`（schemaOf，行 1255–1267），逐字摘录。*

```ts
  /** Project one definition onto the model-facing schema fields. */
  private schemaOf(definition: ToolDefinition, detachParameters: boolean): ToolSchema {
    const { name, description, parameters } = definition
    const detached = detachParameters ? snapshotJsonValue(parameters) : parameters
    if (detached === undefined) {
      throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`)
    }
    return {
      name,
      description,
      parameters: detached,
    }
  }
```

一句话定义：**schema 组装 = 按可见集投影、按模式裁剪、只放行 name/description/parameters 三个白名单字段。** `execute`、`output`、`finalizeContent`、`timeoutMs`、`presentCall` / `presentResult` 这些执行与呈现细节，永远不上模型请求的线——"模型可见即日志"的另一面，是"模型只该看见它该看见的"。另外注意 `schemaOf` 里的 `snapshotJsonValue(parameters)` 不是白做的：每次装配都对参数做一次无损快照，防止 provider 在装配途中改动参数对象、污染已经交给模型请求的 schema。

---

## 四、执行管线：pre-execute → execute → post-execute

一句话定义：**执行 = 可扩展的 waterfall 链 + 单调守卫——pre-execute 管"允不允许"，守卫管"不能再翻盘"，execute 环绕调度，post-execute 归一化结果。** `docs/tool-execution-pipeline.md` 画了完整流程：`tool/call` 先落日志 → `presentCall` 出 pending 卡片 → `tools/pre-execute` → 单调守卫 →（deny 或被拒的 ask 跳过 body）→ `tools/execute` 环绕调度 → 工具 body →（body 内部的 `fs/*` 意图事件、工具自有事件）→ `tools/post-execute` → 注册表外层归一化 → `finalizeContent` → `tools/result` 同步通知 → `tool/result` 落日志 → pending 卡片变完成卡片。三个 waterfall 都可以变换调用；**被拒的调用也照常走 post-execute**（失败也是结果，也要被审视）。

### 4.1 pre-execute：allow / deny / ask

M02 你见过 `'tools/pre-execute'` 的声明，这里把它和 `'tools/post-execute'` 并排看——注意 JSDoc 里的 `@mode waterfall`（waterfall 语义来自第 2 章）和 `Scope-filtered dispatch`：

*来源：`packages/core/tools/src/index.ts`（'tools/pre-execute' 事件声明，行 143–152），逐字摘录。*

```ts
    /**
     * Allow, deny, or ask before dispatch. `next()` delegates to allow; missing
     * approval support turns `ask` into denial. Async gates must observe
     * `exec.signal`; the registry rechecks cancellation after they settle but
     * never abandons their promise.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
     * @param exec - the pending call (name, parsed arguments, caller agent).
     * @mode waterfall
     */
    'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
```

pre-execute 的决策是三态的：

*来源：`packages/core/tools/src/index.ts`（PreToolDecision，行 582–591），逐字摘录。*

```ts
/**
 * Pre-dispatch decision. `allow` runs the call; `deny` materializes an error;
 * `ask` runs only after an approval service returns `allowed-once` and otherwise
 * denies. Input rewriting is excluded because arguments are already logged and
 * presented.
 */
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }
```

`next()` 委托 = allow；`ask` 表示"问一下人"——只有审批服务返回 `allowed-once` 才放行。审批是**可选缝**：`execute` 内部用 `ctx.get('approval')` 探测，没装就优雅降级为拒绝（详见 `docs/subsystems/approval.md`）。四种非授予结果落点值得记一下：`rejected`（人拒绝了）、`cancelled`（审批被取消）、`unavailable`（没有可用通道）、以及根本没装审批服务或调用没有 agent，各自带不同的 deny reason——`the user rejected tool "bash"` 和 `requires approval, but no approval channel is available` 是两种截然不同的转述，模型因此能区分"人说了不"和"根本没通道"。deny 会产生一个错误结果，但不会终结回合。注意 `PreToolDecision` 注释最后一句：**参数不允许改写**——历史、审计、UI 与执行必须对同一份参数达成一致。

### 4.2 单调守卫：只能更严，不能翻盘

pre-execute 之后、body 之前，还有一层注册的**单调守卫**：

*来源：`packages/core/tools/src/index.ts`（ToolGuard，行 703–711），逐字摘录。*

```ts
/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged. Because guards have no allow
 * result, listener ordering cannot turn a denial back into permission.
 * @param execution - the identity-protected call after extensible pre-execute policy completed.
 * @returns a final denial reason, or `undefined` to leave the call allowed.
 */
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
```

守卫的返回值故意**没有 allow 结果**：返回 `undefined` 保持原判，返回 reason 只能减少权限——所以无论监听器怎么排序，都不可能把一次 deny 翻回 allow。这就是 "monotonic"。普通 ctx 上注册的守卫全局生效，通过 `agent.ctx` 注册的只对该 agent 生效；`guard()` 返回的 disposer 同样用于有序所有权和 HMR 清理。为什么瀑布之后还要一层守卫？因为瀑布是可重排的（哪个插件先听、谁说了算都取决于注册顺序），而某些 owner 策略不允许被顺序推翻——它必须待在瀑布外面，作为"最终一票"。

### 4.3 post-execute：accept / replace / block

post-execute 看的是 dispatch 之后的结果，决策类型如下：

*来源：`packages/core/tools/src/index.ts`（PostToolDecision，行 593–600），逐字摘录。*

```ts
/**
 * Post-dispatch decision: accept, replace one projection, attach context for the
 * next request, or block by turning corrective feedback into an error result.
 */
export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }
```

`accept` 只能替换 content 或 value 之一（换 value 会重新校验并按 `output` 重新渲染 content）；`block` 把结果变成 `isError`，内容换成纠正性 feedback——模型下次就能读到"你为什么错"。两种决策都可以附带 `additionalContexts`，走循环的 active-batch FIFO。**抛异常的工具也到达这里**：工具 body 抛错、未知工具名（`ToolNotFoundError` 映射为 `UNKNOWN_TOOL`）、甚至 post-policy 自己抛错，都会被注册表归一化成结构化错误，不会炸掉整个回合。

*来源：`packages/core/tools/src/index.ts`（'tools/post-execute' 事件声明，行 164–175，中略取消语义段），逐字摘录。*

```ts
    /**
     * Accept, replace, enrich, or block a normalized dispatch result. `next()`
     * accepts it unchanged; thrown tools still reach this waterfall as errors.
     * // ……（中略：取消语义——成功后替换为 ABORTED / ABORTED_BEFORE_DISPATCH）
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
     * @param exec - the call that just ran (name, parsed arguments, caller agent).
     * @param result - the dispatch outcome a listener may accept, replace, or block.
     * @mode waterfall
     */
    'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
```

夹在中间的 `tools/execute` 是**around-dispatch** waterfall，专门放横切关注点：超时（`timeoutMs` 的强制执行者 `@deepseek-ai/dsh-tool-call-timeout-policy` 就是它的一个 wrapper）、重试、指标。wrapper 只能替换 `exec.signal`、不能移除它；注册表在调 body 前把调用方 signal 重新 fuse 回去（`fuseToolSignals`），所以替换包装不了调用方取消。取消语义是双态的：body 还没启动 → `ABORTED_BEFORE_DISPATCH`；body 已启动 → 排空到 quiescence 后用 `ABORTED` 替换成功结果。

### 4.4 归一化：把"什么都可以"收敛成"只有一种结果"

管线末端还有一层**注册表归一化**。成功路径上，body 的返回值先 `snapshotJsonValue` 无损快照成 JSON、按 `output.schema` 校验、`deepFreeze`，再调用纯函数 `render` 投影成 content，`presentationMeta` 只对顶层调用投影——任一步失败都变成 JSON-safe 的 `isError`。之后是 `finalizeContent`：注册表在执行开始时快照这个回调，对**每一个**归一化结果（包括绕过 post-execute 的管线失败）恰好调用一次，且要求同步、total、不抛错——它是内容层的最后一道工具自有不变量。再往后 `tools/result` 以 emit 方式观察 deep-frozen 的最终结果：observer 抛错被包含，只记一条 warn，绝不污染结果本身。`ToolExecutionResult` 是判别联合——成功带 `value`（execution-local，故意不进持久事件），失败带 `error: { message, info? }`，两边都有 `content` 和可选的 `meta` / `additionalContexts`。

---

## 五、从调用到结果：tool/call* 与 tool/result*

### 5.1 Turn flow 里的一步

现在把整条链路串起来。M04 讲过的"工具回合"里，agent 循环读到模型回复中的 tool-call 块，这一轮 step 就进入工具执行。architecture.md 的 Turn flow 把这一段钉在 step 中间：

*来源：`docs/architecture.md`（Turn flow，行 73–78），逐字摘录。*

```text
     step/start
     append entered messages as user/message
     derive model history from the log
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
```

这段的关键在事件后缀：`tool/call*` 和 `tool/result*` 是**持久 session 事件**，其余 `tools/*` 是活的扩展点。展开来看：

```text
模型回复含 tool_call
   │
   ▼
tool/call* 落日志 → presentCall pending 卡片
   ▼
execute 管线：pre-execute → 守卫 → execute → body → post-execute
   ▼
ToolExecutionResult（frozen lossless JSON）→ tools/result 同步通知
   ▼
tool/result* 落日志 → UI 完成卡片 → 会话日志（重放/上下文来源）
```

*示意图（笔者绘制）：模型侧的调用如何变成执行、再变成日志里的一对持久事件。*

### 5.2 值得停下的五个点

沿途有几个值得停下的点。**第一，执行前先记账**：`tool/call` 在管线启动前就落日志，"模型可见即日志"从这一端就开始。**第二，结果只有一个**：注册表把所有归一化结果（成功、deny、抛错、block、取消）收敛成 `ToolExecutionResult`，`tools/result` 观察 deep-frozen 快照，observer 抛错被包含。**第三，canonical value 是 execution-local 的**：`tool/result` 持久化的只有 `content` / `error` / `meta`——重放能重建呈现，但重建不出中间值，这正是日志保真的边界。**第四，身份贯穿全程**：`callId` / `rootCallId` / 注册表铸造的 opaque `token` 让调用、事件、日志三者可关联；嵌套调用（Code Mode 的 `run_code` 子派发）靠 `parent` token 挂到外层执行树上，记 `tool/code-dispatch` 而不是 `tool/result`。**第五，调度有模式**：循环会先问注册表每个 pending call 的执行模式——`isConcurrencySafe` 返回精确 `true` 才可能并行，否则 fail-closed 为 exclusive，并行组与独占屏障由此形成。

### 5.3 回合的"续"：批次注入与下一轮 step

最后把回合的"续"补上：循环把整个批次的结果收集齐（`tool/result*` 全部落账）之后，active-batch 的 `additionalContexts` 按 FIFO 注入下一次请求；如果工具还欠着请求（Turn flow 里的 "tools owe another request"），这一轮 step 结束、下一轮 step 继续——工具回合就是这么一步步滚下去的。而无论滚多少步，模型看到的每一个结果都能从日志重建：这正是 M05 那条铁律在工具层的落地。

---

## 六、本章小结

一张卡片总结本章：**工具 = 注册（返回 disposer 的 effect）+ 作用域（继承、遮蔽、限制）+ 投影（白名单 schema）+ 管线（pre-execute / 守卫 / execute / post-execute / finalizeContent / tools/result）+ 日志（tool/call* ↔ tool/result*）。** 你从"怎么加一个工具"（`register`）走到了"一次调用的一生"（从 `tool/call` 落日志到 `tool/result` 落日志），也看到了手脚被管住的每一道关卡：注册校验、作用域裁剪、模式 collapse、执行前审批、单调守卫、结果归一化。工具系统的设计语言——waterfall 决策、单调策略、scope 路由、模型可见即日志——不是它独有的，而是整个 dsh 的通用语言；读懂这一章，你已经能读懂任何一个工具插件在干什么。

下一章（M08 事件驱动）我们终于正面处理这套语言本身：三个事件域（session 持久 / agent 实时 / capability 策略）怎么分工，waterfall 为什么要调用 `next()`，以及为什么说"选对事件域是大多数改动的第一个决策"。工具管线的这三个 waterfall，只是事件海洋里的一角。
