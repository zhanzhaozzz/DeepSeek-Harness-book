---
order: 2
title: "第2章：一切皆插件 —— Cordis 与插件化架构"
summary: "从第一个插件开始：context、服务、类型化事件与可逆 effect，理解「没有特权核心」意味着什么。"
status: published
words: 6109
codeLines: 148
minutes: 31
updated: "2026-08-14"
---

# 第2章：一切皆插件 —— Cordis 与插件化架构

读第 1 章时，你可能一直在脑补 dsh 的内部结构：一个主程序，里面塞着模型适配、工具执行、会话日志、agent 循环……像一台出厂即定型的整车。这一章，我们要把这个印象拆掉。dsh 不是整车，而是一堆积木加一套拼装规则：积木是插件，规则叫 Cordis——一个被 vendor 进仓库的插件框架。关键在于，这不是"有一个主程序，插件只是它的附件"。`docs/architecture.md` 说得很直白：**没有特权核心**。模型适配器是插件，工具注册表是插件，会话日志是插件，连 agent 循环本身也是插件。所以扩展 dsh 只有一种姿势——在别的插件旁边再挂一个插件；而你挂上去的所有注册，都是可回滚的 effect，插件卸载时自动撤销。这一整章，就是把这句话拆开讲透。

---

## 一、Cordis 是什么：依赖注入框架的升级

一句话定义：**Cordis 是一个插件框架——插件向共享的 context 贡献服务、类型化事件和可逆的 effect。** 如果你用过依赖注入（DI）框架，会觉得它的气质很熟，但它比"注册一个实现、注入一个接口"走得远得多。primer 用五句话概括了它的全部思想，我们逐条展开。

### 1.1 第一性原理一：ctx 是唯一的主角

在 Cordis 里，你几乎不 import 任何"实现"。所有交互都发生在一个叫 context 的对象上，约定俗成写作 `ctx`。一句话定义：**context 是服务的仓库，也是事件的总线和 effect 的宿主。** 插件拿到 `ctx`，把自己贡献的东西注册上去；别的插件也从 `ctx` 上按名字取用。没有全局单例，没有中央注册表文件——`ctx` 就是那个"中央"，而它属于每一个插件。

### 1.2 第一性原理二：插件是最小的注册单元

一句话定义：**插件是注册单元，是"贡献"的载体。** primer 给出了严格的说法：插件是一个实现了 Service 的对象——可以是一个带可选 `inject` 和 `apply(ctx)` 字段的函数，也可以是一个生命周期由 Cordis 挂载进当前 context 的 Service 子类。你写的每个功能，最后都要装进某个插件里。dsh 甚至有一条实践规则：把行为封装进插件——工具管线事件归 `ctx.tools`，模型流式归 `ctx.llm`，实时 agent 协调归 `ctx.agents`。

### 1.3 第一性原理三：服务按名字共享

一句话定义：**服务是插件提供给其他插件的能力，其他插件通过 `ctx.<key>` 按名字取用，而不是 import 具体实现。** `ctx.tools`、`ctx.llm`、`ctx.sessions` 都是服务。为什么"按名字"这么重要？因为配置可以换实现：同一个 `'shell'` 名字，本地 provider 和沙箱 provider 轮流上岗，消费方一行代码都不用改。primer 的原话是：加载顺序通过服务需求来表达，而不是手工编排启动顺序。

### 1.4 第一性原理四：类型化事件

一句话定义：**类型化事件让插件之间互相通知，而不需要知道谁在听。** 服务通过 TypeScript 声明合并（declaration merging）声明事件名，再用 `emit` / `waterfall` / `parallel` / `serial` 派发。关键词是"类型化"：事件名和监听器签名在编译期就确定了，漏听、听错都是编译错误，而不是运行期谜团。

### 1.5 第一性原理五：注册即可逆 effect

这是最反直觉、也最值钱的一条。一句话定义：**所有注册都是可逆的 effect——插件卸载时，它注册的一切按可预测的顺序撤销。** prompt 段、工具 schema、适配器、provider、事件监听器，全部经由 `ctx.effect()` 或 `ctx.on()` 安装，热重载和 teardown 都能干净回滚。primer 的实践规则说得很朴素：每个注册都应该有一个 disposer——要么自己从 `ctx.effect()` 返回一个，要么用 Cordis 现成的 helper；如果 teardown 顺序重要，就把相关的工作放进同一个 effect 里。

把五条串起来，就是本章的地图：

```text
        Context（ctx：服务的仓库 + 事件的广播 + effect 的宿主）
                          │  ctx.plugin(plugin) 挂载
                          ▼
                       Plugin（注册单元）
          ┌──────────────┼───────────────┬──────────────┐
          ▼              ▼               ▼              ▼
      Service 注册    Typed Event 注册   Effect 注册    child Plugin
      ctx.<key>      ctx.on / emit     ctx.effect()   ctx.plugin()
      按名取用         类型化通信         返回 disposer    随父插件卸载
```

*示意图（笔者绘制）：Context 挂载 Plugin，Plugin 往下注册 Service / Event / Effect，还能再挂 child Plugin。*

---

## 二、第一个插件：从零开始

先给一个诚实的澄清：Cordis 教程里**没有一个叫 `createPlugin` 的工厂函数**。最小插件就是一个模块，命名导出一个 `apply` 函数。Cordis 加载它时，会调用 `apply`，并传入一个 context——`ctx` 就是插件注册一切贡献的通道。

### 2.1 一个最小的插件

在教程的 `tmp/cordis-tutorial` 目录下建一个 `hello.ts`：

*来源：`docs/cordis-tutorial/01-first-plugin.md`，逐字摘录。*

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello'

export function apply(ctx: Context) {
  console.log('hello from my first plugin')
}
```

注意两个细节。`name` 导出是**可选的展示元数据**，作用只是给诊断信息贴上标签；真正干活的是 `apply(ctx: Context)`——Cordis 调用它，把 `ctx` 交到你手里。这个文件里没有任何框架引导代码：插件只描述自己贡献什么，而"拼装应用"这件事交给配置文件。

### 2.2 把插件"装"起来

教程的启动器从配置组装应用。再建一个 `cordis.yml`：

*来源：`docs/cordis-tutorial/01-first-plugin.md`，逐字摘录。*

```yaml
- name: './hello.ts'
```

这个文件是一份**插件条目列表**。`name` 是模块说明符——一个相对路径或 npm 包名，loader 会挂载每一个条目。运行它：

*来源：`docs/cordis-tutorial/01-first-plugin.md`，逐字摘录。*

```sh
node --import tsx ../../vendor/cordis/bin.js
```

控制台会打印 `hello from my first plugin`。教程把背后的三步拆得很清楚：第一步，启动器创建根 `Context` 并挂载 **Loader** 插件；第二步，Loader 读取 `cordis.yml`、解析 `./hello.ts`，把它作为**子插件**挂载——这就是"装配入口"，用代码做同样的事就是 `ctx.plugin(child)`；第三步，Cordis 调用你的 `apply(ctx)`。

一个反直觉的细节：**条目是并发启动的**，列表位置不保证谁先加载。加载顺序由服务依赖（`inject`）决定，而不是文件里的先后——这正是第 1.3 节那句话的出处。

### 2.3 三种插件形态与"破坏性实验"

教程告诉我们，函数只是最常见的一种形态，Cordis 一共接受三种：函数插件（你刚写的）、带 `apply` 方法的对象插件、以及 `Service` 子类的类插件（第 4 节的主角）。在需要暴露服务之前，先用函数形态就够了。

再做个破坏性实验：让 `apply` 直接 `throw`。重新运行，进程会带着你的错误直接死掉——**加载失败的插件是响亮的失败，不是被跳过的条目**。只有一个例外值得提前知道：如果条目的模块**解析不了**（路径或包名拼错），错误会走 Cordis 的 logger 服务而不是崩掉进程，而启动早期 logger 可能还没有控制台导出器在监听，所以这条报告可能丢失。要是新加的条目"什么都没发生"，先检查拼写。

---

## 三、生命周期与 effect：注册即卸载

插件不是一次装好就永垂不朽的。教程列了四种卸载触发：配置被编辑、热重载、显式 dispose、以及**依赖的某个服务消失**。卸载时会发生什么，是 Cordis 与普通 DI 框架最大的分水岭。

### 3.1 ctx.effect：自己管理资源时的 disposer 约定

凡是 Cordis 已经管理的注册（事件、子插件、服务注册），都是 effect，随插件卸载自动撤销。但总有些资源 Cordis 不管——定时器、连接、watcher——这时候你要亲手把它们包进 `ctx.effect()` 并返回一个 disposer：

*来源：`docs/cordis-tutorial/02-lifecycle-and-effects.md`，逐字摘录。*

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'lifecycle-demo'

function heartbeat(ctx: Context) {
  console.log('heartbeat plugin loading')
  ctx.effect(() => {
    const timer = setInterval(() => console.log('tick'), 200)
    return () => {
      clearInterval(timer)
      console.log('heartbeat cleaned up')
    }
  })
}

export function apply(ctx: Context) {
  // Mount a child plugin and keep its fiber to dispose it later.
  const fiber = ctx.plugin(heartbeat)
  // The demo timer is itself an effect: if THIS plugin is unloaded first,
  // the pending callback is cancelled instead of firing on a dead app.
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      await fiber.dispose()
      console.log('disposed')
      process.exit(0)
    }, 700)
    return () => clearTimeout(timer)
  })
}
```

三条语义要钉死。第一，**effect 的函数体在加载时运行，它返回的 disposer 在卸载时运行**——插件生命周期的资源，你永远不该自己调用 disposer。第二，`ctx.plugin(heartbeat)` 是从**代码**挂载一个函数插件，和 YAML loader 对每个配置条目做的事是同一个操作；函数插件不需要 `apply` 方法，Cordis 直接调用函数本身，名字只用于诊断。第三，它返回的是一个 **fiber**——一个已加载插件实例的运行时句柄；`fiber.dispose()` 会等所有清理（包括 async disposer）结束才 resolve，并且递归卸载它挂载过的所有子插件。

### 3.2 fiber 状态机

每个已加载的插件实例都拥有一条 fiber，在教程给的这几个状态间移动：

*来源：`docs/cordis-tutorial/02-lifecycle-and-effects.md`，逐字摘录。*

```
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
                 ↘ FAILED
```

- **PENDING**——已声明，但某个必需服务（第 4 节）还不可用；
- **LOADING / ACTIVE**——`apply` 正在运行 / 已经完成；
- **FAILED**——`apply` 或配置校验抛了错；
- **UNLOADING / DISPOSED**——disposers 正在跑 / 全部拆除完毕。

你会在后面的章节再次遇见 PENDING，那时它是"我的插件为什么不打印任何东西"的常见答案。

### 3.3 回滚的顺序与一个坑

实际上你很少亲手写 `ctx.effect()`，因为内置注册 API 本身就是 effect：`ctx.on(event, listener)` 的监听器随卸载移除，`ctx.plugin(child)` 的子插件随父插件一起 dispose，服务注册同理——dsh 的注册表比如 `ctx.tools.register(...)`，返回的 disposer 会自动挂在调用它的插件上，随插件卸载自动撤销。

一句话定义：**卸载 = 逆序执行 disposer，把插件的一切贡献"原路退回"。** 完整时序如下：

```text
配置行 / ctx.plugin() ──> fiber(PENDING) ── 依赖服务就绪 ──> LOADING
    apply(ctx) 运行：注册 Service / Event / Effect
                                   │
                                   ▼
                                ACTIVE
                                   │  卸载：配置编辑 / 热重载 / 显式 dispose / 依赖消失
                                   ▼
                           UNLOADING ── 逆序执行 disposer ──> DISPOSED
                           （多个 async disposer 并发执行）
                                   ↘ FAILED（apply 抛错或配置校验失败）
```

*示意图（笔者绘制，状态名与教程一致）。*

但有一个坑：disposers 按**逆注册顺序**启动，而多个 **async** disposer 是**并发**跑的。如果 teardown 必须严格串行，就把相关步骤塞进同一个 disposer 里、在里头 `await` 完。

---

## 四、服务：能力共享的契约

一句话定义：**服务是一个命名的能力——一个插件提供它，其他插件通过 `ctx` 消费它。** 在 harness 里，`ctx.tools`、`ctx.llm`、`ctx.agents` 都是服务。消费方声明的是能力名（比如 `'tools'`），而不是 import provider 的实现，所以配置可以自由选择 provider 而不用改消费方。

### 4.1 定义、注册、注入三步

教程的 `greeter.ts` 是标准三步样板：

*来源：`docs/cordis-tutorial/03-services.md`，逐字摘录。*

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}

export class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  greet(who: string) {
    return `Hello, ${who}!`
  }
}

export const name = 'greeter'

export function apply(ctx: Context) {
  ctx.plugin(GreeterService)
}
```

两块拼图缺一不可。**运行时**：`super(ctx, 'greeter')` 把这个实例注册到名字 `greeter` 下，从此任何插件都能以 `ctx.greeter` 触达它——而且这个注册本身是 effect，卸载 provider 就会移除服务。**编译期**：`declare module '@deepseek-ai/cordis'` 那段是 TypeScript 声明合并，它把 `greeter` 加进 `Context` 接口，让 `ctx.greeter` 处处类型安全；它不产生任何代码——没有它服务照样运行，只是消费方失去类型保护。还记得第 2 节的类插件形态吗？`Service` 子类本身就是一个插件，所以 `ctx.plugin(GreeterService)` 把它当普通插件挂载。

消费方用 `inject` 声明依赖：

*来源：`docs/cordis-tutorial/03-services.md`，逐字摘录。*

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'consumer'
export const inject = ['greeter']

export function apply(ctx: Context) {
  console.log(ctx.greeter.greet('world'))
}
```

`inject` 列出本插件需要的服务。Cordis 会把插件摁在 PENDING，直到列表里每个服务都存在——所以在 `apply` 内部，`ctx.greeter` 保证就绪。`cordis.yml` 里谁在前谁在后无所谓：是依赖，而不是文件顺序，决定插件何时启动。把两条配置对调再跑，输出一样。如果干脆删掉 `greeter.ts`，consumer 会一直停在 PENDING、什么都不打印——不崩、不半跑，而且 PENDING 的 fiber 不会让 Node 的事件循环保持存活，整个组合会静默退出 0。

### 4.2 依赖是"加载之后仍被追踪"的

`inject` 不是一次性启动检查。**如果应用运行期间某个必需服务消失了**——它的 provider 被卸载或被热替换——所有依赖它的插件也会被卸载，等服务回来再重新加载。配合 effect 机制，这就杜绝了"还在运行的消费者握着一个已失效服务的引用"：依赖一消失，它自己的注册就同步回滚。这也是配置里换服务能成功的原理：卸掉 `dsh-bash-local` 条目、挂上另一个 `shell` provider，所有 inject `'shell'` 的插件都会干净地对着新实现重启。反过来，如果某个能力可有可无，就别用 `inject`，改用 `ctx.get('greeter')` 在使用点探测——拿不到就优雅降级。

### 4.3 真实世界的服务：dsh-tools 的 ToolRuntime

光看教程不过瘾，来看仓库里真实的注册表服务——`packages/core/tools/src/index.ts` 里的 `ToolRuntime`。它占用的正是 `ctx.tools`：

*来源：`packages/core/tools/src/index.ts`（Context 声明合并），逐字摘录。*

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolRuntime
  }
}
```

服务类的骨架长这样——注意 `static inject` 和 `static Config` 两个静态字段：

*来源：`packages/core/tools/src/index.ts`（ToolRuntime 类声明），逐字摘录。*

```ts
export class ToolRuntime extends Service {
  static inject = ['systemPrompt']

  static Config: z<Config> = z.object({
    mode: z.union(['native', 'code', 'both'] as const).default('native'),
    maxParallelSubCalls: z.natural().min(1).default(10),
  })
```

构造器里 `super(ctx, 'tools')` 完成注册命名，接着就往 `ctx.systemPrompt` 上挂 prompt 段（这里能看到服务之间如何互相消费）：

*来源：`packages/core/tools/src/index.ts`（ToolRuntime 构造器，中略中间部分），逐字摘录。*

```ts
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tools')
    // ……（中略：解析 mode / maxParallelSubCalls，并向 ctx.systemPrompt 注册 prompt 段）
  }
```

你看，真实服务与教程 `greeter` 的形状完全一致：类 extends `Service`、构造器 `super(ctx, 名字)`、声明合并进 `Context`、`inject` 声明依赖。区别只是它更大、并且用 `static Config` + schemastery 的 `z.object` 声明了自己的配置 schema——这把"服务"和"配置行"连起来了。

### 4.4 服务与配置行的关系

在 dsh 里，服务不是凭空出现的，而是**由配置行把它装起来**：`cordis.patch.yml` 里一行 `id: llm, name: '@deepseek-ai/dsh-llm'`，loader 就去挂载 `@deepseek-ai/dsh-llm` 这个包，包启动时注册 `ctx.llm` 服务。而服务声明了什么配置 schema，配置行就能给它传什么——比如 dsh-tools 的 `Config.mode` 决定工具以 `native` / `code` / `both` 哪种形式呈现给模型（见 `packages/core/tools/src/index.ts` 的 `Config` 接口 JSDoc）。配置的解析细节（`config` 字段如何插值、如何校验）我们留到第 3 章，这里只需记住方向：**配置行选插件，插件注册服务，服务名是跨插件契约的锚点。** 另外提醒一句命名纪律：服务名在应用里是**单一扁平命名空间**，dsh 占用了 `tools`、`llm` 这类朴素名字，你自己造的服务记得加前缀。

---

## 五、事件：类型化的事件地图

服务适合直接调用；**事件**则让一个插件宣布某件事，而不用知道谁在听。dsh 用事件承载工具结果、模型请求、审批决策这些交互。一句话定义：**事件是插件的通信层，声明即契约，监听即 effect。**

### 5.1 声明、派发、监听

教程的 `stats.ts` 展示了事件声明的完整形态：

*来源：`docs/cordis-tutorial/04-events.md`，逐字摘录。*

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    stats: StatsService
  }
  interface Events {
    'stats/report'(name: string, count: number): void
  }
}
```

`interface Events` 的合并，是第 4 节 `interface Context` 合并的"事件版孪生兄弟"：它声明事件名和监听器签名，让 `ctx.emit` 和 `ctx.on` 全程类型安全。`namespace/action` 的命名约定，让扁平的事件命名空间保持可读。派发发生在服务方法里（`this.ctx.emit('stats/report', name, next)`），监听则靠 `ctx.on`：

*来源：`docs/cordis-tutorial/04-events.md`，逐字摘录。*

```ts
export function apply(ctx: Context) {
  ctx.on('stats/report', (name, count) => {
    console.log(`[stats] ${name} -> ${count}`)
  })
  ctx.stats.bump('tool_call')
  ctx.stats.bump('tool_call')
  ctx.stats.bump('prompt')
}
```

因为 `ctx.on()` 是 effect，监听器会随插件一起消失——**永远不需要手动 removeListener 记账**。

### 5.2 五种派发模式与 waterfall 纪律

事件用哪种模式派发，是它公开契约的一部分。教程给了五张牌：

| 模式 | 调用 | 语义 |
|---|---|---|
| emit | `ctx.emit(name, ...args)` | 同步广播；返回的 promise 和值既不等待也不收集。 |
| parallel | `await ctx.parallel(name, ...args)` | 所有监听器并发运行，一起等待。 |
| serial | `await ctx.serial(name, ...args)` | 监听器按序运行并等待；第一个非 `null`/`false`/`undefined` 的返回值胜出并停止其余。 |
| bail | `ctx.bail(name, ...args)` | serial 的同步版本。 |
| waterfall | `ctx.waterfall(name, ...args, next)` | 环绕式中间件，见下。 |

waterfall 是拦截能力的来源。监听器收到参数外加一个 `next()` 续体：调用 `next()` 把（可能被包装过的）结果交给下一个服务；不调用 `next()` 直接 return，就是短路——Cordis 文档所谓的 veto。由此衍生出一条**仓库级纪律**：只观察或注解的 waterfall 监听器必须调用 `next()`；不调用就是故意的短路。在一个日志监听器里忘掉 `next()`，会静默吞掉下游所有人的默认行为。dsh 用 waterfall 承载需要协作插件包裹或回答的决策：`agent/request` 让插件替换模型调用配置，`approval/request` 让策略插件替用户作答。

### 5.3 dsh 的三个事件域

`docs/architecture.md` 把 dsh 的事件分成三个域，选对域是大多数改动的第一个决策：

- **Session 事件**——追加进日志的持久事实，并通过 `session/event` 广播。需要"重载后仍然存活"的事实就用它。例子：`assistant/message` 落地成日志，重放和 UI 都从这里渲染（详见第 8 章）。
- **Agent 事件（`agent/*`）**——携带一个活的 `Agent`：inbox、step、status、request、validation、continuation。用来观察或拦截进行中的工作。例子：`agent/pre-step` 决定模型这一轮看到什么（详见第 8 章）。
- **Capability 事件**——把策略和适配器挂到某个能力缝上（`fs/*`、`tools/*`、`telemetry/*`），不用 import 循环。例子：`tools/pre-execute` 在执行前决定 allow / deny / ask（详见第 8 章）。

真实事件的声明长这样——注意 JSDoc 里的 `@mode` 标签，它是事件契约的一部分，生成目录会拿它核对声明与派发点是否一致：

*来源：`packages/core/tools/src/index.ts`（'tools/pre-execute' 事件声明），逐字摘录。*

```ts
  interface Events {
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

### 5.4 "模型可见即日志"：事件如何撑起会话日志

会话日志是**模型所见上下文的唯一来源**：`deriveMessages()` 从日志投影出模型历史，原始 `assistant/chunk` 事件保住重放和 UI 保真度。fork、resume、transcripts、遥测、持久化全都从这条流派生。由此引出 architecture.md 那条铁律：**模型可见即日志**——任何到达模型请求的东西，都必须能从日志重建，而且有一条运行时不变式（runtime invariant）专门断言这一点。这就是为什么一个新的模型可见输入必须配一个新的 session 事件：扩展 `SessionEventMap`，并从这个日志渲染。session 包入口里，广播这条流的正是 `session/event`：

*来源：`packages/core/session/src/index.ts`（'session/event' 事件声明），逐字摘录。*

```ts
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
```

注意这里 JSDoc 标注的是 `@mode emit`、fire-and-forget 追加广播——持久化插件订阅它，把事件写进磁盘。这个"事件驱动一切"的架构，正是第 8 章的主角。

---

## 六、配置行与装配：插件如何被"装"起来

现在回到第 2 节那个问题：插件靠什么拼起来？答案是**配置行**——`cordis.yml` 和 `cordis.patch.yml`。

### 6.1 cordis.yml：一份插件清单

教程里的 `cordis.yml` 已经见过了：一份插件条目的列表，每条有个 `name` 模块说明符。loader 逐条挂载。就这么简单——它是"这个应用由哪些插件组成"的声明。

### 6.2 cordis.patch.yml：按 id 覆盖的行

真实产品比教程多一层：`cordis.patch.yml`。dsh-base 的 patch 文件开头注释说得直白：它是每个 dsh profile 共享的核心，作为**一次 insert** 铺在空的 profile 根上；后面的 bundle patch 和用户自己的 `cordis.patch.yml` 按 id 寻址这些行，**每行最后写入者胜**。而且 patch 是**整行替换** `config`，不是合并进去。看真实片段：

*来源：`packages/bundle/base/cordis.patch.yml`（开头 insert 段），逐字摘录。*

```yaml
- insert:
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'

    - id: hmr
      name: '@deepseek-ai/cordis-plugin-hmr'
      config:
        root: ['.']

    - id: llm
      name: '@deepseek-ai/dsh-llm'

    - id: session
      name: '@deepseek-ai/dsh-session'
```

每行的要素就三个：**`id`**（寻址锚点，patch 靠它覆盖）、**`name`**（指向要挂载的包）、**`config`**（传给插件的配置，可选）。注意 `hmr` 行：`config.root: ['.']` 就是热重载插件监听当前目录。还有一个容易误会的点：文件注释强调**行顺序不携带加载语义**——激活是服务可用性驱动的，行排序纯粹为了读者阅读。另外，loader 配置里 `config` 和 `disabled` 字段支持 `!!js` 表达式（用来按环境决定插件的启用与否），环境选择插件时用 overlay——这些装配细节，第 3 章会展开。

### 6.3 从配置行到运行树

把尺度拉大看全貌（`docs/architecture.md`）：一个运行中的 dsh 是一棵**在启动时由有序图层拼出来的插件树**。profile 是存放在 Harness home 的命名组合，列出它叠的 bundles、装的外部插件，以及用户自己的 `cordis.patch.yml`（`web` 和 `headless` 作为模板随包提供）；bundle 是"配置行 + 它们挂载的代码"的发行格式，保证插入的东西仍可被上层 patch。图层按顺序作用在空的条目列表上：profile 列出的每个 bundle → profile 的 `cordis.patch.yml` → home 级的一个 → 任何 `--patch` overlay。想知道你的机器实际启动的树长什么样？跑一句 `dsh --profile web --dump-config`，打印出来的每一行你都能用自己的一条 patch 替换。再往后，`docs/subsystems/extensions.md` 告诉我们还有更野的玩法：扩展子系统让 **agent 自己定义带版本的 Cordis 包**、运行 host/browser 两半、写代码前先查询已批准的运行时元数据——dsh 用它自己扩展自己。

---

## 七、本章小结

这一章的骨架可以压缩成一张卡片：**ctx 是唯一的主角，插件是唯一的注册单元，服务按名字共享，事件按契约广播，所有注册都是可逆的 effect。** "没有特权核心"由此水到渠成——模型适配器、工具注册表、会话日志、agent 循环，全是坐在同一张桌子旁的插件，谁都不比谁特殊；扩展 dsh 就是"再挂一个插件"，而卸载任何插件，它的一切贡献都会原路退回。配置行（`cordis.yml` / `cordis.patch.yml`）只是把"挂哪些插件、传什么配置"声明出来：行按 id 寻址、整行替换、最后写入者胜，loader 按服务可用性激活，不靠文件顺序。有了这套世界观，你已经能读懂任何插件包的 `apply`、`inject`、`Config` 和 `declare module` 了。

下一章，我们把镜头从"单插件"拉远到"整台机器的组装"：**profile、bundle 与 patch 装配**——图层如何叠放、行如何被 id 覆盖、`!!js` 表达式和 overlay 如何在环境中挑选插件。届时你会发现，第 6 节那些"预告"其实是一张完整装配图的局部。
