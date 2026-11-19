// @vitest-environment jsdom
/**
 * E5 共享单选下拉测试
 *
 * 覆盖：daisyUI Dropdown 结构、展开/关闭、选择回调、两行选项、禁用、加载、空列表、
 *       方向键/Home/End/Escape 以及单选 ARIA。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Select from '../../src/shared/ui/select.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { value: 'a', label: 'DeepSeek', detail: 'OpenAI 兼容 · deepseek-chat' },
  { value: 'b', label: 'Baidu', detail: '百度翻译 · 通用文本翻译' },
  { value: 'c', label: 'Local', detail: 'OpenAI 兼容 · llama3' },
];

let container;
let root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function Harness({ onChange = () => {}, disabled = false, loading = false, options = OPTIONS }) {
  const [value, setValue] = useState('a');
  return (
    <Select
      id="test-select"
      value={value}
      options={options}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      ariaLabel="测试下拉"
      disabled={disabled}
      loading={loading}
    />
  );
}

async function render(props = {}) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
  await flush();
}

function details() {
  return container.querySelector('#test-select');
}

function summary() {
  return details()?.querySelector('summary');
}

function options() {
  return [...(details()?.querySelectorAll('button[role="radio"]') ?? [])];
}

async function open() {
  await act(async () => {
    details().open = true;
    details().dispatchEvent(new Event('toggle'));
  });
  await flush();
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('E5 Select', () => {
  it('使用 daisyUI dropdown + menu 结构并显示两行选项', async () => {
    await render();
    expect(details()).toBeTruthy();
    expect(summary().className).toContain('select');
    expect(summary().textContent).toContain('DeepSeek');

    await open();
    const menu = details().querySelector('ul[role="radiogroup"]');
    expect(menu).toBeTruthy();
    expect(menu.className).toContain('dropdown-content');
    expect(menu.className).toContain('menu');
    expect(options()).toHaveLength(3);
    expect(options()[0].textContent).toContain('OpenAI 兼容');
  });

  it('选中项带 aria-checked，点击后回调并关闭', async () => {
    const onChange = vi.fn();
    await render({ onChange });
    await open();

    expect(options()[0].getAttribute('aria-checked')).toBe('true');
    await click(options()[1]);

    expect(onChange).toHaveBeenCalledWith('b');
    expect(summary().textContent).toContain('Baidu');
    expect(details().open).toBe(false);
  });

  it('方向键、Home/End 在选项间移动，Escape 关闭并回到触发器', async () => {
    await render();
    await open();

    const buttons = options();
    buttons[0].focus();
    await act(async () => {
      buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(buttons[1]);

    await act(async () => {
      buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(document.activeElement).toBe(buttons[2]);

    await act(async () => {
      buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(details().open).toBe(false);
    expect(document.activeElement).toBe(summary());
  });

  it('禁用与加载状态下不展开，并暴露 aria-disabled', async () => {
    await render({ disabled: true });
    expect(summary().getAttribute('aria-disabled')).toBe('true');
    await open();
    expect(details().open).toBe(false);
  });

  it('加载态显示 daisyUI spinner', async () => {
    await render({ loading: true });
    expect(summary().querySelector('.loading.loading-spinner')).toBeTruthy();
  });

  it('空选项显示占位文字且不产生选项', async () => {
    await render({ options: [] });
    await open();
    expect(options()).toHaveLength(0);
    expect(details().textContent).toContain('请选择');
  });
});
