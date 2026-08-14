// 重算已发布章节的元数据（字数 / 代码行数 / 阅读分钟），并写回 frontmatter。
// 用法：node scripts/meta.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../src/content/modules', import.meta.url));
const today = new Date().toISOString().slice(0, 10);

for (const name of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
  const path = join(dir, name);
  const text = readFileSync(path, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) continue;
  const fmRaw = m[1];
  const body = m[2];
  if (!fmRaw.includes('status: published')) continue;

  const prose = body.replace(/```[\s\S]*?```/g, '');
  const cjk = (prose.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  const latin = (prose.match(/[A-Za-z0-9_][A-Za-z0-9_\-.]+/g) ?? []).length;
  const words = cjk + latin;

  const codeBlocks = [...body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  const codeLines = codeBlocks.reduce(
    (n, b) => n + b[1].replace(/\n$/, '').split('\n').length,
    0,
  );
  const minutes = Math.max(1, Math.round(words / 200));

  const kept = fmRaw
    .split('\n')
    .filter((l) => !['words', 'codeLines', 'minutes', 'updated'].includes(l.split(':')[0].trim()));
  kept.push(`words: ${words}`, `codeLines: ${codeLines}`, `minutes: ${minutes}`, `updated: "${today}"`);
  writeFileSync(path, `---\n${kept.join('\n')}\n---\n${body}`, 'utf8');
  console.log(`${name}: words=${words} codeLines=${codeLines} minutes=${minutes}`);
}
