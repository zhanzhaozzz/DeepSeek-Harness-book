---
order: 1
title: "第1章：开篇 —— 为什么 DeepSeek Harness 值得你花时间"
summary: "DeepSeek Harness 是什么、为什么学它。本章打开仓库全貌，建立后续章节的知识地图。"
status: published
words: 5494
codeLines: 64
minutes: 27
updated: "2026-08-14"
---

# 第1章：开篇 —— 为什么 DeepSeek Harness 值得你花时间

如果你正在开发自己的 AI Agent，却总觉得模型调用、工具执行、会话管理这些轮子都得亲手造；如果你想学习生产级 agent harness 的真实设计，而不是看一堆玩具 demo；如果你想搞懂"一切皆插件"是怎么在一套真实代码库里落地的——这一章就是为你写的。答案是同一个：**DeepSeek Harness（`dsh`）是 DeepSeek 开源的 agent harness，插件化是它设计的起点，不是事后补上的扩展机制。** 这本书是我精读这套源码的笔记，会从框架内核一路拆到每个能力接缝。本章先回答三个问题：它是什么、怎么跑起来、以及你该用哪种视角读它。

---

## 一、DeepSeek Harness 是什么：一张图看懂

### 1.1 一句话定义

**一句话定义：DeepSeek Harness 是 DeepSeek AI 开发的开源 agent harness（智能体框架），采用"一切皆插件"的架构，由 Cordis 驱动，Cordis 的设计描述在论文 _A Programming Paradigm for Spatiotemporal Composability_ 里。**

这套架构意味着什么，架构文档说得很直白：产品的每个部分都是插件——包括模型适配器、工具注册表、会话日志，甚至 agent 主循环本身，因此每个部分都可以从配置替换。没有需要打补丁的特权核心：你要扩展 dsh，就把它旁边挂上一个插件；注册是"效果"（effect），插件卸载时这些注册会自动回滚。Cordis 在这里扮演"底座框架"：插件向共享的 context 贡献服务、类型化事件与可逆效果，dsh 的一切能力都长在这棵树上。这也是全书反复出现的三个关键词——服务（Service）、事件（Event）、效果（Effect），请先记住它们。

### 1.2 关键数字

动手之前，先给你一张"数字卡片"。以下数字全部出自仓库的 README、packages/README.md、AGENTS.md 与 LICENSE，没有替你编造任何数字：

| 事实 | 数值 | 出处 |
|---|---|---|
| 一句话定位 | 开源 agent harness；一切皆插件；由 Cordis 驱动 | `README.zh.md` |
| packages/ 分组数 | 47 个（Hierarchy 分组表，从 core 到 util） | `packages/README.md` |
| npm scope | `@deepseek-ai/dsh-*` | `packages/README.md` |
| Web UI 默认地址 | `http://127.0.0.1:3080` | `README.zh.md` |
| Node.js 版本要求 | `^22.19 \|\| >=24` | `AGENTS.md`（Commands 节） |
| 许可证 | MIT（Copyright (c) 2026 DeepSeek） | `LICENSE` |
| 当前阶段 | developer preview，将出现破坏兼容性的变更 | `README.zh.md` |

关于"分组"要说明一句：`packages/README.md` 的 Hierarchy 节规定分组持有 `packages/<group>/<pkg>/`，包名统一是 `@deepseek-ai/dsh-<pkg>`；每个分组在表里还标注了角色与发布预期——绝大多数是 "Product — stable API"，`e2b` 是 POC，`examples` 是示例基础设施，`util` 是零依赖工具。47 个分组意味着什么？它说明这不是一个"一个包塞下所有功能"的 monolith，而是一个刻意拆碎的生态系统：核心只有 session、system-prompt、tools、agent、agent-loop 五个包，其余全是可替换的能力与支撑。拆得越碎，接缝越多；但每个接缝都有明确文档，这正是我们后面各章要走的路线图。

再补一个容易被忽略的体量信号：它的文档不是几篇 README 了事，而是分层的——docs/ 下有架构总览、Cordis primer 与教程、每个子系统的参考页（subsystems/）、cookbook 操作指南、事故复盘（postmortems），还有由源码自动生成的 tool-catalog、config-catalog、persistence-catalog、module-graph 等目录，并配有专门的文档规范与字数预算门禁。对学习者来说，这本身就是"生产级开源项目怎么管文档"的活标本。

### 1.3 仓库地图

先看仓库根目录的布局，下面是 AGENTS.md "Repository layout" 一节的原文：

*来源：`AGENTS.md`（Repository layout 节）*

```text
vendor/      Vendored Cordis source — manifest + sync procedure in vendor/README.md
packages/    @deepseek-ai/dsh-<pkg> workspaces at packages/<group>/<pkg>/
  core/        product API spine: session, system-prompt, tools, agent, agent-loop
  api/         Remote BFF assembly and Typert RPC gateway
  typert/      type graph generator, loader, and runtime registry
  llm/         LLM capability: Service Definition/Consumer + DeepSeek providers
  e2b/         E2B POC: sandbox + FS/subprocess adapters
  shell/        bash capability: Service Definition + local/pwsh providers + shell Consumers
  subprocess/  subprocess capability + local process-tree provider
  terminal/         persistent sessions
  fs/          filesystem capability + policy
  lsp/         language-server capability
  skill/       skill provider registry + local impl + catalog/loader tool
  web/         web capability: Service Definition + search/fetch providers + tool Consumer
  compaction/     compaction capability + basic provider
  context/     request-context plugins
  subagent/    subagent capability: Service Definition + providers + delegation Consumers
  bundle/      installable dsh --profile patch-layer bundles
  workflow/    workflow capability + worker-thread provider + tool Consumer
  todo/        todo_write tool
  plan/        plan mode as logged state
  preset/      per-session agent composition from preset cordis.yml files
  guard/       loop-hygiene + tool-timeout plugins
  self-modification/  the agent inspects/mounts its own plugins
  hooks/       Claude Code/Codex hook bridges + wire-protocol library
  session/     durable session data: persistence, projection, titles, telemetry
  identity/    anonymous identity
  settings/    user-settings capability + file provider
  credentials/ credential-reference capability + env/.env provider
  acp/         automation-only Agent Client Protocol server
  interaction/ approval/interaction capabilities, permission, commands, ask-user
  boot/        shared app-bin glue
  sdk/         JSON-RPC protocol, server, and TypeScript client
  examples/    demo bundles (agent-spine + CLI/ACP/JSON-RPC bins)
  support/     dev/test infrastructure
  util/        zero-dependency utilities
python/      Python SDK and bundled runtime (see python/README.md)
native/      @deepseek-ai/node-addon-landlock-run source of record (see native/README.md)
examples/    Runnable cordis.yml leaves over packages/examples bundles (see examples/AGENTS.md)
.agents/     Agent workflows and Agent Notes (`notes/`)
docs/        architecture, generated catalogs, postmortems, cookbook (see docs/AGENTS.md)
scripts/     repo gates and generators
website/     VitePress projection of selected bilingual docs/ sources
```

读这张图，建议抓三条主线：

- **core/ 是产品 API 主干**：session、system-prompt、tools、agent、agent-loop 五个包定义了会话、提示词、工具、Agent 接口与默认主循环——后面几章的主角。
- **能力分组是"接缝"**：llm、shell、subprocess、terminal、fs、web、skill、subagent、workflow……每个都是"能力家族"，通常拆成 Service Definition / Provider / Consumer 三种角色，这就是"每个部件可替换"的落点。
- **外围是支撑**：bundle/ 是可安装的 profile 补丁层，boot/ 是启动胶水，sdk/ 是进程外 JSON-RPC 协议与客户端，vendor/ 是 vendored 的 Cordis 源码，python/ 是 Python SDK，native/ 是沙箱原生模块，website/ 是文档站投影。

最后，把 core 主干加 llm 适配层单独拎出来看——架构文档的 Core packages 表给出了每个包"拥有什么"和它的 `ctx` 键，这是读代码时最常用的索引：

*来源：`docs/architecture.md`（Core packages 节）*

| Package | Owns | `ctx` key |
|---|---|---|
| `core/session` | The append-only `SessionEvent` log and in-memory store | `ctx.sessions` |
| `core/system-prompt` | Prompt-section and tool-schema assembly | `ctx.systemPrompt` |
| `core/tools` | The scoped tool registry and guarded execution pipeline | `ctx.tools` |
| `core/agent` | The `Agent` interface, live registry, and `agent/*` events | `ctx.agents` |
| `core/agent-loop` | The default driver implementing that interface | `ctx.agentLoop` |
| `core/scope` | The per-agent scoped-registration primitive | library, no key |
| `llm/llm` | Message and stream vocabulary plus the adapter seam | `ctx.llm` |

这张表透露两个设计取向：`core/scope` 没有 `ctx` 键，说明它是库而不是服务；`core/agent-loop` 只是"默认"驱动——接口定义在 `core/agent`，实现随时可以被换掉。记住这两点，你就能理解后面 M04、M06、M07 的讨论。

另外提醒一句：AGENTS.md 这张图列出的是主干分组，`packages/README.md` 的 Hierarchy 表更全（共 47 行，多了 goal、schedule、feedback、jobs、sandbox、storage、host、client 等），要精确清单时以那张表为准。

---

## 二、视角一：作为使用者——一个开箱即用的 Agent Harness

### 2.1 一条命令启动 Web UI

先当使用者。README 说得很简单：安装 Node.js，然后运行：

*来源：`README.zh.md`（通过 npm 运行）*

```sh
npx @deepseek-ai/dsh web
```

这条命令会启动 Web UI，默认地址是 `http://127.0.0.1:3080`。更完整的界面与用法说明，README 指向 Web UI 指南（docs/user/guide/index.md）；对只想先看看它长什么样的人来说，这一步已经足够。

### 2.2 从源码构建运行

作为源码精读笔记，从源码跑起来才是我们的日常。README 给出了完整命令序列：

*来源：`README.zh.md`（从源码运行）*

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

开发指南（docs/development.md）补充了前置条件：Node.js 支持 22.19+ 与 24+；pnpm 由 Corepack 管理（仓库把 `pnpm@11.7.0` 钉在 package.json 里）；Git 2.26 或更新；DeepSeek API key 是可选项——Web、headless 和 ACP 自动化 demo 以及真实 API 的 e2e 测试才需要它。另外 `pnpm install` 还会配置 worktree 局部的 Lefthook 钩子；装完建议先跑一次 `pnpm run typecheck`，成功退出即代表环境就绪。想不打开浏览器直接跑一个任务，AGENTS.md 的 Commands 节还给出了 headless 的源码运行方式：`pnpm dsh --profile headless "task"`（需要 `DEEPSEEK_API_KEY`）。

### 2.3 web 与 headless：两种 profile

刚才 `dsh web` 里的 `web`，其实是"profile"。架构文档对 profile 的定义是：**一个命名好的组合，存放在 Harness home 里**——它列出要叠加的 bundles、持有装进来的树外插件、并保存用户自己的 `cordis.patch.yml`；`web` 和 `headless` 作为模板随发行提供。两者差在哪：

- **web**：通过 `dsh-web-app` 这个 bundle 加上浏览器应用，就是你打开 3080 端口看到的那套 UI。
- **headless**：通过 `dsh-headless` 提供一次性 runner，"完全没有 server"，适合脚本化、自动化场景。

再往下一层看：`dsh-base` 是每个 profile 的第一层——模型适配器、工具、持久化、沙箱与审批策略、设置、凭证、遥测都由它提供；`dsh-web-app` 加上浏览器应用，`dsh-headless` 加一次性 runner。所以"web 还是 headless"并不是两个不同的程序，而是同一棵插件树叠加了不同的 bundle——形态差异只是组合差异。

而 bundle 是"Cordis 配置行 + 它们要挂载的代码"的发行格式，所以 bundle 插进来的东西，依然可以被更上层的补丁覆盖。一个正在运行的 dsh，本质上是启动时按顺序叠出来的一棵插件树：先按 profile 列出的顺序叠加每个 bundle，然后是 profile 的 `cordis.patch.yml`、home 级的，最后是命令行 `--patch` 覆盖。想看你的机器真正启动的是哪棵树，架构文档给了这条命令：

*来源：`docs/architecture.md`（Profiles and bundles 节）*

```sh
dsh --profile web --dump-config
```

打印出来的任何一行，你都可以用自己的一行 patch 替换掉——这句话值得记住，它是"一切皆插件"最直观的体现。装配机制的细节在 boot/app-boot 的 README（Profiles 节），配置字段全集在自动生成的 config-catalog 里；到 M03 章，我们会亲手拆一遍这条链。

### 2.4 当前阶段：developer preview

动手之前必须打个预防针。README 的原文口径是：

> DeepSeek Harness 目前处于_开发者预览_阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

（来源：`README.zh.md`）

翻译成大白话：API、配置格式、行为都还可能变，别指望长期兼容。但反过来，正因为还没有外部消费者，项目可以放心重构、改名、重打包，把"正确的底座"看得比"兼容老用户"更重（AGENTS.md 的 Pre-release stance 节）。对学习者这是好事——你看到的就是它当下最诚实的样子；对我们这本笔记也意味着：书里的代码可能过期，请以你 clone 的版本为准。

---

## 三、视角二：作为学习素材——Agent 设计的教科书

### 3.1 为什么值得读

如果说"使用者"视角是热身，"学习者"视角才是这本书的本职。我把架构文档里最值得反复咀嚼的设计点先列出来，后面的章节会逐个展开：

**插件化、无特权核心。** Cordis 是 dsh 底下的框架：插件向共享 context 贡献服务、类型化事件和可逆的效果。架构文档的原文是："Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself, so every part is replaceable from configuration." 紧接着那句更关键："There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads."——没有需要打补丁的特权核心，扩展 = 在旁边挂插件，卸载自动回滚。

**模型可见即日志（model-visible means logged）。** 会话日志是模型所看到上下文的来源；"Anything that reaches a model request must be reconstructable from the log, and a runtime invariant asserts it"——任何到达模型请求的东西都必须能从日志重建，而且有一条运行时 invariant 专门盯着它。所以新增一个模型可见输入 = 必须新增一个 session event。这一条把"可复现、可审计"从口号变成了架构约束。顺着这条不变量往下想，你会发现 Fork、续写（resume）、对话记录、遥测、持久化全部从这个流派生——架构文档的原话是："Fork, resume, transcripts, telemetry, and persistence all derive from this stream." 日志不只是记录，它就是产品的单一事实来源。

**类型化事件 + 三域事件模型。** 事件就是扩展点，选对事件域是大多数改动要做的第一个决定：session 事件是追加进日志的持久事实；agent 事件（`agent/*`）携带活着的 Agent，用来观察或拦截进行中的工作；能力事件（`fs/*`、`tools/*`、`telemetry/*`）把策略和适配器挂到接缝上而不 import 主循环。事件用声明合并做成类型化映射：`SessionEventMap` 是合并可扩展的映射，新增事件就是在映射里加成员，键名拼错在编译期就会报错。事件地图文档（event-producer-consumer.md）把每个事件的 producer 与 consumer 都列了出来，读代码先查它，比人肉搜索快得多。

测试文化也值得单独说一句：AGENTS.md 的命令表里，`test:coverage` 是 CI 覆盖率门槛，按文件 100% 卡在 `packages/*/*/src`；`test:snapshot` 是不需要 key 的 ACP/headless 回放，与预期输出比对。配合"每个包拥有自己的 `./invariant`"这条规矩，整个仓库形成了一种"用不变量与快照证明行为"的文化——对学习者来说，这是一份极好的测试设计教材。

**turn flow 是现成的教学案例。** 一个 step 是一次模型请求加上它调用的工具；一个 turn 是零或多个 step。架构文档用一段文本就把整个流程画了出来——这是后面 M04 章的主角，先给你留个印象：

*来源：`docs/architecture.md`（Turn flow 节）*

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

注意：`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 是持久 session 事件；其余是横跨三个事件域的实时扩展点。其中 `agent/pre-step`、`agent/request`、`llm/stream` 和三个 `tools/*` 事件都是 waterfall（水瀑式），监听器必须调用 `next()` 才能把控制权交给下一个监听器。另外两个细节值得先记住：输入通过唯一一个 inbox 进入驱动，有些消息会立刻唤醒它，注入的上下文则先在 inbox 里等；`agent/pre-step` 决定模型看到什么，监听器可以改写已认领的消息或直接拒绝——即使第一次认领被拒绝或改空，也会关闭一个没花 step 的持久 turn，日志照样记下这次尝试。

**能力接缝（capability seam）的三件套。** 一个可替换的能力由三种角色构成：声明接口的 **Service Definition**、实现它的 **Service Provider**、以及使用它的 **Consumer**（通常是面向模型的工具）；只有一种角色不算接缝。这解释了为什么换一个 provider 就能改变整个产品的行为：文件系统和子进程共用同一个执行世界，把它们指向远程沙箱，Bash、PTY、LSP 就一起跟着移动，不需要任何 provider 分叉。子代理接缝的跨度最能说明问题：架构文档说 subagent providers "vary just as widely behind one interface, from a fresh child agent to a delegated turn in another product"——同一个接口背后，可以是从全新子 agent 到另一个产品里的委托回合。接缝不是为了抽象而抽象，而是为了把"变"与"不变"切开。

### 3.2 本书会讲什么：12 章地图

这本书一共 12 章（M = Module，模块），从框架内核讲到能力接缝，再讲到怎么自己动手写插件：

| 章节 | 主题 |
|---|---|
| M01 开篇 | 为什么 DeepSeek Harness 值得你花时间（本章）|
| M02 Cordis 插件框架 | 插件、Service、类型化事件与 effect 语义 |
| M03 装配与启动 | profile、bundle 与 patch 的分层装配 |
| M04 Agent Loop | step 与 turn 的转动引擎 |
| M05 会话日志 | append-only 事件流与"模型可见即日志"不变量 |
| M06 模型调用 | llm 服务与流式适配 |
| M07 工具系统 | 注册、作用域与执行管线 |
| M08 事件驱动 | 三个事件域与 waterfall 语义 |
| M09 能力接缝 | Service Definition / Provider / Consumer |
| M10 提示词与上下文工程 | system-prompt 组装与注入 |
| M11 子代理与工作流 | 让 Agent 分身 |
| M12 持久化、压缩与遥测 | 会话如何存活 |

如果你只对"怎么用"感兴趣，M02–M06 快速浏览即可；如果冲着架构设计来，M04（Agent Loop）、M05（会话日志）、M08（事件驱动）、M09（能力接缝）是重头戏；如果要上手写插件，仓库的 extension cookbook 是现成入口，读完 M02–M03 就足够起步。

---

## 四、视角三：作为开发者——构建你自己的 Agent 与插件

### 4.1 扩展点：新行为去哪

架构文档专门有一张表叫 "Where new behavior goes"——新行为必须挂到有文档的扩展点上，改主循环本身反而要同步更新架构文档。我精选了 10 行，覆盖最常见的诉求：

*来源：`docs/architecture.md`（Where new behavior goes 节，节选）*

| Goal | Mechanism |
|---|---|
| Add a model provider | register its adapter on `ctx.llm` |
| Add a model-facing capability | register on `ctx.tools`; its schema joins prompt assembly |
| Add shell execution | register a `ctx.shell` backend; the local one spawns through `ctx.subprocess` |
| Add a human command | register on `ctx.commands`; it dispatches without a model turn |
| Add background work | register on `ctx.jobs`; `job_*` tools collect or stop it |
| Add filesystem access or policy | register a `ctx.fs` provider or listen to `fs/*` events |
| Confine spawned processes | use a `ctx.sandbox` backend; consumers wrap argv before spawning |
| Intercept a request, tool, or turn | use its `agent/*` or `tools/*` event; `agent/turn-stopping` stops a turn |
| Add model-facing context | call `agent.inject()`; it lands in the next admitted request |
| Add durable session state | extend `SessionEventMap`; render and replay from the log |

看出规律了吗：几乎每一行都是"在某个 `ctx.*` 上注册 / 监听某个事件"，而不是"改某个类"。这就是插件化的日常——你永远在往一棵共享的插件树上挂东西。

另有一条架构纪律值得现在就知道（来自 packages/README.md 的 Dependencies 节）：**扩展插件依赖 Service Definitions，绝不依赖具体 provider**——`dsh-agent-loop` 本身是可替换的，UI、hook 和工具插件只用 `dsh-agent`。这意味着你写插件时面向接口编程，将来换实现不换代码。真到动手那天，还有一份现成索引：架构文档末尾的 extension cookbook 把"功能 → 能力"映射起来，并指向 step-by-step 指南——add-a-package（加一个包）、add-a-tool（加一个工具）、add-an-llm-adapter（加一个模型适配器）、add-a-conversation-node（加一个聊天节点）。不必从零摸索，照着 cookbook 走，再回子系统参考页查类型定义即可。

### 4.2 发布插件：dsh-plugin 主题与社区渠道

写好了插件想让人用，README 的 Community 节给了三条路（中文版口径）：

- 通过 GitHub Discussions 提交反馈或 bug 报告；
- 给你的插件仓库加上 `dsh-plugin` 话题，便于被发现；
- 加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群（README.zh.md 附了企微小助手、入群问卷、微信公众号三张二维码）。

英文版 README 另有一条 Discord 社区链接。中文版与英文版的渠道侧重略有不同：中文版主推企微群（附小助手、入群问卷、公众号三张二维码），英文版主推 Discord，GitHub Discussions 两边都有。对开源项目来说，"可发现性"往往比代码本身更难，而 topic 的机制很简单——它是仓库的公开标签，`dsh-plugin` 这个话题就是社区插件的聚集地，打上它插件才容易被搜到。

---

## 五、总结：回顾与下一章预告

这一章我们从三个视角看了 DeepSeek Harness。作为使用者，你只需要一条 `npx @deepseek-ai/dsh web`，或者五条命令从源码跑起来，`web` 与 `headless` 两种 profile 分别对应"带浏览器 UI"和"完全没有 server"两种形态；作为学习者，它是一本难得的教科书——插件化无特权核心、模型可见即日志、类型化事件、invariant 测试文化、能力接缝三件套，每一件都是生产级设计里可以直接抄作业的答案；作为开发者，你要做的永远是"在扩展点上注册"，而不是"改核心"，而 `dsh-plugin` 话题和社区渠道会帮你的插件被更多人发现。别忘了它的开发者预览状态：破坏性变更随时可能来，但这也让它敢于把底座做对。

下一章（M02）我们正式进入源码：**Cordis 插件框架**。你会看到插件怎么贡献服务、类型化事件怎么用声明合并扩展、`ctx.effect()` / `ctx.on()` 这些"注册即效果"的语义，以及为什么"一切皆插件"在 Cordis 里不是比喻而是字面意思。

---

## 本章小结

本章立起全书的地基：DeepSeek Harness 是 DeepSeek 开源的 agent harness，一切皆插件、由 Cordis 驱动；它处于 developer preview，会破坏兼容性；`web` 与 `headless` 是两种随发行提供的 profile，一个带浏览器 UI、一个完全没有 server。接着给了三把钥匙：使用者用一条命令启动、学习者按 M01–M12 的顺序精读、开发者照"Where new behavior goes"的表找扩展点。记住三个最核心的心智模型：**没有特权核心、注册即效果、模型可见即日志**。下一章，我们从 Cordis 插件框架开始，一行一行读真正的源码。
