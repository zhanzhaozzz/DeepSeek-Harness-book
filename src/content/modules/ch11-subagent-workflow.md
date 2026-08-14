---
order: 11
title: "第11章：子代理与工作流 —— 让 Agent 分身"
summary: "从全新子代理到委托回合：一个接口背后的多种 provider，以及工作流编排。"
status: published
words: 5226
codeLines: 100
minutes: 26
updated: "2026-08-14"
---

# 第11章：子代理与工作流 —— 让 Agent 分身

一个 Agent 忙不过来怎么办？在 M04 我们看过 agent loop——一个 turn 接着一个 turn，模型在单一上下文里思考、调用工具、得到结果。但真实任务往往是并行的：同时查五份资料、分头审计二十个文件、先派一个"调研员"出去跑着，自己继续手头的事。这一章回答的就是这个问题：**分身**——派生子代理（subagent）把工作委托出去；以及**流水线**——用工作流（workflow）脚本把一大群子代理编排成有条理的生产线。两者都是能力接缝：和 bash、fs 一样，不在 agent loop 里，而是挂在 `ctx` 上的可选能力。先记住一句话：子代理解决"多一个脑"的问题，工作流解决"很多脑怎么管"的问题，而 `ctx.jobs` 是它们共同的"后台工位"——让分身可以异步跑、随时收。本章所有事实只来自 docs/subsystems/subagent.md、docs/subsystems/workflow.md、docs/subsystems/jobs.md、docs/architecture.md 与两个包的真实源码，代码摘录全部逐字复制。

---

## 一、subagent 接缝：一个接口，多种分身

### 1.1 一句话定义与接缝三件套

**一句话定义：subagent 接缝让一个 Agent 把任务委托给子代理；它是一个可选能力，不在 agent loop 里，所以它的类型住在自己的包里（`ctx.subagents`），而不是 core 里。**

M09 讲过能力接缝的三角色：Service Definition 声明接口、Service Provider 实现它、Consumer 使用它。subagent 接缝和 bash 接缝有一个关键差异，子系统文档开篇就点明：bash 一个 context 只允许一个 executor；而 subagent 接缝**允许多个 provider 实现共存于同一个 context**，各自按名字注册在 `ctx.subagents` 上，调用时按名字挑。它的注册表学的是 LLM 适配器注册表（`LlmRuntime.registerAdapter`），而不是 bash 的单服务 executor。这就是为什么它在 M01 的"扩展点表"里那么显眼：一个接口，背后站着一排完全不同的"分身工厂"。

架构文档 Capability seams 节给了最直观的跨度，原话：

> Subagent providers vary just as widely behind one interface, from a fresh child agent to a delegated turn in another product.

（来源：`docs/architecture.md:102`）

### 1.2 Service Definition：一个注册表类

先看 Service Definition 本体。它通过声明合并把 `ctx.subagents` 挂上 Cordis 的 Context——这是 Cordis 类型化扩展的标准姿势（M02 见过）：

*来源：`packages/subagent/subagent/src/index.ts:129-132`（Context 声明合并，节选）*

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    subagents: SubagentRuntime
  }
```

注册表本身是一个服务类，全部家当就是一个 `Map`：

*来源：`packages/subagent/subagent/src/index.ts:170-172`（Service Definition 类声明，节选）*

```ts
/** Named provider registry with one-shot runs, durable discovery, and continuable-child operations. */
export class SubagentRuntime extends Service {
  private providers = new Map<string, SubagentProvider>()
```

provider 契约很小——名字、能力声明、一个启动方法：

*来源：`packages/subagent/subagent/src/types.ts:285-289`（Provider 契约，节选）*

```ts
export interface SubagentProvider {
  /** Unique registry name (e.g. `spawn`, `fork`, `acp`). */
  readonly name: string
  /** The start-time features this provider supports (see {@link SubagentCapabilities}). */
  readonly capabilities: SubagentCapabilities
```

provider 是"命名的子代理传输"：同进程的 spawn / fork，进程外的 acp / codex / claude-code / dsh-sdk……每个都是一个实现。你选哪个，子代理就在哪跑：

```text
            ┌──────────────────────────────────────┐
            │  ctx.subagents：命名 provider 注册表   │
            │  （一个接口：SubagentProvider）        │
            └──────────────────────────────────────┘
              ▲ 按名字挑选：start(name, request)
   ┌──────────┼───────────┬───────────┬───────────┐
   ▼          ▼           ▼           ▼           ▼
 spawn       fork        acp        codex    claude-code
 全新子代理  继承父会话历史 ACP 子进程  Codex CLI  Claude Code
```

### 1.3 能力校验：fail loud，不静默降级

值得单独讲的是启动前的"能力校验"。provider 用静态描述符 `SubagentCapabilities` 声明自己支持的启动期能力：`outputSchema`、`depthLimit`、`toolFilter`、`persona`。服务在 `start()` 之前先校验：请求里要了某个能力而选中的 provider 没有，就抛类型化错误 `UNSUPPORTED_CAPABILITY`，**绝不接受后再忽略**——这是 AGENTS.md 里 "fail loud, no silent degradation" 规则的直接落地（`docs/subsystems/subagent.md` 的 Two kinds of capability 节）。

"可持续子代理"（continuable）则是另一条路径：**方法存在本身就是能力**。`SubagentProvider.prepareContinuable` 是可选的，没有它的 provider 直接拒绝 continuable 启动，TS 类型收窄就是发现机制。continuable 子代理是"一个持久子会话 + 至多一个进程内 Activation"，由 continuation manager 自己管理：provider 只贡献"创建规格"（今天就是可选的父会话历史 seed），此后再也看不到孩子的 Agent、handle、turn 或拆除。文档里那句"no continuable path creates a Task or an intermediate result-bearing wrapper"值得划重点——可持续子代理不走 jobs、不产生中间结果包装，孩子的 Agent inbox 是唯一的队列。

另一个值得记的持久化细节是 descriptor：每次启动都会快照一个 mode 判别的持久身份（`SubagentDescriptorData`），两种 mode 都带 provider 名——one-shot 可选带调用方提供的显示 label，continuable 必须带委托 description 作为持久创建标签，并额外快照孩子解析后的 provider/model 与可选 persona/toolFilter 供冷启动恢复；它刻意不快照合并可扩展的 AgentOptions 对象，所以无关扩展值不会弄坏续接。深度则是持久的 `SessionHeader.delegationDepth` 加合并可扩展的运行时字段 `AgentOptions.subagentDepth`，取较大者为准：进程内孩子持久化父深度 + 1，冷启动不能降低它，每次启动还会按绝对 `maxDepth` 上限拒绝越界请求。

---

## 二、委托与回收：delegation Consumers

### 2.1 模型面前：三个 Consumer

接缝的 Consumer 是面向模型的工具。subagent 文档列了三个：`dsh-tool-subagent`（按 provider 委托）、`dsh-tool-subagent-control`（可选的全局 `send_message`、`interrupt_agent`、`list_agents` 控制）、`dsh-tool-subagent-report`（可选的子代理内 `report` 回报通道）。M03 我们已经见过 `tool-subagent` 的行——它在 `dsh-base` 的 patch 里跟 `tool-fs`、`tool-bash`、`tool-web` 一起被 insert 进每个 profile。它的 Config 里最关键的一行是 `provider`：这个工具实例把委托发给哪个命名 provider；`maxDepth` 默认 3，`backgroundMode` 默认 `one-shot`。

### 2.2 一次委托的旅程

模型调用工具时，工具层把模型的 `{ description, prompt }` 加上自己的配置和 `exec.signal`，组装成 `SubagentStartRequest`，然后走 `ctx.subagents.start()`。前台路径的代码长这样：

*来源：`packages/subagent/tool-subagent/src/index.ts:425-429`（前台委托，execute 节选）*

```ts
        const run: SubagentRun = await ctx.subagents.start(config.provider, {
          ...request,
          signal: exec.signal,
        })
        return settleForegroundRun(run)
```

`start()` 内部（`packages/subagent/subagent/src/index.ts:414-426`）做四件事：按名字查 provider（查不到抛 `NO_PROVIDER`）、能力校验（`assertCapabilities`，缺能力抛 `UNSUPPORTED_CAPABILITY`）、快照持久 descriptor（`snapshotSubagentDescriptor`）、然后调 `provider.start(resolved)` 并把返回的 run 包上生命周期观测——`observeRun` 发射 `subagent/start`，结束时配对的 `subagent/end` 带着相同的 runId 和终态。结果回收统一走 `SubagentRun.result`，它 resolve 成 `SubagentResult`：`output`（孩子最后一条非空助手消息的内容）、可选的 `structured`（请求了 `outputSchema` 且被满足时）、以及 `stopReason`。`stopReason` 是合并可扩展的派生联合（M08 的 map + derived union 模式）：`completed` / `aborted` / `error` / `max-tokens` / `refusal`，后端可以加变体，Consumer 分支已知情况、未知的当失败处理。非 `completed` 意味着 `output` 可能不完整——工具层把它映射成 `isError` 的工具结果，而不是把部分输出报成成功；但孩子的部分文本仍会附在错误信息里带回给父模型。

`SubagentRun` 本身也是一份值得读的契约：它是 consumer 持有的"一次性可释放前台委托"句柄——一个结果、无转向、无续接；prompt 提交之后的事故都归 `result`，Consumer 必须 `await result` 并总是 `dispose()` 才能到达 quiescence，`dispose()` 幂等、取消剩余工作并释放资源。子代理级失败 resolve 成非 `completed` 的 stop reason，只有无法表示成 stop reason 的基础设施故障才会 reject。continuable 对话则根本没有 run——continuation manager 直接持有孩子的 `AgentHandle`，通过孩子自己的 inbox 排每一轮 turn。

### 2.3 run_in_background：三条出路

`run_in_background` 决定三种执行路线（文档：one-shot 策略默认前台，continuable 默认后台）：

- **前台**：等待 `result`，收集输出后 `dispose()`（上面的 `settleForegroundRun`）。
- **一次性后台**：把子代理包成一个 `kind: 'subagent'` 的 job 挂到 `ctx.jobs`（第四节展开），返回 `{ kind: 'background', jobId }`，之后用 `job_output` / `job_kill` 收集或停止。
- **continuable 后台**：走 `ctx.subagents.startContinuable()`，在 inbox 接受初始提示时就返回持久的 `subagentId`，此后用 `send_message` 续对话、`list_agents` 枚举、`interrupt_agent` 打断。

一次性后台的代码长这样——注意它怎么把子代理 run 适配成 job 的 hooks（`cancel` + `done`）：

*来源：`packages/subagent/tool-subagent/src/index.ts:404-422`（一次性后台委托，execute 节选）*

```ts
          // One-shot background child: job preflight finishes before the
          // starter can spawn, and the task-owned signal covers startup.
          const id = jobs.start({
            kind: 'subagent',
            label: args.description,
            owner: parent,
            run: () => {
              const controller = new AbortController()
              const start = ctx.subagents.start(config.provider, { ...request, signal: controller.signal })
              return {
                cancel: (reason?: string) => {
                  controller.abort(reason ?? 'background subagent task killed')
                },
                done: settleStart(start, controller.signal),
                // No readOutput: the child session owns intermediate detail.
              }
            },
          })
          return { kind: 'background' as const, jobId: id }
```

控制工具里最有意思的是 `send_message` 的纪律：它只能发给深度为 1 的直接子代理（工具描述原话 "You may use `send_message` only for depth-1 entries"），更深的条目只能用 `interrupt_agent` 打断；列表快照"不是投递承诺"——`send_message` 会做权威检查，仍可能失败。这些词句直接来自工具描述，模型看到的就是这套纪律。`report` 通道则由孩子自己发起：管理器从孩子持久的 `parentSession` 推导唯一收件人，孩子是授权凭证，调用方不能指定收件人；`report` 不结束孩子的 turn，孩子的"安静投递"用 `Agent.inject()`、不产生父 turn，"唤醒投递"用 `Agent.followup()`、产生一个普通父 turn。

### 2.4 隔离：每个孩子一个新 scope

最后是隔离。文档原话：每个孩子获得"一个新的扁平 scope，而不是继承父的注册"（Each child gets a new flat scope rather than inheriting parent registrations，`docs/subsystems/subagent.md` In-process backends 节）。父 agent 的注册、服务、权限不会自动流到孩子身上——这和 M07 的 scope 机制一致：注册挂在 `agent.ctx` 上才有生命周期。`toolFilter` 更进一步：被过滤的工具从孩子的提示词里消失 **并且** 拒绝执行（一种可见性），未知名字加载时就大声报错。`inheritsParentContext` 只描述"对话是否带父的已完成回合前缀"（fork 带、spawn 与 acp 不带），它不暗示工具、服务或权限的继承——工具描述里那句"子代理不继承工具/服务/作用域/权限"就是从这儿来的。

---

## 三、workflow：worker-thread 里的流水线

### 3.1 一句话定义

**一句话定义：workflow 接缝让一个 Agent 运行"模型写的编排脚本"来启动多个子代理；它像 bash 一样每 context 只允许一个引擎（`ctx.workflowEngine`，没有命名 provider 注册表），引擎由 worker-thread provider 提供——一个 run 一个 worker，脚本的 vm context 在 worker 里。**

三个角色分得很清楚：Service Definition 是 `dsh-workflow`（`ctx.workflowEngine` + 词汇表），Service Provider 是 `dsh-workflow-worker-thread`（`node:worker_threads` 引擎），模型面对的 Consumer 是 `dsh-tool-workflow`。和 subagent 相反，它没有命名 provider 注册表——第二个引擎不是并排跑，而是通过插件配置替换第一个。

单个子代理解决"多一个脑"，工作流解决"很多脑怎么管"。你（模型）写一段 plain JS 脚本，脚本里调用 `agent()` 派子代理、用 `pipeline()` / `parallel()` 编排它们；脚本在 worker 线程里跑，线程防止脚本的同步工作阻塞宿主，还允许强制终止——但它是"包含（containment）"而不是安全边界，引擎源码注释的原话："it is containment rather than a security boundary"（`packages/workflow/workflow-worker-thread/src/index.ts:5`）。

### 3.2 请求与身份：脚本、meta、parent

启动请求长这样：

*来源：`packages/workflow/workflow/src/runtime-types.ts:19-34`（启动请求，原文）*

```ts
export interface WorkflowStartRequest {
  /** The plain-JS script body (top-level await allowed; ends with `return <json-value>`). */
  script: string
  /** The workflow's identity block, as plain JSON data (shape-validated by the engine). */
  meta: WorkflowMeta
  /** Optional input exposed verbatim to the script as the `args` global. */
  args?: unknown
  /** Optional engine-wide child-provider override for this run. */
  subagentProvider?: string
  /** Optional per-run total-child ceiling. */
  maxTotalAgents?: number
  /** The agent on whose behalf the run executes (parent of every child). */
  parent: Agent
  /** Cancels the run when aborted. */
  signal?: AbortSignal
}
```

注意两个"数据不是代码"的分界：`meta` 和 `args` 是纯 JSON 数据，引擎**先校验 meta 再运行任何东西**——绝不通过执行脚本来取 meta；脚本正文不允许 `export const meta`（meta 是参数不是代码，以它开头的脚本会收到专门提示）。`parent` 是必填的：脚本里每个 `agent()` 启动的孩子都归属这个活着的 Agent，cwd、lineage、深度都穿过 subagent 接缝。`WorkflowMeta` 的身份块字段（`name`、`description`、可选 `whenToUse`、`phases`）与 Claude Code 的 dynamic-workflows meta 块词汇一致；`phases` 只是进度词汇——`phase()` 调用按标题匹配给观察者，不隐含任何执行结构。

### 3.3 引擎：抽象接缝与 worker-thread 实现

Service Definition 是抽象类：

*来源：`packages/workflow/workflow/src/index.ts:157-168`（Service Definition 抽象接缝，节选）*

```ts
export abstract class WorkflowEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workflowEngine')
  }

  /**
   * Parse and execute a workflow script.
   * @param request - the script, its `args`, the parent agent, and an
   *   optional cancel signal.
   * @returns the live run; its `result` resolves when the script settles.
   */
  abstract start(request: WorkflowStartRequest): WorkflowRun
```

worker-thread 实现的 `start()` 先做三段同步校验，然后才发布 run：

*来源：`packages/workflow/workflow-worker-thread/src/index.ts:143-147`（worker-thread 引擎 start，节选）*

```ts
  start(request: WorkflowStartRequest): WorkflowRun {
    const meta = validateMeta(request.meta)
    assertBodyParses(request.script, meta.name)
    const subagentProvider = resolveSubagentProvider(this.ctx, this.config.provider, request.subagentProvider)
    const maxTotalAgents = resolveMaxTotalAgents(request.maxTotalAgents, this.config.maxTotalAgents)
```

`validateMeta` 失败抛 `META_INVALID`，脚本解析不过抛 `SCRIPT_PARSE`，provider 名不存在抛 `AGENT_START`——同步抛错，run 都还没发布。引擎配置里还有几个上限值得记：`maxConcurrentAgents`（`0` 自动解析为 `min(16, max(1, cores - 2))`）、`maxTotalAgents`（防跑飞循环的兜底，默认 1000）、`maxItemsPerCall`（单个 `parallel()` / `pipeline()` 调用接受的条数，默认 4096）、`syncTimeoutMs`（脚本初始同步片段的 vm 超时，默认 5000ms）、`disposeGraceMs`（取消后脚本仍不结算时强制结算并终止 worker 的宽限，默认 5000ms，也界定 `dispose()`）。

### 3.4 编排原语：脚本里的 hooks

脚本里能用的编排原语，以工具的 DESCRIPTION 常量为准——它被直接嵌进工具描述，就是模型看到的规格：

*来源：`packages/workflow/tool-workflow/src/index.ts:143-146`（脚本 hooks 规格，DESCRIPTION 常量，节选）*

```text
- `agent(prompt, opts?): Promise<any>` — run one subagent to completion. Without `opts.schema` it resolves to the child's final text; with `opts.schema` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf — no pattern/format/numeric bounds) it resolves to the validated object. Resolves `null` when the child fails (filter with `.filter(Boolean)`). Other opts: `label` (display), `phase` (progress group), and independent `provider`/`model` LLM target overrides (either may be provided alone). Anything else (`effort`/`isolation`/`agentType`) is rejected loudly.
- `pipeline(items, ...stages): Promise<any[]>` — run each item through the stages independently with NO barrier between stages (prefer this for multi-stage work). Each stage receives `(prev, item, index)`. An ordinary stage throw drops that ITEM to `null` and skips its remaining stages.
- `parallel(thunks): Promise<any[]>` — run zero-argument functions concurrently and await ALL of them (a barrier; use only when a stage genuinely needs every prior result together). A throwing thunk resolves to `null`.
- `phase(title)` — start a progress phase; `log(message)` — narrate progress; `args` — the tool call's `args` input, verbatim.
```

错误纪律很讲究：脚本里误用 hooks（参数错、不支持的选项、schema 越界、撞上限、接缝启动失败、取消）抛 `WorkflowError`，`fatal: true`；`parallel()` / `pipeline()` 组合子**重抛** fatal 错误而不是把该项映射成 `null`——一个拼错的选项必须大声杀死脚本，绝不能溶解成"看起来像普通子代理失败"的东西。逐项 `null` 只保留给子代理 run 失败（非 `completed` 的 stop reason）和普通的阶段内脚本错误。这和 M07 工具结果 `isError` 的哲学一脉相承：失败要可诊断，不能悄悄吞掉。

### 3.5 结果与事件

`WorkflowRun.result` 永不 reject，resolve 成 `WorkflowResult`：`value`（脚本的返回值，plain host-realm JSON，`null` 表示没返回）、`stopReason`（**封闭**联合：`completed` | `cancelled` | `error`，引擎所有、Consumer 可以穷举）、`error?`、`agentsStarted`（整个生命周期接受过多少次 `agent()` 调用）。非 `completed` 由 Consumer 映射成 `isError` 工具结果。`workflow/*` 六个事件（start、phase、log、agent-start、agent-end、end）全是 observe-only 的数据快照：每个 payload 以 `WorkflowRunInfo`（id + meta）开头，**绝不含活的 `WorkflowRun`**——订阅者拿不到 `cancel` / `dispose`；`workflow/end` 还故意省略结果值，防止监听器拿到调用方结果的 mutable 别名。每个 listener 拿到自己的 payload 克隆，抛出只记日志、不传播、不饿死后面的监听器。

`WorkflowRun` 句柄的纪律和 subagent 一样严格：Consumer 可以中途 `cancel(reason?)`，并且每条路径都必须 `dispose()`；`result` 不 reject，一旦取消，run 会在引擎有界的宽限内结算——即使脚本本身永不结算（引擎强制结算为 `cancelled`，worker-thread 引擎随后终止脚本的 worker），所以等待 `result` 的 Consumer 永远不会被卡死。`dispose()` = cancel + 有界结算 + 子代理 quiescence，绝不挂死在卡住的脚本上。另外 `dsh-tool-workflow` 消费者会把显示事实投影进调用父会话：run 被接受后写 `tool-workflow/run-start`，成员 start/end 按 `runId + seq` 配对，结果已知且 disposal 达到 quiescence 后才写 `tool-workflow/run-end`——第一次追加失败就禁用后续写入，日志保持为空或合法连续前缀。

---

## 四、背景工作：ctx.jobs

### 4.1 一句话定义

**一句话定义：`ctx.jobs` 是抽象的背景任务注册表（一个 context 一个实现，装第二个会抛错——Cordis 标准的重复服务行为）；长时运行的生产者把工作包成"job"，`job_*` 工具负责收集或停止它们。**

jobs 文档第一句话就给定了范围："Types shared by long-running producers, `ctx.jobs`, and job controls"——由长时运行的生产者、`ctx.jobs` 与 job 控制共享的类型（来源：`docs/subsystems/jobs.md:5`）。M01 的扩展点表里我们已经见过它：

*来源：`docs/architecture.md:116`（Where new behavior goes，原行）*

```
| Add background work | register on `ctx.jobs`; `job_*` tools collect or stop it |
```

job 的种类是合并可扩展的映射（又是 map + derived union），registry 把每个值当不透明的 id 命名空间：

*来源：`docs/subsystems/jobs.md:11-20`（JobKindMap，原文）*

```ts
/**
 * Producer-defined job kinds. Plugins extend this map by declaration merging;
 * the registry treats every value as an opaque id namespace.
 */
interface JobKindMap {
  bash: 'bash'
  subagent: 'subagent'
}
```

注意 `subagent` 已经在表里——一次性后台子代理就是一个 `kind: 'subagent'` 的 job（第二节的代码就是这么包的）。`JobId` 是 `<kind>-N` 格式的 branded id，访问控制靠 owner 授权而不是 id 保密；`JobStatus` 是 `'running' | 'stopping' | 'completed' | 'killed' | 'failed'`。`JobHooks.done` 在生产者**释放资源后**才 resolve——"工作结束"不等于"资源释放"，这是 jobs 的纪律。

生产者契约 `JobStart` 的字段也值得扫一眼：`kind` 同时是 id 前缀；`owner` 是拥有它的活 Agent——访问按它的 session id 围栏，agent 销毁会取消并等待这个 job；省略 owner 会创建无人拥有的 job，任何调用者直到服务销毁前都可访问。`JobHooks` 里除了 `cancel` 和 `done` 还有可选的 `readOutput`：它的存在区分"消费型流式 job"和"只有最终输出的 job"，每个 job 一个消费游标；可选的 `outputLimitBytes` 给每次完整的模型可见完成通知或输出读取设 UTF-8 字节上限。runtime 拥有身份、访问与生命周期状态，生产者拥有执行资源——职责分界很清楚。

### 4.2 一张图串起来

把这一章的所有部件串成一张图：

```text
主 Agent（你）
   │ 调用 subagent / workflow / job_* 工具
   ▼
 tool-subagent ─────► ctx.subagents.start() ──────► 子代理运行
 tool-workflow ─────► ctx.workflowEngine.start() ─► worker 线程编排 N 个子代理
 job_*（job_output 等）─► ctx.jobs ───────────────► 后台任务运行
   │
   ▼
 结果回收：SubagentRun.result / WorkflowRun.result / job_output
```

分工是这样的：子代理是"分身"，工作流是"流水线"（在 worker 线程里编排多个子代理，每个 `agent()` 调用都桥接到宿主的 subagent 接缝），jobs 是"后台工位"（让一次性后台子代理、bash 这类长时工作可以异步跑、随时收）。

---

## 五、真实世界的用法：本书的写作流程

说个就近的例子：你正在读的这本笔记，每章草稿就是子代理并行起草的——一个章节一个子代理，带着必读文件清单与风格要求开工，主 Agent 只派发与校对；规模更大、需要分阶段汇总的活（比如一次审计几十个文件）才动用工作流。原理正是本章读过的：接口选 provider，脚本管编排，jobs 管后台。

---

## 六、本章小结与下一章预告

把这一章收束成几条笔记：

- **一个接口，多个分身**。`ctx.subagents` 是命名 provider 注册表，spawn / fork / acp / codex / claude-code 并存；服务在 start 前做能力校验，"要了没有的能力"抛 `UNSUPPORTED_CAPABILITY`，绝不接受后忽略；`prepareContinuable` 方法存在即能力，continuable 子代理由 continuation manager 全权管理。
- **委托与回收**。`tool-subagent` 是模型看到的入口：前台等 `SubagentRun.result`，一次性后台包成 `kind: 'subagent'` 的 job，continuable 返回持久 `subagentId` 走 `send_message` / `list_agents` / `interrupt_agent`；非 `completed` 的 stop reason 映射成 `isError`，孩子的部分输出仍会带回。每个孩子拿到新扁平 scope，不继承父注册。
- **工作流是流水线**。`ctx.workflowEngine` 是抽象接缝，worker-thread provider 一个 run 一个 worker；脚本是纯 JS、meta 是数据；`agent()` / `pipeline()` / `parallel()` 编排子代理，fatal 错误必须大声杀死脚本；`workflow/*` 事件只带数据快照，不给控制权。
- **jobs 是后台工位**。`ctx.jobs` 一个 context 一个实现，`job_*` 工具收集或停止；job 的 `done` 在资源释放后才结算。

下一章是这本书的最后一章（M12）：**持久化、压缩与遥测——会话如何存活**。你会看到 append-only 会话日志怎么变成可恢复的磁盘状态（persistence）、上下文太长时怎么压缩（compaction）、以及标题生成与遥测怎么从同一条日志流里派生出来。还记得 M05 那句"模型可见即日志"吗？M12 就是它的最终归宿——日志不只是记录，它就是会话的整个生命。
