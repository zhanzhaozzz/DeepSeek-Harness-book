---
order: 3
title: "第3章：装配与启动 —— profile、bundle 与 patch"
summary: "一次 dsh 启动如何按配方拼出一棵插件树：profile、bundle 与 patch 三个概念与分层叠加。"
status: published
words: 4431
codeLines: 123
minutes: 22
updated: "2026-08-14"
---

# 第3章：装配与启动 —— profile、bundle 与 patch

第 2 章我们把 Cordis 插件框架拆开看过：ctx、插件、服务、事件、effect、配置行。你现在手里有了一堆零件，也知道怎么拧零件，但还缺一样东西——配方。dsh 启动时并不是"运行一个程序"，而是"按配方拼一棵插件树"：读配方、按顺序取材料、逐层叠加，最后把整棵树交给 Loader 挂载。这个配方就叫 profile。本章分四步讲清楚这件事：先认识 profile、bundle、patch 三个概念；再看分层叠加的顺序；然后用 `--dump-config` 亲眼看看你机器上长出来的那棵树；最后解剖一个真实 bundle，并动手写一个自己的 patch。读完你会发现，dsh 的架构里没有"需要打补丁的特权核心"——因为整棵树都是从配置拼出来的。

---

## 一、三个概念，一次讲清

### 1.1 profile：命名装配

**一句话定义：profile 是一个命名的装配清单，存放在 Harness home 里，决定"这一份 dsh 由哪些 bundle 叠成"。**

它的物理位置是 `$DSH_HOME/profiles/<name>`——`$DSH_HOME` 没设置时默认 `~/.dsh`。目录里结构性的东西只有两件：一个 `package.json`，装着 out-of-tree 插件的 `dependencies` 以及装配清单 `dsh.profile`（它的 `bundles` 数组按顺序列出要叠加的 bundle 包名）；一份 `cordis.patch.yml`，也就是你自己的 patch 层。注意 profile 自己不写任何插件代码，它只负责"点名"。architecture.md 的原话是："A **profile** is a named composition stored in the Harness home. It lists the bundles it stacks, holds any out-of-tree plugins it installs, and keeps the user's own `cordis.patch.yml`."

出厂自带两个模板：`web` 和 `headless`。它们第一次被使用时自动初始化；其他名字必须先走 `dsh plugin` 创建，否则启动直接报错。

### 1.2 bundle：分发格式

**一句话定义：bundle 是一种分发格式——一个 npm 包，里面装着一份 Cordis 配置行（patch 文件）和这些配置行要挂载的代码。**

architecture.md："A **bundle** is a distribution format for Cordis config rows and the code they mount, so whatever it inserts stays patchable by the layers above it." 为什么非要"分发格式"这一层？因为配置行和实现必须一起走：patch 里 `name: '@deepseek-ai/dsh-session'` 这一行要挂载的插件，得在同一个包里被安装、被解析到。bundle 让"一段配置 + 它的实现"能作为一个整体被安装、被点名、被叠加，也因此它插入的任何一行，都天然可以被更上层的 patch 再次替换。

### 1.3 patch：最小操作单元

**一句话定义：patch 是一个按行 id 操作配置的补丁——按 id 替换整行（整个 config 一起换），或者 insert 新行。**

patch 文件是一个顶层 YAML 数组，每项要么是 `- id: xxx` 带上 `config:` 或 `disabled:`——按 id 命中已有行、整行替换；要么是 `- insert:` 带上新行列表——向树里追加。两个关键约束：替换是整行 config 替换，不是深合并，要保留的字段必须复述；`!!js` 表达式允许在挂载时插值（比如读 `process.env` 或 `dshHomePath(...)`）。这两个约束后面会反复出现，先记住。

### 1.4 三者关系

```text
profile（命名装配，存在 Harness home 的 profiles/<name>/）
  └─ dsh.profile.bundles：按顺序点名的 bundle 包名列表
        │
        ▼ 逐个解析（安装目录优先，其次 profile 目录）
     bundle（npm 包：分发格式）
       ├─ dsh.bundle.patch → cordis.patch.yml（一份 patch）
       └─ 代码：patch 里 name 指向的插件实现
        │
        ▼ 按序叠加（applyEntryPatches，从空列表开始）
     patch（最小操作：按 id 替换整行 config / insert 新行）
        │
        ▼
     一棵完整的插件树（entry 列表）→ Loader 挂载 → 启动
```

一句话串起来：**profile 点名 bundle，bundle 提供 patch，patch 叠加成树**。dsh 里没有"复制一份配置改一改"这种事，只有"更上层按 id 写一行"。

---

## 二、分层应用顺序：从空列表到完整树

叠加的次序，architecture.md 一句话讲完了（原文照抄）：

> Layers apply to an empty entry list in this order: each bundle in the profile's listed order, then the profile's `cordis.patch.yml`, then the home-level one, then any `--patch` overlay. A patch targets a row by id and replaces its whole config, or inserts new rows.

```text
空 entry 列表 []
  │
  ▼ 第 1 层  bundle：dsh-base                     insert 全部基础行      ← 最低
  ▼ 第 2 层  bundle：dsh-web-app / dsh-headless   insert 新行 + 按 id 覆盖 base 行
  ▼ 第 3 层  profiles/<name>/cordis.patch.yml     你的 profile 专属层
  ▼ 第 4 层  ~/.dsh/cordis.patch.yml              home 级层（比 profile 层高）
  ▼ 第 5 层  --patch <文件>                       命令行动态覆盖         ← 最高
  │
  ▼ 同一份 applyEntryPatches 调用
 一棵完整插件树 → Loader 挂载
```

逐层看：

1. **bundle 层**：从空 entry 列表开始，按 `dsh.profile.bundles` 里列出的顺序，逐 bundle 应用它的 patch。`dsh-base` 通常第一——它一上来就 insert 出几十行基础行。
2. **profile 层**：`profiles/<name>/cordis.patch.yml`，你的专属补丁，盖在所有 bundle 之上。
3. **home 层**：`~/.dsh/cordis.patch.yml`。注意顺序——profile 层先、home 层后，所以 home 层"更靠上"，outranks profile 层。
4. **`--patch` overlay**：命令行临时指定一个 patch 文件，最高。

"更高层可以替换低层任何一行"，机制就是按 id：每一层只按 id 寻址，命中的行整个 config 换掉，或者 insert 新行。base 的 patch 头注释把规则说得很直白："Later bundle patches and the user's profile cordis.patch.yml address these rows by id, with the last write winning per row."——同一行，最后写者胜。

几个边界行为值得记住（都来自 app-boot README）：patch 命中的 id 在树里不存在，只是 stderr 警告，不报错；空文件或纯注释的 patch 文件会直接抛错（它解析出来是"什么都没有"，不是一个列表），想关掉这一层就写 `[]`。另外长驻表面（比如 web）会热重载 `cordis.patch.yml`——`watchUserPatches` 盯着文件，改了之后事务性地重算整棵树的 patch 列表，失败则保留上一棵好树。

还有一点，叠加不是各层各算各的：boot、`--dump-config`、flag 派生用的是同一个 `applyEntryPatches` 调用（profile.ts 里 `composeEntries` 的注释："the same single `applyEntryPatches` call the boot include makes, so flag derivation and config dumps see exactly what mounts"）。所以你在 dump 里看到的，就是真正挂载的。

---

## 三、看你的机器实际启动的树

光讲概念不过瘾。architecture.md 直接给了你一条命令，照抄：

> To see the tree your machine actually boots:
>
> ```sh
> dsh --profile web --dump-config
> ```
>
> Any row it prints can be replaced by a patch of your own.

*来源：`docs/architecture.md` 第 29–35 行*

这条命令输出的是一个 YAML 文档，里面每一行 entry 就是最终要挂载的那棵树的真实样子。有两件事值得注意。

第一，输出不是"某种配置快照"，而是**与实际启动完全同源**的产物。app-boot 的 `renderConfigDump` 用 include 自己的解析器和 patch 算法（`entryListSchema` / `applyEntryPatches`）离线合成结果，注释里写得很明确："so the result equals what `boot()` mounts"。输出还会用 `# ==` 注释给每一段分组，标明这段来自哪个文件、被哪些层 patch 过；`!!js` 表达式原样打印、不求值——因为求值发生在挂载时，dump 只负责呈现"这一行写的是什么"。

第二，"Any row it prints can be replaced by a patch of your own"——这句话为什么成立？因为每一行都有一个 id，而 patch 就是按 id 寻址的。你在 profile 层或 home 层写一个同名 id 的行，就能把 dump 里那一行整个替换掉。反过来说，dump 也是你写 patch 的底稿：想改哪行，直接从 dump 里把那一行抄出来，改 `config` 再放回你的 patch 文件——整行替换的规则决定了你本来就要复述全部字段，抄比记省事得多。

顺带一提，app-boot 还提供 `--dump-default-config`（profile.ts 注释里叫它 "a recovery diagnostic"）：它只叠 bundle 层、跳过用户 patch 层，用来在你把 profile 改坏之后看"出厂原样"。

另外，如果你想查"某一行能设哪些字段"，参考的是生成的 config catalog——它是 deployment 轴的字段清单："Every `config:` block a `cordis.yml` entry can set"。dump 告诉你这台机器实际设了什么，catalog 告诉你字段的合法形状，两者配合着用。

---

## 四、bundle 解剖：一个 patch 文件 + 一个 package.json 字段

一个 bundle 的全部"接口"就是两个东西：一份 patch 文件，和一个声明它的 package.json 字段。我们拿 `@deepseek-ai/dsh-base` 开刀。

### 4.1 patch 文件：配置行长什么样

`cordis.patch.yml` 是顶层 YAML 数组。dsh-base 的 patch 只有一个条目——`insert`，一次插入全部基础行（文件头注释："applied as ONE insert over the empty profile root"）。摘录开头一段：

*来源：`packages/bundle/base/cordis.patch.yml` 第 15–44 行*

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

    - id: typert
      name: '@deepseek-ai/dsh-typert-registry'

    - id: typert-loader
      name: '@deepseek-ai/dsh-typert-loader'

    - id: typert-gateway
      name: '@deepseek-ai/dsh-api-gateway'

    - id: session-title
      name: '@deepseek-ai/dsh-session-title'
      config:
        fallbackMaxWords: 5
        fallbackMaxBytes: 40
        maxTitleBytes: 80
```

逐行读：

- `- insert:` 是这一层 patch 的类型——插入新行。每个 entry 两个必填键：`id` 和 `name`。`id` 是这行在全树中的寻址键，patch 就是靠它命中的；`name` 是要挂载的插件包名，Loader 按它解析模块。
- 没有 `config` 的行（`timer`、`llm`、`session`…）用插件默认配置；带 `config` 的行（`hmr`、`session-title`）给出该插件的具体配置——这些字段的合法形状，就是 config catalog 收录的内容。
- `session-title` 的三个字段一眼能看出含义：标题回退的字数/字节上限、最终标题的字节上限。dsh 的配置行就是这样"配置即代码"：没有注册表、没有后门，就是一行 YAML 指名道姓。
- 行序没有加载语义。base 头注释明说："Row order carries no load semantics (activation is service-availability driven); the grouping is for readers."——谁先挂载不靠行序，靠服务可用性。

再看一段"动态"的行——沙箱与审批这块，`!!js` 表达式开始出现：

*来源：`packages/bundle/base/cordis.patch.yml` 第 169–191 行*

```yaml
    - id: sandbox
      name: '@deepseek-ai/dsh-sandbox-local'

    - id: sandbox-policy
      name: '@deepseek-ai/dsh-sandbox-policy'
      config:
        mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
        workspaceRoot: !!js process.cwd()

    - id: bash-sandbox
      name: '@deepseek-ai/dsh-bash-sandbox'
      disabled: !!js process.platform === 'win32'
      config:
        timeoutMs: 60000

    - id: pwsh-sandbox
      name: '@deepseek-ai/dsh-pwsh-sandbox'
      disabled: !!js process.platform !== 'win32'

    - id: approval
      name: '@deepseek-ai/dsh-user-approval'
      config:
        policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"
```

这五行信息量很大：

- `!!js` 是 include 的 YAML 方言：表达式在 Loader 挂载时、对着注入好的 ctx 求值。`sandbox-policy` 的默认模式读 `process.env.DSH_PERMISSION_MODE`，`workspaceRoot` 默认当前工作目录——同一个 patch 文件，在不同机器、不同目录下长成不同的值。这正是 dsh 的"配置行"与"纯数据配置"的分野：行里可以带逻辑。
- `disabled` 是 entry 的合法字段，也可以写成 `!!js` 表达式。`bash-sandbox` 在 win32 上禁用、`pwsh-sandbox` 在非 win32 上禁用——一个共享 patch 文件，每个宿主恰好挂一套 shell 栈（Windows 上用 pwsh，其余用 bash）。
- 注意 `approval` 的 policy 表达式：审批策略跟随权限模式联动。这是"按 id 整行替换"设计下的典型形态——**模式相关的值不写死在 base 里**，base 头注释直言："a row whose value differs by mode does NOT live here: it belongs to each mode bundle"。谁的模式谁复述。

### 4.2 package.json：dsh 字段

bundle 的身份声明在 package.json 里，一个 `dsh` 字段，逐字摘录：

*来源：`packages/bundle/base/package.json` 第 36–40 行*

```json
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
```

就这些。architecture.md 说："Each declares itself in its own `package.json` under a `dsh` field: `dsh.profile` lists a profile's bundles, and `dsh.bundle` points at a bundle's patch file." `dsh.bundle.patch` 指向 bundle 根下的 patch 文件；配套地，package.json 的 `exports` 里导出 `"./cordis.patch.yml"`、`files` 里把它打进发布包（base 的第 25、32 行），保证这个文件随包分发、可被解析。profile 侧则是 `dsh.profile.bundles`，一个包可以同时声明两种角色（profile.ts 里 `DshManifestSection` 的注释："A manifest may declare both roles"）。

### 4.3 依赖关系：patch 里的 name 都要装得到

bundle 的 `dependencies` 会列出 patch 里每一行 `name` 对应的包（base 的 dependencies 有上百个 workspace 依赖，与 patch 行一一对应），`peerDependencies` 是 `cordis` 和 `dsh-invariants`——所有插件共享同一份 Cordis 实例。而 profile 那边，`loadProfile` 解析 bundle 名时是两锚点解析：先装 dsh 的安装目录，再 profile 目录；一个被点名的包如果没声明 `dsh.bundle`，直接 fail loud——"声明了 bundle 层却没有 patch 文件"是配置错误，不是"没有补丁"。另外 `healProfilesModuleFallback` 会在 `$DSH_HOME/profiles/node_modules` 维护一层扁平符号链接（安装包依赖闭包里每个包一条），让任何 profile 里的裸包名都能被 Node 的父目录查找解析到——out-of-tree 插件因此可以装在 profile 目录里而不需要 pnpm 管理盒内包。

---

## 五、三种出厂装配：dsh-base / dsh-web-app / dsh-headless

先看 profile.ts 里出厂模板长什么样——每个模板都是"base + 一个模式 bundle"：

*来源：`packages/boot/app-boot/src/profile.ts`（PROFILE_TEMPLATES）*

```ts
/** The shipped profile templates auto-initialized on first use, by name. */
export const PROFILE_TEMPLATES: Record<string, readonly string[]> = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
}
```

### 5.1 dsh-base：每一类 profile 的第一层

architecture.md 的一句话职责："`dsh-base` is the first layer of every profile: model adapters, tools, persistence, sandbox and approval policy, settings, credentials, telemetry." 它的 patch 一次 insert 出全部基础行：`llm` / `session` / `typert`、`agent-default-model`（默认 deepseek-v4-flash）、`session-persistence-jsonl`（`root: !!js dshHomePath('sessions')`）、`sandbox` / `sandbox-policy` / `approval` / `permission`、`settings` / `credentials`、`session-telemetry-otel`（默认 DISABLED）、一整套工具行（`tool-fs`、`tool-bash`、`tool-web`、`tool-subagent`、`tool-todo`、`tool-goal`、`tool-ralph`……）。设计准则是上面说过的：值随模式变的行不在 base，留给模式 bundle 复述；base 只放"每个模式都要挂、值可以是中立默认"的行。

### 5.2 dsh-web-app：加浏览器应用

"`dsh-web-app` adds the browser application"。它的 patch 分三段：先是按 id 覆盖 base 行——`system-prompt` 的 persona、`hmr` 禁用、`session-query-sqlite` 复述（维持内存索引）、`tools` 读 `DSH_TOOLS_MODE`；然后 `insert` 一长串 host 行（`webserver`、`web-runtime`、`api-gateway`、`storage-*`、`agent-presets`…）和浏览器插件 roster——`dsh.client` 行，node 半区把它们扫进 `window.__DSH_BOOT__`，浏览器半区是 shell 内核在 cordis 存在之前就构造的模块表；最后把一整套"agent 平面"工具行按 id `disabled: true`——因为 web 是每会话挂 agent preset，工具集由 preset 决定，而不是进程级统一。

### 5.3 dsh-headless：无服务器的单次运行器

"`dsh-headless` adds a one-shot runner with no server at all." 它只 insert 三行：`code-runtime`、`headless-startup`（解析 `dsh --profile headless "<task>"` 的位置参数）、`headless-runner`——注入 `headlessStartup`，从 provider 里读 task，走核心 registry 创建 Agent，跑完把持久结果打印出来。没有 Host、没有 HTTP server、没有浏览器。它和 web-app 一样覆盖 `system-prompt` persona、禁用 `hmr`。

### 5.4 对比表

| 装配 | 职责 | 适用场景 |
|---|---|---|
| `dsh-base` | 每类 profile 的第一层：模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测 | 永远在——所有 profile 都叠它 |
| `dsh-web-app` | 浏览器应用：host 行、webserver、web-runtime、浏览器插件 roster、agent presets | `dsh --profile web`：交互式浏览器界面 |
| `dsh-headless` | 无服务器单次运行器：直接 core Agent/Session，读 task 打印结果 | `dsh --profile headless "<task>"`：脚本 / CI 里的单次任务 |

### 5.5 装配的解析与叠加：profile.ts 实拍

`loadProfile` 是核心：解析 manifest、解析每个 bundle、读 patch、读用户层。摘录主体：

*来源：`packages/boot/app-boot/src/profile.ts`（loadProfile 主体）*

```ts
  const manifest = normalizeShippedProfile(name, dir, readProfileManifest(binName, dir))
  // A hand-written profile manifest may omit the dsh section entirely.
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const layers = bundles.map((packageName): ProfileLayer => {
    const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir)
    const bundleManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as ProfileManifest
    const declared = bundleManifest.dsh?.bundle?.patch
    if (declared === undefined) {
      throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)
    }
    const patchPath = join(packageDir, declared)
    return { packageName, packageDir, patchPath, patches: loadOverlayPatches(binName, patchPath) }
  })
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  const patches = options.userLayer !== false && existsSync(patchPath)
    ? loadOverlayPatches(binName, patchPath)
    : []
  return { name, dir, layers, patchPath, patches }
```

对照前面讲的机制逐行看：`normalizeShippedProfile` 把"恰好等于安装方维护的历史元组"的 bundle 列表归一化回出厂模板（profile.ts 里 `INSTALLATION_OWNED_PROFILE_TUPLES` 记录了 headless 曾经的三件套），其余任何列表都视为用户自持、原样保留；`bundles ?? []`——手写 manifest 可以完全省略 `dsh` 段；每个 bundle 名先解析目录，再读它的 package.json 拿 `dsh.bundle.patch`，缺了就 fail loud；最后用户层默认要读，但 `--dump-default-config` 这类"只看 bundle"的消费者可以跳过。

叠加本身在 `composeEntries`：

*来源：`packages/boot/app-boot/src/profile.ts`（composeEntries）*

```ts
export function composeEntries(
  layers: readonly PatchOptions[][], warn: (message: string) => void = () => {},
): EntryOptions[] {
  return applyEntryPatches([], structuredClone(layers.flat()), (message: string, ...args: unknown[]) => {
    let index = 0
    warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  })
}
```

注意两个细节：`applyEntryPatches([], ...)`——从空 entry 列表开始，这就是"从空列表到完整树"的字面实现；`structuredClone(layers.flat())`——所有层的 patch 摊平后克隆一份再应用，避免 patch 对象在多次调用间互相污染。boot、dump、flag 派生都走这一个函数，所以它们永远看到同一棵树。

---

## 六、写你自己的 patch

现在动手。你要做的：把下面内容写进 `$DSH_HOME/profiles/<name>/cordis.patch.yml`（或更靠上的 `$DSH_HOME/cordis.patch.yml`），或者用一个文件配合 `--patch <file>`。语法参照 web-app/headless 的真实写法与 README 确认的机制，标注为示例：

*示例（非仓库文件）：`$DSH_HOME/profiles/web/cordis.patch.yml`*

```yaml
# 1) 按 id 禁用一行：与 web-app patch 里 `tool-bash` 的写法同形
- id: tool-ralph
  disabled: true

# 2) 按 id 替换整行 config：整行一起换，要保留的字段必须复述
- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: /srv/workspace
```

两个例子对应 patch 的两种形态：`disabled: true` 把 base 里某个你不想要的行关掉（web-app 就是这么关掉一整批工具行的）；按 id 写 `config:` 则整行替换——注意示例里我复述了 `mode` 的默认表达式，因为不写就等于丢弃（没有 deep-merge）。`!!js` 在 patch 文件里同样可用。

写完保存，长驻表面会热重载；headless 这类单次运行则下次启动生效。剩下几条边界记住：命中的 id 不存在只警告；空文件会抛错（想关掉这层写 `[]`）；你完全可以再叠一层去覆盖你上一层的覆盖——毕竟"最后写者胜"。

---

## 七、本章小结

这一章我们把"一棵 dsh 是怎么拼出来的"讲完了：profile 是存在 Harness home 里的命名装配清单，只负责点名；bundle 是"配置行 + 代码"的分发格式，靠 `dsh.bundle.patch` 声明自己的 patch 文件；patch 是唯一的最小操作——按 id 整行替换或 insert。叠加顺序是 bundle 按列序 → profile 层 → home 层 → `--patch`，后写者胜、高层可换低层任何一行；`--dump-config` 让你看到并抄写这棵真实存在的树。

下一章我们把镜头对准这棵树的"心脏"——`agent-loop`：step 与 turn 的转动引擎。第 2 章说过事件是扩展点，第 4 章你会看到 `turn/*`、`step/*`、`agent/*` 这些事件如何驱动一次完整的 Agent 运行，以及为什么"一步"的定义能同时支撑 web 会话和 headless 单次任务。
