/**
 * C 新增实例对话框
 *
 * 模块：插件独立页面（C）/ 设置页组件
 * 职责：选择类型（OpenAI 兼容 / 百度翻译）与预设（DeepSeek / 自定义）、填写名称并创建实例；
 *       创建成功后关闭对话框并打开编辑弹窗，不自动设为当前。
 * 依赖：React、`lucide-react`、E3（instances.createInstance、registry 默认名与名称上限）、
 *       设置页共享工具与对话框/字段组件。
 * 实现阶段：P8-3（设置页内容分类与 UI 规范化）
 */

import { useState } from 'react';
import { AlertTriangle, Languages, Sparkles } from 'lucide-react';
import ConfirmDialog from './confirm-dialog.jsx';
import Field from '../../shared/ui/field.jsx';
import { PRESET_LABELS, useApp } from '../lib.js';
import { createInstance } from '../../shared/config/instances.js';
import {
  MAX_INSTANCE_NAME_CHARS,
  MAX_INSTANCES,
  getDefaultInstanceName,
  normalizeInstanceName,
} from '../../shared/config/registry.js';

/**
 * @param {{
 *   hint?: { type?: 'openai' | 'baidu', preset?: 'deepseek' | 'custom' } | null,
 *   onClose: () => void,
 * }} props
 */
export default function CreateInstance({ hint, onClose }) {
  const app = useApp();
  const [type, setType] = useState(hint?.type === 'baidu' ? 'baidu' : 'openai');
  const [preset, setPreset] = useState(hint?.preset === 'custom' ? 'custom' : 'deepseek');
  const [name, setName] = useState(() =>
    getDefaultInstanceName(hint?.type === 'baidu' ? 'baidu' : 'openai', hint?.preset ?? 'deepseek')
  );
  const [nameTouched, setNameTouched] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const atLimit = app.instances.length >= MAX_INSTANCES;

  /** 类型/预设变化时，未手动改名的名称跟着默认名走。 */
  function chooseType(nextType, nextPreset = preset) {
    setType(nextType);
    setPreset(nextPreset);
    setError(null);
    if (!nameTouched) setName(getDefaultInstanceName(nextType, nextPreset));
  }

  /**
   * 校验自定义 endpoint：创建时就必须是合法地址，否则 E3 拒绝保存。
   * @returns {string | null}
   */
  function validateCustomEndpoint() {
    const baseUrl = customBaseUrl.trim();
    if (baseUrl === '') return '请填写接口地址（baseUrl）';
    try {
      const url = new URL(baseUrl);
      const loopback =
        url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
      if (url.protocol !== 'https:' && !loopback) {
        return '接口地址需为 HTTPS 或本地回环 http://localhost / http://127.0.0.1';
      }
      if (url.search !== '' || url.hash !== '') return '接口地址不能带查询参数或片段';
    } catch {
      return '接口地址格式无效';
    }
    if (customModel.trim() === '') return '请填写模型名称';
    return null;
  }

  /** 创建实例并打开编辑弹窗。 */
  async function create() {
    const normalized = normalizeInstanceName(name);
    if (normalized === '') {
      setError('请填写实例名称');
      return;
    }
    if (normalized.length > MAX_INSTANCE_NAME_CHARS) {
      setError(`实例名称不能超过 ${MAX_INSTANCE_NAME_CHARS} 字符`);
      return;
    }
    if (
      app.instances.some(
        (instance) => String(instance.name).trim().toLowerCase() === normalized.toLowerCase()
      )
    ) {
      setError('实例名称已存在');
      return;
    }
    const customError = type === 'openai' && preset === 'custom' ? validateCustomEndpoint() : null;
    if (customError) {
      setError(customError);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const created = await app.mutate(() =>
        createInstance({
          type,
          preset: type === 'openai' ? preset : undefined,
          name: normalized,
          ...(type === 'openai' && preset === 'custom'
            ? {
                endpoint: {
                  baseUrl: customBaseUrl.trim(),
                  path: '/chat/completions',
                  query: [],
                  stream: true,
                },
                model: customModel.trim(),
              }
            : {}),
        })
      );
      app.notify('ok', `已创建实例「${normalized}」`);
      onClose();
      if (created?.id) app.openEditor(created.id);
    } catch (failure) {
      setError(failure?.message ?? '创建实例失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      title="新增翻译实例"
      description="选择类型后填写名称；创建后继续在编辑弹窗里完成连接与凭据配置。"
      confirmLabel="创建"
      busy={busy}
      confirmDisabled={atLimit}
      onConfirm={create}
      onCancel={onClose}
    >
      {atLimit ? (
        <div className="alert alert-warning">
          <AlertTriangle size={15} aria-hidden="true" />
          <span className="min-w-0 break-words">
            已达上限（{MAX_INSTANCES} 个）；删除不需要的实例后才能新增。
          </span>
        </div>
      ) : null}
      <div className="grid gap-2.5" role="group" aria-label="实例类型">
        <button
          type="button"
          className={`btn btn-outline h-auto justify-start${type === 'openai' ? ' btn-active' : ''}`}
          aria-pressed={type === 'openai'}
          onClick={() => chooseType('openai', preset)}
          disabled={busy}
        >
          <Sparkles size={16} aria-hidden="true" />
          <span>
            <span className="flex items-center gap-1.5 text-sm font-semibold">OpenAI 兼容</span>
            <span className="text-xs leading-relaxed text-base-content/60 break-words">
              chat completions、流式、JSONL 批量、可编辑提示词；自定义可接本地模型。
            </span>
          </span>
        </button>
        <button
          type="button"
          className={`btn btn-outline h-auto justify-start${type === 'baidu' ? ' btn-active' : ''}`}
          aria-pressed={type === 'baidu'}
          onClick={() => chooseType('baidu')}
          disabled={busy}
        >
          <Languages size={16} aria-hidden="true" />
          <span>
            <span className="flex items-center gap-1.5 text-sm font-semibold">百度翻译</span>
            <span className="text-xs leading-relaxed text-base-content/60 break-words">通用文本翻译、无流式、APPID + 密钥。</span>
          </span>
        </button>
      </div>

      {type === 'openai' ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold">预设</span>
          <div className="flex flex-wrap items-center gap-2">
            {['deepseek', 'custom'].map((value) => (
              <button
                key={value}
                type="button"
                className={`btn btn-sm${preset === value ? ' btn-active' : ''}`}
                aria-pressed={preset === value}
                onClick={() => chooseType('openai', value)}
                disabled={busy}
              >
                {PRESET_LABELS[value]}
              </button>
            ))}
          </div>
          <span className="text-xs leading-relaxed text-base-content/60 break-words">
            {preset === 'deepseek'
              ? '使用 DeepSeek 默认地址与模型，可再修改。'
              : '自定义 endpoint：需要填写 baseUrl 与模型，并授权接口域名。'}
          </span>
        </div>
      ) : null}

      {type === 'openai' && preset === 'custom' ? (
        <>
          <Field
            id="new-baseurl"
            label="接口地址（baseUrl）"
            required
            help="HTTPS 或本地回环地址；本地模型示例：http://localhost:11434/v1"
          >
            <input
              id="new-baseurl"
              type="url"
              className="input input-sm w-full"
              value={customBaseUrl}
              onChange={(event) => {
                setCustomBaseUrl(event.target.value);
                setError(null);
              }}
              placeholder="http://localhost:11434/v1"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </Field>
          <Field id="new-model" label="模型名称" required help="例如 llama3、qwen2.5。">
            <input
              id="new-model"
              type="text"
              className="input input-sm w-full"
              value={customModel}
              onChange={(event) => {
                setCustomModel(event.target.value);
                setError(null);
              }}
              placeholder="llama3"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </Field>
        </>
      ) : null}

      <Field id="new-name" label="名称" required error={error ?? undefined} help={`最多 ${MAX_INSTANCE_NAME_CHARS} 字符，不能重名。`}>
        <input
          id="new-name"
          type="text"
          className="input input-sm w-full"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setNameTouched(true);
            setError(null);
          }}
          autoComplete="off"
          disabled={busy}
        />
      </Field>
    </ConfirmDialog>
  );
}
