// @ts-check
import { defineConfig } from 'astro/config';

// 代码高亮主题：恒为深色，配色移植自参考站 Pi Agent Book 的代码块。
// TextMate scope 规则（近似即可，覆盖 TS/JS/YAML/Shell 常见 token）。
const dshCodeTheme = {
  name: 'dsh-code',
  type: 'dark',
  colors: {
    'editor.background': '#1e2130',
    'editor.foreground': '#e8eaf2',
  },
  tokenColors: [
    { scope: ['comment'], settings: { foreground: '#6b7089', fontStyle: 'italic' } },
    { scope: ['keyword', 'storage', 'keyword.control', 'keyword.operator', 'keyword.other.special-method'], settings: { foreground: '#c792ea' } },
    { scope: ['string', 'string.template', 'string.regexp', 'string.quoted'], settings: { foreground: '#c3e88d' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other'], settings: { foreground: '#f78c6c' } },
    { scope: ['entity.name.function', 'support.function', 'entity.name.class', 'entity.name.type'], settings: { foreground: '#82aaff' } },
    { scope: ['entity.name.tag', 'tag', 'meta.tag'], settings: { foreground: '#f07178' } },
    { scope: ['support.constant', 'constant.other.color', 'markup.constant'], settings: { foreground: '#ffcb6b' } },
    { scope: ['variable', 'variable.other', 'meta.parameter', 'parameter'], settings: { foreground: '#e8eaf2' } },
    { scope: ['punctuation', 'punctuation.definition', 'punctuation.separator'], settings: { foreground: '#9aa5ce' } },
    { scope: ['markup.heading'], settings: { foreground: '#82aaff' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.link', 'meta.link'], settings: { foreground: '#82aaff' } },
  ],
};

// https://astro.build/config
export default defineConfig({
  // 部署到 Vercel 后替换为你自己的域名（可选；站内链接均为绝对路径，不依赖它）
  site: 'https://dsh-book.vercel.app',
  output: 'static',
  trailingSlash: 'ignore',
  markdown: {
    shikiConfig: {
      theme: dshCodeTheme,
      wrap: true,
    },
  },
});
