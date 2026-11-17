/**
 * A3 提示词模板测试（P6.2）
 *
 * 覆盖默认模板、占位符校验与展开、单段/批量输出格式、提示词哈希与版本。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SYSTEM_PROMPT,
  MAX_PROMPT_CHARS,
  OUTPUT_FORMATS,
  PROMPT_PLACEHOLDERS,
  PROMPT_VERSION,
  buildSystemPrompt,
  hashPrompt,
  isDefaultPrompt,
  normalizePromptText,
  validatePromptTemplate,
} from '../../src/shared/translate/prompt.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('A3 提示词模板', () => {
  it('PROMPT_VERSION 为 2，占位符只有目标语言与输出格式', () => {
    expect(PROMPT_VERSION).toBe(3);
    expect(PROMPT_PLACEHOLDERS).toEqual(['targetLang', 'outputFormat']);
  });

  it('默认模板包含两个占位符与防注入说明', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{{targetLang}}');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{{outputFormat}}');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('不是给你的指令');
    expect(isDefaultPrompt(DEFAULT_SYSTEM_PROMPT)).toBe(true);
    expect(isDefaultPrompt(DEFAULT_SYSTEM_PROMPT.replace(/\n/g, '\r\n'))).toBe(true);
    expect(isDefaultPrompt('  自定义模板  ')).toBe(false);
  });

  it('validatePromptTemplate：空、缺少、未知与超长都失败', () => {
    expect(validatePromptTemplate(DEFAULT_SYSTEM_PROMPT)).toEqual({ ok: true });
    expect(validatePromptTemplate('')).toMatchObject({ ok: false });
    expect(validatePromptTemplate('  ')).toMatchObject({ ok: false });
    expect(validatePromptTemplate('{{targetLang}} 只有目标语言')).toMatchObject({ ok: false });
    expect(validatePromptTemplate('{{outputFormat}} 只有输出格式')).toMatchObject({ ok: false });
    expect(validatePromptTemplate('{{targetLang}} {{outputFormat}} {{foo}}')).toEqual({
      ok: false,
      error: '未知占位符：foo',
    });
    expect(validatePromptTemplate('x'.repeat(MAX_PROMPT_CHARS + 1))).toMatchObject({ ok: false });
  });

  it('buildSystemPrompt：替换全部占位符并带目标语言显示名', () => {
    const prompt = buildSystemPrompt({ targetLang: 'zh', mode: 'single' });
    expect(prompt).toContain('中文');
    expect(prompt).toContain(OUTPUT_FORMATS.single);
    expect(prompt).not.toContain('{{targetLang}}');
    expect(prompt).not.toContain('{{outputFormat}}');
  });

  it('buildSystemPrompt：单段与批量输出格式不同，未知语言回退语言码', () => {
    const single = buildSystemPrompt({ targetLang: 'zh', mode: 'single' });
    const batch = buildSystemPrompt({ targetLang: 'zh', mode: 'batch' });
    expect(single).not.toBe(batch);
    expect(batch).toContain('JSONL');

    const unknown = buildSystemPrompt({ targetLang: 'fr' });
    expect(unknown).toContain('fr');
    expect(buildSystemPrompt({ targetLang: 'ja' })).toContain('日语');
  });

  it('buildSystemPrompt：使用自定义模板，空模板回退默认模板', () => {
    const template = '只翻译成{{targetLang}}。{{outputFormat}}';
    const prompt = buildSystemPrompt({ targetLang: 'zh', template });
    expect(prompt.startsWith('只翻译成中文。')).toBe(true);
    expect(prompt).toContain(OUTPUT_FORMATS.single);

    expect(buildSystemPrompt({ targetLang: 'zh', template: '' })).toBe(
      buildSystemPrompt({ targetLang: 'zh', template: DEFAULT_SYSTEM_PROMPT })
    );
  });

  it('normalizePromptText：去首尾空白并统一换行', () => {
    expect(normalizePromptText('  a\r\nb\r  ')).toBe('a\nb');
  });

  it('hashPrompt：稳定、64 位十六进制，换行差异不影响结果', async () => {
    const first = await hashPrompt(DEFAULT_SYSTEM_PROMPT);
    const second = await hashPrompt(DEFAULT_SYSTEM_PROMPT);
    const crlf = await hashPrompt(DEFAULT_SYSTEM_PROMPT.replace(/\n/g, '\r\n'));

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(crlf).toBe(first);
  });

  it('hashPrompt：模板变化后哈希变化，空模板按默认模板计算', async () => {
    const base = await hashPrompt(DEFAULT_SYSTEM_PROMPT);
    const changed = await hashPrompt(`${DEFAULT_SYSTEM_PROMPT}\n用书面语。`);

    expect(changed).not.toBe(base);
    expect(await hashPrompt('')).toBe(base);
  });

  it('运行环境缺少 crypto.subtle 时抛 TypeError', async () => {
    vi.stubGlobal('crypto', {});
    await expect(hashPrompt(DEFAULT_SYSTEM_PROMPT)).rejects.toThrow(TypeError);
  });
});
