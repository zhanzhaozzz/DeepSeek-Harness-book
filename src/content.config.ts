import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const modules = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/modules' }),
  schema: z.object({
    // 章节序号（1 起）
    order: z.number(),
    title: z.string(),
    summary: z.string(),
    status: z.enum(['published', 'draft']).default('draft'),
    // 元数据：字数 / 代码行数 / 阅读分钟（draft 章可缺省，首页显示"撰写中"）
    words: z.number().optional(),
    codeLines: z.number().optional(),
    minutes: z.number().optional(),
    updated: z.string().optional(),
  }),
});

export const collections = { modules };
