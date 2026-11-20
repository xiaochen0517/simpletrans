// @vitest-environment jsdom
/**
 * E5 Button / Toggle 组件测试
 *
 * 覆盖：按钮变体与尺寸、加载/禁用、默认 type；开关选中态、变更回调、禁用与可访问名称。
 * 使用 react-dom/client + act，不引入 Testing Library。
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Button from '../../src/shared/ui/button.jsx';
import Toggle from '../../src/shared/ui/toggle.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

async function render(node) {
  await act(async () => {
    root.render(node);
  });
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

describe('E5 Button', () => {
  it('默认次要按钮，主按钮使用 indigo，点击触发回调', async () => {
    const onClick = vi.fn();
    await render(
      <Button variant="primary" onClick={onClick}>
        翻译整页
      </Button>
    );

    const button = container.querySelector('button');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('bg-indigo-600');
    expect(button.className).toContain('rounded-lg');
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);

    await render(<Button>取消</Button>);
    expect(container.querySelector('button').className).toContain('border-gray-300');
  });

  it('加载态显示 spinner 并禁用', async () => {
    await render(
      <Button variant="primary" busy>
        正在提交…
      </Button>
    );

    const button = container.querySelector('button');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.animate-spin')).toBeTruthy();
  });

  it('图标按钮使用方形内边距', async () => {
    await render(
      <Button variant="ghost" iconOnly aria-label="关闭">
        ×
      </Button>
    );

    const button = container.querySelector('button');
    expect(button.className).toContain('p-1.5');
    expect(button.getAttribute('aria-label')).toBe('关闭');
  });
});

describe('E5 Toggle', () => {
  it('选中态使用 indigo 轨道，点击触发变更回调', async () => {
    const onChange = vi.fn();
    await render(<Toggle checked={false} onChange={onChange} ariaLabel="启用译文缓存" />);

    const label = container.querySelector('label[data-slot="toggle"]');
    expect(label.getAttribute('data-checked')).toBe('false');
    expect(label.className).toContain('bg-gray-300');

    const input = container.querySelector('input[type="checkbox"]');
    expect(input.getAttribute('aria-label')).toBe('启用译文缓存');
    await act(async () => {
      input.click();
    });
    expect(onChange).toHaveBeenCalledWith(true);

    await render(<Toggle checked onChange={() => {}} ariaLabel="已开启" />);
    expect(container.querySelector('label[data-slot="toggle"]').className).toContain(
      'bg-indigo-600'
    );
  });

  it('禁用态不可点击并降低透明度', async () => {
    const onChange = vi.fn();
    await render(
      <Toggle checked={false} onChange={onChange} disabled ariaLabel="启用扩展" />
    );

    const input = container.querySelector('input[type="checkbox"]');
    expect(input.disabled).toBe(true);
    expect(container.querySelector('label[data-slot="toggle"]').className).toContain(
      'opacity-50'
    );
  });
});
