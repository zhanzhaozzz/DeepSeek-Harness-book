---
order: 9
title: "第9章：能力接缝 —— Service Definition / Provider / Consumer"
summary: "一个可替换能力的三角色模型：文件系统、Shell、子进程、沙箱如何一次换装。"
status: published
words: 5915
codeLines: 114
minutes: 30
updated: "2026-08-14"
---

# 第9章：能力接缝 —— Service Definition / Provider / Consumer

第 8 章我们跟着 capability 事件走到了"缝"边上：`fs/write-intent` 把一次写入的决定权交给策略监听器，可策略挂在哪里、谁在执行、模型怎么调起——这些还没正面回答。现在该正面回答接缝本身了。**接缝（capability seam）是 dsh 里"可替换能力"的正式名字，而它存在的理由不是抽象洁癖，是实打实的杠杆：换一个 provider，整个产品跟着换。** 你换掉 `ctx.fs` 的实现，read/write/edit 三个工具不用动一行，观察策略照常工作；你换掉 `ctx.shell` 的实现，bash 工具、PTY 终端、LSP 一起换。回顾一下你已经见过的影子：M01 种下过"接缝三件套"的概念，M02 学过服务怎么注册进 ctx，M06 的 `ctx.llm` 是第一个完整的接缝实例，M08 又学会了用事件把策略挂到接缝上。这一章把三件套拼成完整地图：Service Definition 怎么声明、Provider 怎么实现与注册、Consumer 怎么消费，以及一次换装为什么能带动整个产品。

---

## 一、三角色模型

### 1.1 一句话定义，以及"只有一种角色不算接缝"

一句话定义：**能力接缝是一个可替换能力，由三个角色组成——Service Definition 声明接口，Service Provider 实现接口，Consumer 使用能力（Consumer 通常是面向模型的工具）。**

这一定义不是笔者的归纳，是 `docs/architecture.md` 第 100 行的原文：A **seam** is a swappable capability with three roles: a **Service Definition** declaring the interface, a **Service Provider** implementing it, and a **Consumer** using it, commonly a model-facing tool. A package may combine roles, but one role alone is not a seam; adding a capability means designing all three。仓库根 AGENTS.md 的约定也强调了完整性：**A capability seam comprises Service Definition / Service Provider / Consumer roles. It is complete, never one role; split only when roles evolve independently.**

"只有一种角色不算接缝"要这么读：只声明接口的包是个没人用的空契约，只实现服务的类没人调用就是死代码，只有工具的包底下没有能力可调。一个角色不构成可替换性——替换必须发生在"有人声明、有人实现、有人使用"三条边都成立的地方。三件套是完整的最小单位，只有当三个角色各自独立演化时，才把它们拆成不同包。

### 1.2 能力图：一张图加一张表

`docs/capability-seams.md` 是全仓库能力的索引：一张 mermaid 图加一张表。图里每个服务是一个节点，比如 `svc_fs["ctx.fs<br/>Filesystem provider seam"]`；三种边把角色连起来——拥有者包指向服务（`pkg_fs --> svc_fs`）、实现包指向服务（`pkg_fs_local --> svc_fs`）、服务指向消费它的包（`svc_fs --> pkg_tool_fs`）。表的列是 ctx key / Role / Owner / Implementations / Direct consumers / Companion plugins / Note，其中 Role 列把服务分成三类：`seam`（可换装能力缝）、`core`（核心脊柱服务）、`bundle`（组合点）。文件开头一句话定义了分类：A service can be a core spine service, a swappable capability seam, or a bundle/composition point。文件末尾还交代了这张图的性质：服务从 Cordis 声明里发现，三角色由 `scripts/gen-doc-graphs.ts` 分类，带完整性守卫——它是生成物，不是手绘的示意图。

挑三行 `seam` 记录看结构（原表节选，列已精简，语义不变）：

| ctx key | Role | Owner | Implementations | Direct consumers | Companion plugins |
| --- | --- | --- | --- | --- | --- |
| `ctx.fs` | `seam` | `fs` | `fs-local`、`fs-sandbox`、`fs-e2b` | `tool-fs` | `fs-observation-policy` |
| `ctx.shell` | `seam` | `shell` | `bash-local`、`bash-sandbox`、`pwsh-local` | `tool-bash`、`tool-pwsh`、hooks 桥 | - |
| `ctx.web` | `seam` | `web` | `web-search-exa`、`web-search-perplexity`、`web-search-deepseek`、`web-fetch-http` | `tool-web` | - |

读法：一行就是一条缝。Owner 是声明接口的包，Implementations 是换装候选，Direct consumers 是依赖抽象的使用方，Companion plugins 是挂在事件上的策略——注意 `ctx.fs` 的 companion 正是第 8 章学的 `fs-observation-policy`。以后你读任何接缝代码，先在这张表里定位它属于哪一行、三个角色各是谁，再动手。

---

## 二、文件系统接缝

### 2.1 四个包，一种分工

`docs/subsystems/filesystem.md` 开头就把文件系统能力拆成四块，原话：The optional filesystem capability has four parts: dsh-fs owns `ctx.fs` and atomic text operations with optional guards, dsh-fs-local implements local disk, dsh-fs-observation-policy records observed presence or absence and adds freshness rules through events rather than a service, and dsh-tool-fs directly executes model-facing read/write/edit calls and renders windows. It is outside the agent-loop spine; alternate backends do not change policy or tool schemas。

三角色正好落在这四块上：dsh-fs 是 Service Definition（`ctx.fs` + 类型 + 三个 `fs/*` 事件），dsh-fs-local、dsh-fs-sandbox、dsh-fs-e2b 是 Provider，dsh-tool-fs 是 Consumer；dsh-fs-observation-policy 是第四个角色——它不是服务，而是通过 `fs/*` 事件把策略挂到缝上的插件。最后那句"不在 agent-loop 脊柱上、换后端不改变策略或工具 schema"是整条缝的验收标准：策略、工具、后端三者可以独立替换而不互相牵动。

还要注意"无策略形态"本身是合法的：filesystem.md 明确说，没有 policy 插件时，`FileSystem` Service Definition + 一个 provider + `dsh-tool-fs` Consumer 就构成一条完整、无约束的文件系统缝——`write` 无条件创建或覆盖，`edit` 无条件替换字面文本。策略是默认期望的附加件，不是缝的定义的一部分。

### 2.2 声明合并与抽象服务类

Service Definition 的代码由两半组成：一半是 `declare module` 声明合并（把 `ctx.fs` 和 `fs/*` 事件塞进 Cordis 的 Context 与 Events 接口），一半是抽象服务类 `FileSystem extends Service`。先看声明合并：

*来源：`packages/fs/fs/src/index.ts`（第 44–58 行），逐字摘录。*

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    fs: FileSystem
  }

  interface Events {
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

注意 `Context.fs: FileSystem` 只是类型声明，不是实例——真正让 `ctx.fs` 可用的，是某个 Provider 类在构造时调用 `super(ctx, 'fs')` 把实例注册进 Cordis 的服务存储。`interface Events` 里则是三个 capability 事件，第 8 章你已经认识 `fs/write-intent`：single-slot 决策瀑布，`next()` 给的是裸 provider 的无条件写入。再看抽象服务类的骨架：

*来源：`packages/fs/fs/src/index.ts`（第 86–105 行），逐字摘录。*

```ts
export abstract class FileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /**
   * The sandbox mode this backend enforces on mutations BY DEFAULT, or
   * `undefined` when it does not confine at all — the capability fact the tool
   * layer reads to advertise the escalation fields honestly (mirrors
   * `ShellExecutor.sandboxMode`). The base class and the bare local backend
   * report `undefined`; a sandboxing backend (`@deepseek-ai/dsh-fs-sandbox`)
   * overrides it with the deployment default. A session override may make the
   * effective mode narrower or wider, so strict escalation widening is checked
   * per call rather than encoded in this default-relative fact.
   * @returns the configured default mode of a sandboxing backend; `undefined`
   *   for a backend that never confines.
   */
  get sandboxMode(): SandboxMode | undefined {
    return undefined
  }
```

两个细节值得停下来。第一，`extends Service` + `super(ctx, 'fs')`：dsh 的服务类是 Cordis `Service` 的子类，构造即注册，key 是 `'fs'`；能力图里"实现包 → 服务"的边，在代码层面就是这个 super 调用。第二，`sandboxMode` 是一个能力事实（capability fact）：基类返回 `undefined` 表示"本后端不限制"，沙箱后端覆盖它返回部署默认值——工具层读它来决定要不要给模型展示 `sandbox_permissions` 升权字段。骨架之下是十几个抽象方法：resolve / processPath / fileUrl / contains / stat / lstat / readText / streamText / readBytes / listDir / writeText / editText。Provider 必须全部实现，Consumer 只认识这些签名。

### 2.3 fs/* 事件把策略挂上去（呼应 M08）

这里补上第 8 章没讲完的一半：策略为什么不注册服务？filesystem.md 的原话：`dsh-fs-observation-policy` registers **no service** — it is a plugin that adds policy through the `fs/*` event gate。它不实现 `FileSystem`，只监听 `fs/write-intent`、`fs/edit-intent` 两个瀑布并派发 `fs/observed` 记录观察。因此"移除它不破坏工具"——还是原话：Removing it does not break the tool because the tool calls `ctx.fs` and dispatches events; it does not call policy methods。这就是能力事件的设计价值：策略是缝上的插件，不是缝的一部分；工具与 provider 都不用知道策略存在。

事件词汇也守住了边界：`fs/*` 事件只携带 dsh-fs 的词汇加一个不透明 `object` actor（工具执行上下文），没有模型概念、没有 agent/session 属主结构。策略插件从 actor 里推导观察状态的属主（通常是 `exec.agent.session`，作为 WeakMap 键），全程不 import 工具、agent 或 session 包。三个事件三种语义：两个意图瀑布是 single-slot 决策——第一个返回意图的监听器拥有决策；`fs/observed` 是 fire-and-forget 的记录事件，监听器必须同步、只做副作用，因为工具不守卫这次 emit。

### 2.4 provider 换装

Provider 换装就是换一个继承 `FileSystem` 的类：dsh-fs-local 实现本地磁盘（realpath 派生目标身份、按 targetKey 串行化读写窗口、原子发布），dsh-fs-sandbox 按共享沙箱模式围栏写操作——`FS_SANDBOX_DENIED` 正是它拒绝时的错误码，与内核拒绝的 `FS_PERMISSION_DENIED` 区分开；dsh-fs-e2b 把文件系统实现放进远程沙箱。换装之后，模型工具、策略、甚至子进程看到的路径都不变：跨能力消费方通过 `processPath(target)` 拿到子进程能打开的规范绝对路径、`fileUrl(target)` 拿到 `file:` URI、`contains(parent, child)` 测试包含关系——这些坐标由 provider 提供，消费方绝不解析 `targetKey`（那是不透明品牌 id）。三处实现共享同一套工具 schema 与事件词汇，正是"换后端不改变策略或工具 schema"。

目标身份是整条缝的隐含契约：`resolve()` 把用户路径变成稳定的 `FsTarget`，同一文件恒得同一 `targetKey`（本地后端是 realpath 结果，远程后端可能是 workspace URI 或文件 id）；`FsVersion` 是后端拥有的版本令牌，write/edit 的 freshness 守卫拿它做 stale 检查。两个 id 都是品牌化的不透明字符串，消费方只显示 `displayPath`，绝不解析另外两个——这样本地与远程两种实现才能在同一套消费方代码下共存。

---

## 三、shell 与 subprocess：一个执行世界

### 3.1 两条缝，一种派生关系

shell 缝的结构与 fs 缝完全同构：Service Definition 是 dsh-shell（`ctx.shell`），Provider 是 dsh-bash-local 与 dsh-bash-sandbox（另有 pwsh-local），Consumer 是 dsh-tool-bash（bash 工具的 schema）。subprocess 缝也一样：dsh-subprocess 声明 `ctx.subprocess`，dsh-subprocess-local 实现本地进程树，dsh-subprocess-e2b 实现远程进程树。不同的是消费方向：subprocess 的消费方是"其他能力缝"——subprocess.md 原话：its Consumers are other capability seams and out-of-process backends: the bash executor family uses collected batch output, LSP uses raw protocol pipes, the PTY backend uses the terminal primitive, and the ACP subagent backend uses piped ndjson plus inherited stderr。

### 3.2 本地 provider 通过 ctx.subprocess 派生

bash 的执行能力不是自己 fork 进程，而是把 spawn 委托给子进程缝。architecture.md 的"新行为放哪"表里有一行原话：Add shell execution → register a `ctx.shell` backend; the local one spawns through `ctx.subprocess`。看 `LocalBashExecutor` 的真实代码——先看类声明与依赖注入：

*来源：`packages/shell/bash-local/src/index.ts`（第 102–103 行），逐字摘录。*

```ts
export class LocalBashExecutor extends ShellExecutor {
  static inject = ['subprocess']
```

`static inject = ['subprocess']` 是 Cordis 的依赖注入声明：加载 bash-local 之前，`ctx.subprocess` 必须已注册。再看前台执行路径——模型输入 `ls -la`，工具层把命令交给 executor：

*来源：`packages/shell/bash-local/src/index.ts`（第 211–226 行），逐字摘录。*

```ts
  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return this.runArgv(spec, ['bash', '-c', spec.command])
  }

  /**
   * Run an explicit argv with the foreground lifecycle, environment, output,
   * timeout, and cancellation semantics of this executor. Subclasses use this
   * after replacing the public command's shell argv at an execution boundary.
   * @param spec - resolved execution settings and caller-owned command metadata.
   * @param argv - exact executable and arguments to hand to `ctx.subprocess`.
   * @returns the settled foreground result with collected output and cause facts.
   */
  protected async runArgv(spec: ShellExecSpec, argv: readonly string[]): Promise<ShellRunResult> {
    // One deadline combines timeout and upstream cancellation; disposal clears its timer.
    using d = deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, argv, spec.stdoutMaxBytes, d.signal))
```

`run()` 把命令包成 `['bash', '-c', command]` 交给 runArgv，runArgv 里一行 `this.ctx.subprocess.spawn(...)` 完成派生。bash 执行器不碰 Node 的 child_process：进程组的 SIGTERM→SIGKILL 升级、stdout 有界收集、溢出 spill 文件，全是子进程缝的机制——bash-local 的模块注释原话：Bounded output, spill files, and process-group SIGTERM→SIGKILL escalation are the subprocess service's mechanics; this executor supplies their configured budgets per spawn。

两缝之间还夹着一道显式边界：`resolve()` 拆分。工具层交给 executor 的是 `ShellExecRequest`——`workdir`、`timeoutMs` 等字段都是可选的；executor 的 `resolve()` 把它们填成 `ShellExecSpec` 再执行，所有值必需。这就是仓库那条"包边界显式优于隐式"规则的模板：默认值发生在 owning 实现的显式 resolve 步骤里，绝不藏在 `run()` 内部的 `?? default` 里。subprocess 缝更彻底：`SubprocessSpawnSpec` 全字段显式，`argv` 从不被 shell 解释——这个缝不应用任何默认值，每个 disposition、限制、目录都由调用方的配置决定。

### 3.3 一个执行世界

为什么 bash 要把 spawn 委托出去而不是自己 fork？因为 dsh 想让"文件系统与子进程共享一个执行世界"。subprocess.md 原话：One provider's spawn working directories, executable paths, ordinary processes, and terminal sessions inhabit the same path and process namespace as the mounted filesystem provider。architecture.md 把这句话推到了结论：Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks。

也就是说：本地形态下，fs-local 的路径与 subprocess-local 的进程同属本机命名空间；一旦把两个 provider 一起换成 fs-e2b / subprocess-e2b（指向同一个远程沙箱），bash、PTY、LSP、外部子代理全部自动跟随——因为它们是消费方，只依赖抽象的 `ctx.subprocess`，不依赖本地实现。一张图收束"一个执行世界的两种 provider"：

```text
             一个执行世界：路径、可执行文件、终端会话同属一个命名空间
                    │
      ┌─────────────┴─────────────┐
      ▼                           ▼
   ctx.fs                    ctx.subprocess
   （文件系统缝）              （子进程缝）
      │                           │
      │  fs-local（本地磁盘）        │  subprocess-local（本地进程树）
      │  fs-e2b（远程沙箱）          │  subprocess-e2b（远程沙箱）
      │                           │
      └───────────┬───────────────┘
                  ▼
      派生于 ctx.subprocess 的消费方能力缝：
      bash-local ───────→ ctx.shell（bash -c 前台/后台执行）
      terminal-bash ─────→ ctx.terminals（PTY 持久终端）
      lsp-stdio ─────────→ ctx.lsp（语言服务器协议管道）
      subagent-acp/codex/claude-code（外部子代理，经 ctx.subprocess spawn）
                  │
      把 fs 与 subprocess 两个 provider 一起指向远程沙箱
                  ▼
          Bash、PTY、LSP 跟随移动 —— 不需要任何 provider 分叉
```

*示意图（笔者绘制，参照 architecture.md 的 Capability seams 一节与 capability-seams.md 的 `ctx.subprocess` 行）。*

---

## 四、沙箱：把"换装"推到边界

### 4.1 包 argv，不包消费方

sandbox.md 开头一句话定义了沙箱缝：The process-sandbox seam of dsh-sandbox wraps a same-world subprocess argv in a file-effect policy without coupling consumers to a platform runner。它不做的事和做的事一样重要：它不自己 spawn，而是把"你正要 spawn 的 argv"包一层再还给你，由你照常 spawn。这正是 architecture.md 那张表里的一行：Confine spawned processes → use a `ctx.sandbox` backend; consumers wrap argv before spawning。

接口的核心动词是 `confine(argv, policy)`：返回 `ConfinedArgv`——替换后的 argv 加执行完整性、加两个 stderr 分类方言（denialSignatures 识别"沙箱正常工作、命令被拦"，runnerFailureRules 识别"runner 在命令运行前就失败了"）；没有可用后端时抛 `SANDBOX_UNAVAILABLE`，静默放行永远不合法。模式三档只约束文件效应：`read-only`、`workspace-write`、`danger-full-access`——最后一种消费者直接 spawn 原始 argv，根本不调用 ctx.sandbox（sandbox.md 原话：A `danger-full-access` consumer spawns its original argv and does not call `ctx.sandbox`）。实施方 dsh-sandbox-local 按平台提供三种 runner：Linux bwrap/Landlock、macOS Seatbelt、Windows ACL 受限令牌；dsh-bash-sandbox 与 dsh-pwsh-sandbox 是它的消费方。

执行完整性是上报的事实，不是承诺：`full` 表示后端管辖该模式承诺的每一个文件效应，`partial` 表示活跃后端或旧内核 ABI 只管辖子集——旧版 Landlock ABI 与 Windows ACL runner 的 Everyone/硬链接边界就是当前的 partial 案例。要求绝对边界的调用方必须拒绝或显式区分 partial，不能把"部分执行"当"完整执行"。策略本身是逐调用携带的：`SandboxPolicy` 带模式与工作区根，两个消费者可以在同一瞬间以不同边界问同一个 provider——bash 用 `read-only`，同时一个受限子代理需要可写的状态目录，互不干扰。

### 4.2 本地与远程：两种换装

沙箱缝最值得想的一点，是它把"换装"推到了边界：本地形态下，换装发生在 argv 这一层——bwrap/Seatbelt 在同一个执行世界里包一层文件效应策略；而容器、microVM、远程执行根本不属于 ctx.sandbox。sandbox.md 原话：Containers, microVMs, and remote execution are sibling implementations of whole capability seams, not providers of `ctx.sandbox`。把这句话和第 3 节连起来：本地沙箱是"包 argv"，远程换装是"换执行世界"。前者是 ctx.sandbox 的一个 provider 做的事，后者是整个 fs/subprocess 缝一起换 provider——两条路都从消费方代码里消失，消费方只认识 `confine(argv, policy)` 和 `spawn(confined.argv)`。

---

## 五、web 能力：搜索与抓取

### 5.1 一个缝、两个操作

web 缝在"三角色"上多了一个花样：一个 `ctx.web` 服务横跨两个操作——search 与 fetch。web.md 开头原话：the web access seam — a capability seam that spans **two operations** (search and fetch) on one `ctx.web` service, split across packages: Service Definition (dsh-web, `ctx.web` + the provider registries), Service Providers (dsh-web-search-exa, dsh-web-search-perplexity, dsh-web-search-deepseek, dsh-web-fetch-http), and Consumer (dsh-tool-web, the `web_search`/`web_fetch` tool schemas)。仓库根 AGENTS.md 的包布局里，一行就写完了这个分工，原话：

> web/         web capability: Service Definition + search/fetch providers + tool Consumer

搜索与抓取没有共享请求 schema，却刻意共用一个 ctx.web：一个 provider 选择策略的属主、一套中止/错误词汇、一个"这个 harness 怎么联网"的配置面——并行的方法对（searchX/fetchX）是有意的，不是没抽干净的重复。两个操作对应两组 provider 接口：`WebSearchProvider` 与 `WebFetchProvider`——注意 provider 注册的是能力，不是工具。web.md 原话：Providers register **capabilities** (a `WebSearchProvider` or `WebFetchProvider`), not tools; the model-facing names, schemas, prompt guidance, and presentation all live in the single `dsh-tool-web` consumer。模型看到的 `web_search`/`web_fetch` 工具、参数 schema、提示词引导、结果渲染，全在 dsh-tool-web 一个消费方里。

请求与结果也被压到最小：模型的搜索参数只是一个 `query`，`maxResults` 是消费方拥有的界（dsh-tool-web 的 `searchMaxResults` 配置，默认 8），穿透缝在返回路上强制——provider 多返回了，seam 截断 `sources[]` 并置 `truncated`。结果形状同样规范化：`WebSearchSource` 必有 `url`，`title`、`snippet`、`publishedAt` 可选，因为不是每个 provider 都返回它们——强行让适配器编造会让缝说谎。抓取侧，HTTP 状态是资源状态的一部分：成功抓到 404/500 返回带状态码的结果，`WebError` 只留给"没能安全取回或表示资源"的失败。

### 5.2 provider 换装：注册即换装

换装动作小到只有一行配置：在配置里指定 `searchProvider`/`fetchProvider`（或对应环境变量喂同一个字段），执行时按 id 选择 provider。看 Exa provider 的注册代码——`apply` 是函数插件（不是服务类，因为 provider 不拥有 ctx.web 这个 key，它只是注册进注册表）：它把 `ExaSearchProvider` 实例注册进 `ctx.web` 的搜索注册表：

*来源：`packages/web/web-search-exa/src/index.ts`（第 59–70 行），逐字摘录。*

```ts
/** Register the Exa search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new ExaSearchProvider({
    // Every environment layer may name this key: the product trusts the
    // project it is launched in, and the managed store is not involved here.
    apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get('EXA_API_KEY')?.value ?? '',
    baseURL: config.baseURL ?? EXA_DEFAULT_BASE_URL,
    searchType: config.searchType ?? EXA_DEFAULT_SEARCH_TYPE,
    highlightsPerResult: config.highlightsPerResult ?? EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
    ...config.numResults !== undefined ? { numResults: config.numResults } : {},
  }))
}
```

`ctx.web.registerSearchProvider(...)` 返回 disposer，随插件 fiber 卸载——注册是效果，卸载即回收。换装语义在 `provider.ts` 里补全：`readonly id = EXA_PROVIDER_ID` 是注册表键；`available()` 是廉价本地检查（apiKey 在不在、baseURL 解析不解析），**不许发网络请求**；`search()` 把 Exa 的响应映射成 seam 的规范化 `WebSearchSource[]`，`content` 省略——因为 Exa 不返回生成式回答，适配器不会编造一个出来。换 perplexity 或 deepseek 就是换一个实现同样接口的类，web.md 的验收原话：A search-provider swap does not change how the model asks for a query, and a fetch-provider swap does not change how the model asks for a URL。选择规则不依赖注册、配置、HMR 顺序：配置了 id 就按 id；只有一个可用 provider 就自动选；多个可用却没有配置 → `WEB_PROVIDER_AMBIGUOUS`，而不是先注册先赢。

---

## 六、接缝如何被消费：一个完整例子

### 6.1 从工具 Consumer 走一遍

前五节把三条缝的声明与实现都看过了，现在从 Consumer 的视角把一次调用完整串一遍——选文件系统缝，因为它的三件套最齐全（Service Definition + 三个 provider + 工具 + 事件策略）。模型要写一个文件，调用 `write` 工具。这个工具由 dsh-tool-fs 注册：`ctx.tools.register(defineTool({ name: 'write', ... }))`，schema 是模型看到的形状；执行发生在 `execute` 里。摘录完整执行体：

*来源：`packages/fs/tool-fs/src/write.ts`（第 102–129 行），逐字摘录。*

```ts
    async execute(args: WriteToolArgs, exec) {
      const input = parseWriteArgs(args)
      // Resolve the per-call sandbox policy (approved mode > session override
      // > backend default, plus the session cwd root) BEFORE anything executes;
      // an escalating call throws its distinct text on any non-grant.
      const sandboxPolicy = await sandbox.resolvePolicy('write', args, exec)
      const target = await ctx.fs.resolve(input.filePath, sessionResolveOptions(exec, input.filePath, sandboxPolicy?.workspaceRoot))
      // Single-slot decision: the policy plugin produces createIfAbsent/
      // replaceIfVersion; the bare default is undefined (unconditional). No stat.
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      let outcome: FsWriteOutcome
      try {
        outcome = await ctx.fs.writeText(target, input.content, intent, exec.signal, sandboxPolicy)
      } catch (error: unknown) {
        // A sandbox denial becomes the shared [sandbox: …] marker (the model
        // recognizes it from bash); stale/not-observed failures gain their
        // model-facing remedy; anything else passes through.
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy))
      }
      // Record the present observation (a no-op when no policy plugin listens).
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return {
        path: target.displayPath,
        operation: outcome.operation,
        before: outcome.before,
        after: outcome.after,
      }
    },
```

顺着 execute 数一遍它触碰的接缝零件：

1. `sandbox.resolvePolicy('write', args, exec)` —— 沙箱策略缝：解析本次调用的模式与工作区根（升权模式 > 会话覆盖 > 部署默认）。工具层不自己实现策略优先级，那是 `ctx.sandboxPolicy` 的职责。
2. `ctx.fs.resolve(input.filePath, ...)` —— 文件系统缝的入口：路径变成不透明 `FsTarget`，provider 由此接管目标身份。同一文件恒得同一 `targetKey`，别名路径共享同一守卫——这是 write/edit 的 stale 检查能跨别名工作的前提。
3. `ctx.waterfall('fs/write-intent', target, exec, () => undefined)` —— 第 2 章学过的瀑布语义：策略插件返回 createIfAbsent / replaceIfVersion 守卫；没人监听就得到 `undefined`（无条件写入）。
4. `ctx.fs.writeText(target, input.content, intent, exec.signal, sandboxPolicy)` —— 真正执行原子写入的 provider 调用；`intent` 是第 3 步瀑布决策的产物，第 4 步的守卫检查。
5. `ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)` —— 记录观察结果，供下次 write/edit 做 freshness 守卫。

### 6.2 四段代码，各自只认识自己的角色

把这一章出现过的代码放一起，接缝的纪律就显形了：Provider（LocalFileSystem、LocalBashExecutor、ExaSearchProvider）只实现各自抽象类/接口的方法，不知道工具存在；策略插件（fs-observation-policy）只监听 `fs/*` 事件、只记录 `FsObservation`，不 import 工具也不 import provider；工具（tool-fs）只调用 `ctx.fs` 抽象与派发事件词汇，不 import 任何 provider；连 Service Definition 包，消费方都只需要 `import type {} from '@deepseek-ai/dsh-fs'` 让声明合并生效。没有任何一段代码知道另外三段的包名。换掉 provider、加/删策略插件，工具代码一行不动——这就是"换一个 provider 改变整个产品"在代码层面的全部秘密：接缝让依赖方向从"谁实现谁"变成"谁声明谁"，产品行为由组合决定，不由包决定。

---

## 七、本章小结

一句话收束：**能力接缝是 dsh 组织可替换能力的完整单位——Service Definition 声明接口、Provider 实现、Consumer（通常是面向模型的工具）使用，三件套缺一不可。** 文件系统缝用四个包演示了最齐全的分工：声明、实现、工具、事件策略各归其位，换后端不动策略与工具 schema。shell 与 subprocess 缝揭示了"一个执行世界"：bash、PTY、LSP、外部子代理都是 ctx.subprocess 的消费方，把 fs 与 subprocess 一起指向远程沙箱，它们全体跟随。沙箱缝把换装推到边界：本地是包 argv，远程是换执行世界，容器/microVM 不是 ctx.sandbox 的 provider。web 缝证明三角色可以横跨两个操作：搜索与抓取共用一个 ctx.web，provider 换装不改模型的问法。最后从 write 工具的 execute 走了一遍消费路径，四段代码各自只认识自己的角色。想看某条缝的完整三件套，打开 `docs/capability-seams.md` 的能力图，一行一个缝。

下一章换个视角：接缝决定了"能力有哪些"，但模型怎么知道这些能力？第 10 章进入提示词与上下文工程：`ctx.systemPrompt` 收集 prompt 分节与面向模型的工具 schema——你在第 7 章注册的工具，schema 正是经过这条路径进入模型视野的（能力图里 `svc_systemPrompt` 就指向 tool-fs、tool-terminal、tool-web）。**工具 schema 就是通过接缝进入模型视野的：能力在缝上声明，schema 由 system-prompt 组装，注入到下一次模型请求。**
