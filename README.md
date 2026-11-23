# dsh-book · DeepSeek Harness 源码精读笔记

> **历史存档（官方 0.1.0-rc.6）。** 本仓库与[线上站点](https://deep-seek-harness-book.vercel.app/)保留的是旧版笔记，章节页面仍可阅读。当前笔记（17 章，对照官方 `dsh-v0.2.3-alpha.2`）在 [deepseek-harness-book-v2.vercel.app](https://deepseek-harness-book-v2.vercel.app)。

一个静态学习网站：以"书"的形式逐章精读 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码。
设计语言参考 [Pi Agent Book](https://dg-ai-notes.pages.dev/)（源码精读笔记），强调色替换为 DeepSeek 品牌蓝。

- 技术栈：Astro（`output: 'static'`，构建产物为纯静态 HTML）
- 章节内容：`src/content/modules/*.md`（Markdown + frontmatter）
- 站点是独立的 npm 项目，不在仓库根 pnpm workspace 的 glob 范围内

## 本地开发

```sh
npm install
npm run dev        # http://localhost:4321
npm run build      # 产出 dist/
npm run preview    # 本地预览构建产物
```

## 章节写作约定

每章一个 Markdown 文件：`src/content/modules/chNN-<slug>.md`。

frontmatter 字段：

| 字段 | 说明 |
|---|---|
| `order` | 章节序号（1 起，渲染为 M01、M02…） |
| `title` | 章标题 |
| `summary` | 卡片与页面头部显示的摘要 |
| `status` | `published`（发布）/ `draft`（撰写中，卡片显示"撰写中"徽标） |
| `words` / `codeLines` / `minutes` | 元数据：字数 / 代码行数 / 阅读分钟（仅 published 需要） |
| `updated` | 更新日期 |

元数据可用以下命令重算并写回 frontmatter（仅 published 章）：

```sh
node scripts/meta.mjs
```

写作要求：代码摘录必须逐字来自仓库源码并标注来源路径；事实以仓库 `docs/` 为准。

## 部署到 Vercel

1. 把本仓库导入 Vercel（或只导入这个子目录对应的 Git 仓库）。
2. Project 设置里 **Root Directory** 填 `dsh-book`。
3. Vercel 会自动识别 Astro：build 命令 `npm run build`，输出目录 `dist/`。也可以手动指定：
   - Build Command：`npm run build`
   - Output Directory：`dist`
4. 部署后如需自定义域名，改 `astro.config.mjs` 里的 `site` 字段并重新部署。

`vercel.json` 只是开启了 `cleanUrls`（去掉 `.html` 后缀访问），可按需删除。

## 目录结构

```
dsh-book/
├── astro.config.mjs          # 静态输出 + Shiki 自定义代码主题
├── vercel.json
├── public/favicon.svg
└── src/
    ├── content.config.ts     # 章节集合 schema
    ├── content/modules/      # 每章一个 Markdown
    ├── styles/global.css     # 设计系统（DeepSeek 蓝 + 参考站 token）
    ├── layouts/              # Base / ModuleLayout
    ├── components/           # Topbar、TOC、大纲、上下章、章节卡片等
    └── pages/                # 首页、/modules/[slug]、404
```
