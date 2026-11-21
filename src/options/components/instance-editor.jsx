/**
 * C 实例编辑弹窗
 *
 * 模块：插件独立页面（C）/ 设置页组件
 * 职责：按类型编辑一个已保存实例：基础信息、连接（baseUrl/path/query/stream）、认证、模型、
 *       生成参数（temperature/top_p/max_tokens/思考强度/额外参数）、批次与并发（含百度接口 QPS）、
 *       两套提示词（默认翻译 / 快速翻译）与凭据；域名权限在保存手势内按需申请；未保存离开需确认。
 * 依赖：React、`lucide-react`、E3（instances CRUD、registry 校验常量、openai 配置）、
 *       设置页共享工具与字段/徽标/对话框组件。
 *
 * 本组件不读取凭据明文：凭据输入框始终为空，占位文字说明「留空表示不修改」。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import Field, { describedBy } from '../../shared/ui/field.jsx';
import StatusBadge from '../../shared/ui/status-badge.jsx';
import Select from '../../shared/ui/select.jsx';
import ConfirmDialog from './confirm-dialog.jsx';
import Toggle from '../../shared/ui/toggle.jsx';
import { buttonClass } from '../../shared/ui/button.jsx';
import {
  AUTH_LABELS,
  PRESET_LABELS,
  REASONING_MODE_LABELS,
  credentialState,
  hostOf,
  instanceEligibility,
  requestOriginPermission,
  typeBadgeLabel,
  useApp,
} from '../lib.js';
import {
  removeCredentials,
  setActiveInstance,
  updateInstance,
  writeCredentials,
} from '../../shared/config/instances.js';
import {
  BAIDU_BATCH_MAX_CHARS,
  BAIDU_BATCH_SIZE,
  BAIDU_MAX_CONCURRENCY,
  BAIDU_QPS,
  DEFAULT_QUICK_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  MAX_INSTANCE_NAME_CHARS,
  MAX_MODEL_CHARS,
  MAX_PROMPT_CHARS,
  MIN_BATCH_SIZE,
  validatePromptTemplate,
} from '../../shared/config/registry.js';
import {
  AUTH_TYPES,
  MAX_TOKEN_FIELDS,
  REASONING_MODES,
  createOpenAIConfig,
} from '../../shared/config/openai.js';
import { getOriginPattern } from '../../shared/config/host-permission.js';

/** 额外参数可选值类型。 */
const EXTRA_TYPES = Object.freeze(['string', 'number', 'boolean', 'json']);

/** 合法额外参数路径。 */
const FIELD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*){0,5}$/;

/** 可获得焦点的元素选择器（与对话框一致）。 */
const FOCUSABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 复制键值行列表。
 * @param {unknown} rows
 * @returns {Array<{ name: string, value: string }>}
 */
function toPairRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    name: String(row?.name ?? ''),
    value: String(row?.value ?? ''),
  }));
}

/**
 * 复制额外参数列表。
 * @param {unknown} rows
 */
function toExtraRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    path: String(row?.path ?? ''),
    type: EXTRA_TYPES.includes(row?.type) ? row.type : 'string',
    value: String(row?.value ?? ''),
    enabled: row?.enabled === true,
  }));
}

/**
 * 把公开实例转成可编辑草稿；凭据字段不进入草稿。
 * @param {Record<string, any>} instance
 */
export function toDraft(instance) {
  const params = instance.params ?? {};
  const reasoning = params.reasoning ?? {};
  const isOpenAI = instance.type === 'openai';
  return {
    type: instance.type,
    name: String(instance.name ?? ''),
    enabled: instance.enabled !== false,
    preset: instance.preset ?? 'custom',
    baseUrl: String(instance.endpoint?.baseUrl ?? ''),
    path: String(instance.endpoint?.path ?? '/chat/completions'),
    query: toPairRows(instance.endpoint?.query),
    stream: instance.endpoint?.stream !== false,
    authType: AUTH_TYPES.includes(instance.auth?.type) ? instance.auth.type : 'bearer',
    authHeaderName: String(instance.auth?.headerName ?? ''),
    authPrefix: String(instance.auth?.prefix ?? ''),
    authQueryName: String(instance.auth?.queryName ?? ''),
    headers: toPairRows(instance.headers),
    model: String(instance.model ?? ''),
    temperatureEnabled: params.temperature?.enabled === true,
    temperature: String(params.temperature?.value ?? 1),
    topPEnabled: params.topP?.enabled === true,
    topP: String(params.topP?.value ?? 1),
    maxTokensEnabled: params.maxTokens?.enabled === true,
    maxTokensField: MAX_TOKEN_FIELDS.includes(params.maxTokens?.field)
      ? params.maxTokens.field
      : 'max_tokens',
    maxTokens: String(params.maxTokens?.value ?? 2048),
    reasoningMode: REASONING_MODES.includes(reasoning.mode) ? reasoning.mode : 'none',
    reasoningField: String(reasoning.field ?? ''),
    reasoningValue: String(reasoning.value ?? ''),
    reasoningValues: Array.isArray(reasoning.values) ? [...reasoning.values] : [],
    reasoningBudgetField: String(reasoning.budgetField ?? ''),
    reasoningBudget: String(reasoning.budget ?? 1024),
    reasoningToggleField: String(reasoning.toggleField ?? ''),
    reasoningOn: String(reasoning.onValue ?? ''),
    reasoningOff: String(reasoning.offValue ?? ''),
    extra: toExtraRows(params.extra),
    batchSize: String(instance.batchSize ?? (isOpenAI ? 8 : 8)),
    batchMaxChars: String(instance.batchMaxChars ?? 1000),
    maxConcurrency: String(instance.maxConcurrency ?? (isOpenAI ? 4 : 1)),
    qps: String(instance.qps ?? 1),
    systemPrompt: String(instance.systemPrompt ?? DEFAULT_SYSTEM_PROMPT),
    quickPrompt: String(instance.quickPrompt ?? DEFAULT_QUICK_PROMPT),
  };
}

/**
 * 判断两个草稿是否一致（用于未保存提示）。
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 * @returns {boolean}
 */
function sameDraft(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 校验草稿；返回字段级错误对象，空对象表示通过。
 * @param {Record<string, any>} draft
 * @param {Array<Record<string, any>>} instances 用于名称唯一校验
 * @param {string} selfId
 * @returns {Record<string, string>}
 */
function validateDraft(draft, instances, selfId) {
  const errors = {};
  const name = draft.name.trim();
  if (name === '') errors.name = '请填写实例名称';
  else if (name.length > MAX_INSTANCE_NAME_CHARS) {
    errors.name = `实例名称不能超过 ${MAX_INSTANCE_NAME_CHARS} 字符`;
  } else if (
    instances.some(
      (instance) => instance.id !== selfId && String(instance.name).trim().toLowerCase() === name.toLowerCase()
    )
  ) {
    errors.name = '实例名称已存在';
  }

  if (draft.type === 'openai') {
    const baseUrl = draft.baseUrl.trim();
    if (baseUrl === '') {
      errors.baseUrl = '请填写接口地址';
    } else {
      try {
        const url = new URL(baseUrl);
        const loopback =
          url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
        if (url.protocol !== 'https:' && !loopback) {
          errors.baseUrl = '接口地址需为 HTTPS 或本地回环 http://localhost / http://127.0.0.1';
        } else if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
          errors.baseUrl = '接口地址不能带账号密码、查询参数或片段，请把参数填到「查询参数」';
        }
      } catch {
        errors.baseUrl = '接口地址格式无效';
      }
    }

    if (!draft.path.trim().startsWith('/')) errors.path = '接口路径需以 / 开头';

    draft.query.forEach((row, index) => {
      if (row.name.trim() === '' && row.value.trim() !== '') {
        errors.query = errors.query ?? `第 ${index + 1} 个查询参数缺少名称`;
      }
    });
    draft.headers.forEach((row, index) => {
      if (row.name.trim() === '' && row.value.trim() !== '') {
        errors.headers = errors.headers ?? `第 ${index + 1} 个请求头缺少名称`;
      }
    });

    if (draft.authType === 'header' && draft.authHeaderName.trim() === '') {
      errors.authHeaderName = '请填写认证请求头名称';
    }
    if (draft.authType === 'query' && draft.authQueryName.trim() === '') {
      errors.authQueryName = '请填写认证查询参数名';
    }

    const model = draft.model.trim();
    if (model === '') errors.model = '请填写模型名称';
    else if (model.length > MAX_MODEL_CHARS) errors.model = `模型名称不能超过 ${MAX_MODEL_CHARS} 字符`;

    if (draft.temperatureEnabled) {
      const value = Number(draft.temperature);
      if (!Number.isFinite(value) || value < 0 || value > 2) {
        errors.temperature = 'temperature 需为 0–2 之间的数字';
      }
    }
    if (draft.topPEnabled) {
      const value = Number(draft.topP);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        errors.topP = 'top_p 需为 0–1 之间的数字';
      }
    }
    if (draft.maxTokensEnabled) {
      const value = Number(draft.maxTokens);
      if (!Number.isInteger(value) || value < 1) errors.maxTokens = 'max_tokens 需为正整数';
    }

    if (draft.reasoningMode === 'effort') {
      if (draft.reasoningField.trim() === '') errors.reasoningField = '请填写思考强度字段';
      if (draft.reasoningValue.trim() === '') errors.reasoningValue = '请填写思考强度取值';
    } else if (draft.reasoningMode === 'budget') {
      if (draft.reasoningBudgetField.trim() === '') errors.reasoningBudgetField = '请填写思考预算字段';
      const budget = Number(draft.reasoningBudget);
      if (!Number.isInteger(budget) || budget < 1) errors.reasoningBudget = '思考预算需为正整数';
    } else if (draft.reasoningMode === 'toggle') {
      if (draft.reasoningToggleField.trim() === '') errors.reasoningToggleField = '请填写思考开关字段';
      if (draft.reasoningOn.trim() === '') errors.reasoningOn = '请填写开关开启值';
    }

    draft.extra.forEach((row, index) => {
      if (!row.enabled) return;
      const path = row.path.trim();
      if (!FIELD_PATH_PATTERN.test(path)) {
        errors.extra = errors.extra ?? `第 ${index + 1} 个额外参数路径无效`;
        return;
      }
      if (['messages', 'model', 'stream'].includes(path.split('.')[0])) {
        errors.extra = errors.extra ?? `额外参数不能覆盖保留字段：${path}`;
      } else if (row.type === 'number' && !Number.isFinite(Number(row.value))) {
        errors.extra = errors.extra ?? `额外参数 ${path} 必须是数字`;
      } else if (row.type === 'boolean' && !['true', 'false'].includes(row.value)) {
        errors.extra = errors.extra ?? `额外参数 ${path} 必须是 true 或 false`;
      } else if (row.type === 'json') {
        try {
          JSON.parse(row.value);
        } catch {
          errors.extra = errors.extra ?? `额外参数 ${path} 不是合法 JSON`;
        }
      }
    });

    const promptCheck = validatePromptTemplate(draft.systemPrompt);
    if (!promptCheck.ok) errors.systemPrompt = promptCheck.error;
    const quickPromptCheck = validatePromptTemplate(draft.quickPrompt);
    if (!quickPromptCheck.ok) errors.quickPrompt = `快速翻译提示词：${quickPromptCheck.error}`;
  }

  const batchLimits =
    draft.type === 'baidu'
      ? {
          batchSize: BAIDU_BATCH_SIZE.max,
          batchMaxChars: BAIDU_BATCH_MAX_CHARS.max,
          maxConcurrency: BAIDU_MAX_CONCURRENCY.max,
        }
      : {};

  const batchSize = Number(draft.batchSize);
  if (!Number.isInteger(batchSize) || batchSize < MIN_BATCH_SIZE) {
    errors.batchSize = '单批段数必须是正整数';
  } else if (batchLimits.batchSize != null && batchSize > batchLimits.batchSize) {
    errors.batchSize = `单批段数不能超过 ${batchLimits.batchSize}`;
  }

  const batchMaxChars = Number(draft.batchMaxChars);
  if (!Number.isInteger(batchMaxChars) || batchMaxChars < 1) {
    errors.batchMaxChars = '批次最大字符数必须是正整数';
  } else if (batchLimits.batchMaxChars != null && batchMaxChars > batchLimits.batchMaxChars) {
    errors.batchMaxChars = `批次最大字符数不能超过 ${batchLimits.batchMaxChars}`;
  }

  const maxConcurrency = Number(draft.maxConcurrency);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    errors.maxConcurrency = '最大并发数必须是正整数';
  } else if (batchLimits.maxConcurrency != null && maxConcurrency > batchLimits.maxConcurrency) {
    errors.maxConcurrency = `最大并发数不能超过 ${batchLimits.maxConcurrency}`;
  }

  if (draft.type === 'baidu') {
    const qps = Number(draft.qps);
    if (!Number.isInteger(qps) || qps < BAIDU_QPS.min || qps > BAIDU_QPS.max) {
      errors.qps = `接口 QPS 必须是 ${BAIDU_QPS.min}–${BAIDU_QPS.max} 的整数`;
    }
  }

  return errors;
}

/**
 * 由草稿构造实例补丁；不改动凭据。
 * @param {Record<string, any>} draft
 * @returns {Record<string, any>}
 */
export function toInstancePatch(draft) {
  const patch = {
    name: draft.name.trim(),
    enabled: draft.enabled,
    batchSize: Number(draft.batchSize),
    batchMaxChars: Number(draft.batchMaxChars),
    maxConcurrency: Number(draft.maxConcurrency),
  };
  if (draft.type !== 'openai') {
    return draft.type === 'baidu' ? { ...patch, qps: Number(draft.qps) } : patch;
  }

  return {
    ...patch,
    preset: draft.preset,
    endpoint: {
      baseUrl: draft.baseUrl.trim(),
      path: draft.path.trim(),
      query: draft.query
        .filter((row) => row.name.trim() !== '')
        .map((row) => ({ name: row.name.trim(), value: row.value.trim() })),
      stream: draft.stream,
    },
    auth: {
      type: draft.authType,
      headerName: draft.authHeaderName.trim(),
      prefix: draft.authPrefix,
      queryName: draft.authQueryName.trim(),
    },
    headers: draft.headers
      .filter((row) => row.name.trim() !== '')
      .map((row) => ({ name: row.name.trim(), value: row.value.trim() })),
    model: draft.model.trim(),
    params: {
      temperature: { enabled: draft.temperatureEnabled, value: Number(draft.temperature) },
      topP: { enabled: draft.topPEnabled, value: Number(draft.topP) },
      maxTokens: {
        enabled: draft.maxTokensEnabled,
        field: draft.maxTokensField,
        value: Number(draft.maxTokens),
      },
      reasoning: {
        mode: draft.reasoningMode,
        field: draft.reasoningField.trim(),
        value: draft.reasoningValue,
        values: draft.reasoningValues,
        budgetField: draft.reasoningBudgetField.trim(),
        budget: Number(draft.reasoningBudget),
        toggleField: draft.reasoningToggleField.trim(),
        onValue: draft.reasoningOn,
        offValue: draft.reasoningOff,
      },
      extra: draft.extra
        .filter((row) => row.path.trim() !== '')
        .map((row) => ({
          path: row.path.trim(),
          type: row.type,
          value: row.value,
          enabled: row.enabled,
        })),
    },
    systemPrompt: draft.systemPrompt,
    quickPrompt: draft.quickPrompt,
  };
}

/**
 * 设置页实例编辑弹窗。
 * @param {{
 *   instance: Record<string, any>,
 *   active: boolean,
 *   externalChange?: boolean,
 *   onClose: () => void,
 *   onDirtyChange?: (dirty: boolean) => void,
 * }} props
 */
export default function InstanceEditor({
  instance,
  active,
  externalChange = false,
  onClose,
  onDirtyChange,
}) {
  const app = useApp();
  const [draft, setDraft] = useState(() => toDraft(instance));
  const [initialDraft] = useState(() => toDraft(instance));
  const [errors, setErrors] = useState({});
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [permission, setPermission] = useState(instance.permission ?? 'missing');
  const [apiKey, setApiKey] = useState('');
  const [appId, setAppId] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(externalChange);
  const promptRef = useRef(null);
  const quickPromptRef = useRef(null);
  const modalRef = useRef(null);
  const askedOriginsRef = useRef(new Set());

  const isOpenAI = instance.type === 'openai';
  const credentials = credentialState(instance);
  const requiresKey = isOpenAI ? draft.authType !== 'none' : true;
  const credentialFilled =
    isOpenAI ? apiKey.trim() !== '' : appId.trim() !== '' || secretKey.trim() !== '';
  const draftDirty = !sameDraft(draft, initialDraft) || credentialFilled;
  const dirty = draftDirty;

  const eligibility = instanceEligibility({ ...instance, hasKey: instance.hasKey, enabled: draft.enabled });
  const canSetActive = !active && eligibility.ok;
  const hostedOnOrigin = isOpenAI ? hostOf(draft.baseUrl) : '';
  const originPattern = isOpenAI ? getOriginPattern(draft.baseUrl) : null;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (externalChange) setConflictOpen(true);
  }, [externalChange]);

  /** 关闭前检查未保存修改。 */
  const requestClose = useCallback(() => {
    if (!dirty) {
      onClose();
      return;
    }
    setConfirmDiscard(true);
  }, [dirty, onClose]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (confirmDiscard || confirmClear) return;
      event.stopPropagation();
      requestClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [confirmClear, confirmDiscard, requestClose]);

  // 打开时焦点进入名称输入框，关闭后回到触发元素。
  useEffect(() => {
    const previous = typeof document !== 'undefined' ? document.activeElement : null;
    const first = modalRef.current?.querySelector('#ed-name');
    if (first && typeof first.focus === 'function') first.focus();
    return () => {
      if (previous && typeof previous.focus === 'function' && previous.isConnected !== false) {
        try {
          previous.focus();
        } catch {
          // 触发元素已移除时忽略。
        }
      }
    };
  }, []);

  // 弹窗内 Tab 循环；嵌套确认弹窗打开时交给弹窗自己处理。
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Tab' || !modalRef.current) return;
      if (confirmDiscard || confirmClear) return;
      const items = [...modalRef.current.querySelectorAll(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [confirmClear, confirmDiscard]);

  /**
   * 更新草稿的一个字段，并清掉该字段的错误。
   * @param {string} key
   * @param {unknown} value
   */
  function update(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setSaveError(null);
  }

  /** 切换预设：DeepSeek 套用预设默认值，自定义保留当前配置。 */
  function switchPreset(preset) {
    if (preset === draft.preset) return;
    if (preset === 'deepseek') {
      const defaults = createOpenAIConfig('deepseek');
      setDraft((current) => ({
        ...current,
        preset,
        baseUrl: defaults.endpoint.baseUrl,
        path: defaults.endpoint.path,
        query: toPairRows(defaults.endpoint.query),
        stream: defaults.endpoint.stream,
        authType: defaults.auth.type,
        authHeaderName: defaults.auth.headerName,
        authPrefix: defaults.auth.prefix,
        authQueryName: defaults.auth.queryName,
        headers: toPairRows(defaults.headers),
        model: defaults.model,
        temperatureEnabled: defaults.params.temperature.enabled,
        temperature: String(defaults.params.temperature.value),
        topPEnabled: defaults.params.topP.enabled,
        topP: String(defaults.params.topP.value),
        maxTokensEnabled: defaults.params.maxTokens.enabled,
        maxTokensField: defaults.params.maxTokens.field,
        maxTokens: String(defaults.params.maxTokens.value),
        reasoningMode: defaults.params.reasoning.mode,
        reasoningField: defaults.params.reasoning.field,
        reasoningValue: defaults.params.reasoning.value,
        reasoningValues: [...defaults.params.reasoning.values],
        reasoningBudgetField: defaults.params.reasoning.budgetField,
        reasoningBudget: String(defaults.params.reasoning.budget),
        reasoningToggleField: defaults.params.reasoning.toggleField,
        reasoningOn: defaults.params.reasoning.onValue,
        reasoningOff: defaults.params.reasoning.offValue,
        extra: toExtraRows(defaults.params.extra),
      }));
      setErrors({});
      setSaveError(null);
      return;
    }
    update('preset', 'custom');
  }

  /**
   * 在指定提示词文本域的光标处插入占位符。
   * @param {'systemPrompt'|'quickPrompt'} field
   * @param {{ current: HTMLTextAreaElement | null }} ref
   * @param {string} token
   */
  function insertPromptToken(field, ref, token) {
    const current = String(draft[field] ?? '');
    const element = ref.current;
    const start = Number.isInteger(element?.selectionStart) ? element.selectionStart : current.length;
    const end = Number.isInteger(element?.selectionEnd) ? element.selectionEnd : start;
    const next = `${current.slice(0, start)}${token}${current.slice(end)}`;
    update(field, next);
    const placeCursor = () => {
      const target = ref.current;
      if (!target) return;
      target.focus();
      try {
        target.setSelectionRange(start + token.length, start + token.length);
      } catch {
        // 控件不可选中时忽略。
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(placeCursor);
    else setTimeout(placeCursor, 0);
  }

  /** 授权访问当前 endpoint 域名（用户手势内调用）。 */
  async function authorize() {
    setAuthorizing(true);
    const result = await requestOriginPermission(draft.baseUrl);
    setAuthorizing(false);
    if (result.ok) {
      setPermission('granted');
      await app.refreshInstances();
      app.notify('ok', '已获得接口域名授权');
    } else {
      app.notify('error', result.message ?? '未获得域名授权');
    }
  }

  /** 清除该实例凭据（二次确认）。 */
  async function clearCredentials() {
    setClearing(true);
    try {
      await app.mutate(() => removeCredentials(instance.id));
      setApiKey('');
      setAppId('');
      setSecretKey('');
      setConfirmClear(false);
      app.notify('ok', '已清除该实例的凭据');
    } catch {
      app.notify('error', '清除凭据失败，请重试');
    } finally {
      setClearing(false);
    }
  }

  /** 设为当前翻译方式。 */
  async function makeActive() {
    try {
      await app.mutate(() => setActiveInstance(instance.id));
      app.notify('ok', '已切换当前翻译实例；只影响之后提交的段落');
    } catch (error) {
      app.notify('error', error?.message ?? '切换当前实例失败，请重试');
    }
  }

  /** 保存实例与凭据。 */
  async function save() {
    if (saving) return;
    const nextErrors = validateDraft(draft, app.instances, instance.id);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setSaveError(null);
      app.notify('error', '请先修正表单中的错误');
      return;
    }
    setErrors({});
    setSaveError(null);
    setSaving(true);

    // 权限申请必须在用户手势里发起：放在任何 await 之前；同一 origin 每次编辑只询问一次。
    let permissionDenied = false;
    const needsPermission =
      isOpenAI &&
      originPattern != null &&
      permission !== 'granted' &&
      !askedOriginsRef.current.has(originPattern);
    if (needsPermission) {
      askedOriginsRef.current.add(originPattern);
      const result = await requestOriginPermission(draft.baseUrl);
      permissionDenied = !result.ok;
      if (result.ok) setPermission('granted');
    }

    try {
      await app.mutate(() => updateInstance(instance.id, toInstancePatch(draft)));
    } catch (error) {
      const message = String(error?.message ?? '');
      if (message.includes('名称已存在')) setErrors({ name: '实例名称已存在' });
      else setSaveError(message || '保存失败，未写入任何更改。请重试。');
      setSaving(false);
      return;
    }

    if (credentialFilled) {
      const payload = isOpenAI
        ? { apiKey: apiKey.trim() }
        : { appId: appId.trim(), secretKey: secretKey.trim() };
      try {
        await app.mutate(() => writeCredentials(instance.id, payload));
        setApiKey('');
        setAppId('');
        setSecretKey('');
      } catch {
        setSaving(false);
        setSaveError('实例已保存，但凭据保存失败；请重新填写凭据后保存。');
        return;
      }
    }

    setSaving(false);
    app.notify(
      permissionDenied ? 'info' : 'ok',
      permissionDenied ? '已保存；接口域名未授权，翻译前请先授权' : '已保存'
    );
    app.recordAction(`保存实例「${draft.name.trim() || instance.name}」`);
    onClose();
  }

  const batchLimitText =
    instance.type === 'baidu'
      ? `百度翻译单批 ${BAIDU_BATCH_SIZE.min}–${BAIDU_BATCH_SIZE.max} 段、批次字符 ≤ ${BAIDU_BATCH_MAX_CHARS.max}、并发 ${BAIDU_MAX_CONCURRENCY.min}–${BAIDU_MAX_CONCURRENCY.max}。`
      : '所有大模型实例固定使用 JSONL 批量；批次与并发只影响调度，不进入缓存 key。';

  const promptCount = draft.systemPrompt.length;
  const quickPromptCount = draft.quickPrompt.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 dark:bg-black/70" data-slot="dialog-overlay">
      <div
        className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-4xl flex-col overflow-hidden rounded-lg bg-white p-0 shadow-lg dark:bg-gray-900"
        data-slot="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-title"
        ref={modalRef}
      >
        <header className="flex items-start gap-2.5 border-b border-gray-200 dark:border-gray-700 p-4">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-base font-bold break-words" id="editor-title">
              {draft.name.trim() || instance.name}
            </h2>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge tone="primary">{typeBadgeLabel(instance)}</StatusBadge>
              {active ? <StatusBadge tone="primary">当前</StatusBadge> : null}
              {dirty ? <StatusBadge tone="warn">有未保存更改</StatusBadge> : null}
            </div>
          </div>
          <button
            type="button"
            className={buttonClass({ variant: 'ghost', iconOnly: true })}
            onClick={requestClose}
            aria-label="关闭编辑弹窗"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {conflictOpen && !dirty ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" role="status">
              <AlertTriangle size={15} aria-hidden="true" />
              <span className="min-w-0 break-words">该实例已在别处更新。</span>
              <span className="ml-auto shrink-0">
                <button
                  type="button"
                  className={buttonClass({ size: 'xs' })}
                  onClick={() => {
                    setDraft(toDraft(instance));
                    setPermission(instance.permission ?? 'missing');
                    setConflictOpen(false);
                  }}
                >
                  重新加载
                </button>
              </span>
            </div>
          ) : null}

          {conflictOpen && dirty ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" role="status">
              <AlertTriangle size={15} aria-hidden="true" />
              <span className="min-w-0 break-words">
                该实例已在别处更新。当前草稿不会被覆盖；重新加载会丢弃草稿。
              </span>
              <span className="ml-auto shrink-0">
                <button
                  type="button"
                  className={buttonClass({ size: 'xs' })}
                  onClick={() => {
                    setDraft(toDraft(instance));
                    setPermission(instance.permission ?? 'missing');
                    setConflictOpen(false);
                  }}
                >
                  重新加载
                </button>
              </span>
            </div>
          ) : null}

          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">基础信息</h3>
            <Field
              id="ed-name"
              label="名称"
              required
              error={errors.name}
              help={`最多 ${MAX_INSTANCE_NAME_CHARS} 字符，不能与其它实例重名。`}
            >
              <input
                id="ed-name"
                type="text"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                value={draft.name}
                onChange={(event) => update('name', event.target.value)}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={describedBy('ed-name', {
                  error: errors.name,
                  help: `最多 ${MAX_INSTANCE_NAME_CHARS} 字符，不能与其它实例重名。`,
                })}
                disabled={saving}
                autoComplete="off"
              />
            </Field>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex items-center gap-2 text-sm">
                  <Toggle
                    checked={draft.enabled}
                    onChange={(value) => update('enabled', value)}
                    ariaLabel="启用该实例"
                    disabled={saving}
                  />
                  <span>启用该实例</span>
                </div>
              <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">停用后不会用于翻译，已打开页面需重新提交。</span>
            </div>

            {!active ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={buttonClass({ variant: 'primary' })}
                  onClick={makeActive}
                  disabled={saving || !canSetActive}
                  title={canSetActive ? '设为当前翻译方式' : eligibility.reason ?? undefined}
                >
                  设为当前翻译方式
                </button>
                {!canSetActive ? (
                  <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">{eligibility.reason ?? '当前不可设为当前实例'}</span>
                ) : (
                  <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">切换只影响之后提交的段落。</span>
                )}
              </div>
            ) : (
              <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">该实例已是当前翻译方式。</span>
            )}

            {isOpenAI ? (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold" htmlFor="ed-preset">
                  预设
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  {['deepseek', 'custom'].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={`${buttonClass({ size: 'sm' })} aria-pressed:border-indigo-600 aria-pressed:bg-indigo-50 aria-pressed:text-indigo-700 aria-pressed:hover:bg-indigo-100 dark:aria-pressed:border-indigo-400 dark:aria-pressed:bg-indigo-950/40 dark:aria-pressed:text-indigo-200 dark:aria-pressed:hover:bg-indigo-900/60`}
                      aria-pressed={draft.preset === preset}
                      onClick={() => switchPreset(preset)}
                      disabled={saving}
                    >
                      {PRESET_LABELS[preset]}
                    </button>
                  ))}
                </div>
                <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">
                  切到 DeepSeek 会套用预设默认地址、模型与参数（可再修改）；切到自定义会保留当前配置。
                </span>
              </div>
            ) : null}
          </section>

          {isOpenAI ? (
            <>
              <section className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold">连接</h3>
                <Field
                  id="ed-baseurl"
                  label="接口地址（baseUrl）"
                  required
                  error={errors.baseUrl}
                  help="HTTPS 或本地回环地址；本地模型示例：http://localhost:11434/v1"
                >
                  <input
                    id="ed-baseurl"
                    type="url"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                    value={draft.baseUrl}
                    onChange={(event) => update('baseUrl', event.target.value)}
                    aria-invalid={Boolean(errors.baseUrl)}
                    aria-describedby={describedBy('ed-baseurl', {
                      error: errors.baseUrl,
                      help: 'HTTPS 或本地回环地址；本地模型示例：http://localhost:11434/v1',
                    })}
                    disabled={saving}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>

                <Field id="ed-path" label="接口路径" required error={errors.path} help="默认 /chat/completions。">
                  <input
                    id="ed-path"
                    type="text"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                    value={draft.path}
                    onChange={(event) => update('path', event.target.value)}
                    disabled={saving}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="inline-flex items-center gap-2 text-sm">
                    <Toggle
                      checked={draft.stream}
                      onChange={(value) => update('stream', value)}
                      ariaLabel="启用流式响应"
                      disabled={saving}
                    />
                    <span>使用流式响应（stream）</span>
                  </div>
                  <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">关闭后等待完整 JSON 响应，页面没有增量文本。</span>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs font-semibold">域名权限</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      tone={permission === 'granted' ? 'ok' : 'warn'}
                      icon={
                        permission === 'granted' ? (
                          <ShieldCheck size={11} aria-hidden="true" />
                        ) : (
                          <ShieldAlert size={11} aria-hidden="true" />
                        )
                      }
                    >
                      {permission === 'granted' ? '已授权' : '未授权'}
                    </StatusBadge>
                    <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">
                      {hostedOnOrigin ? `授权后允许请求 ${hostedOnOrigin}` : '填写接口地址后可申请域名权限'}
                    </span>
                  </div>
                  {originPattern && permission !== 'granted' ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={buttonClass({ variant: 'warning' })}
                        onClick={authorize}
                        disabled={saving || authorizing}
                      >
                        {authorizing ? '申请中…' : '授权访问'}
                      </button>
                      <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">未授权时不能测试、设为当前与翻译。</span>
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs font-semibold">查询参数</span>
                  <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">静态参数，例如 api-version；不要放密钥。</span>
                  <div className="flex flex-col gap-2">
                    {draft.query.map((row, index) => (
                      <div className="grid gap-2 sm:grid-cols-[1fr_1.2fr_auto]" key={`query-${index}`}>
                        <input
                          type="text"
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                          value={row.name}
                          onChange={(event) =>
                            update(
                              'query',
                              draft.query.map((item, i) =>
                                i === index ? { ...item, name: event.target.value } : item
                              )
                            )
                          }
                          placeholder="参数名"
                          aria-label={`查询参数 ${index + 1} 名称`}
                          disabled={saving}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <input
                          type="text"
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                          value={row.value}
                          onChange={(event) =>
                            update(
                              'query',
                              draft.query.map((item, i) =>
                                i === index ? { ...item, value: event.target.value } : item
                              )
                            )
                          }
                          placeholder="参数值"
                          aria-label={`查询参数 ${index + 1} 值`}
                          disabled={saving}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className={buttonClass({ variant: 'ghost' })}
                          onClick={() =>
                            update(
                              'query',
                              draft.query.filter((_item, i) => i !== index)
                            )
                          }
                          aria-label={`删除查询参数 ${index + 1}`}
                          disabled={saving}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={buttonClass({ size: 'xs' })}
                      onClick={() => update('query', [...draft.query, { name: '', value: '' }])}
                      disabled={saving}
                    >
                      添加查询参数
                    </button>
                  </div>
                  {errors.query ? <span className="text-xs leading-relaxed text-red-600 dark:text-red-400">{errors.query}</span> : null}
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs font-semibold">静态请求头</span>
                  <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">例如 X-Title；不要放密钥，禁止 Authorization / api-key / Cookie / Host。</span>
                  <div className="flex flex-col gap-2">
                    {draft.headers.map((row, index) => (
                      <div className="grid gap-2 sm:grid-cols-[1fr_1.2fr_auto]" key={`header-${index}`}>
                        <input
                          type="text"
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                          value={row.name}
                          onChange={(event) =>
                            update(
                              'headers',
                              draft.headers.map((item, i) =>
                                i === index ? { ...item, name: event.target.value } : item
                              )
                            )
                          }
                          placeholder="请求头名"
                          aria-label={`请求头 ${index + 1} 名称`}
                          disabled={saving}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <input
                          type="text"
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                          value={row.value}
                          onChange={(event) =>
                            update(
                              'headers',
                              draft.headers.map((item, i) =>
                                i === index ? { ...item, value: event.target.value } : item
                              )
                            )
                          }
                          placeholder="值"
                          aria-label={`请求头 ${index + 1} 值`}
                          disabled={saving}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className={buttonClass({ variant: 'ghost' })}
                          onClick={() =>
                            update(
                              'headers',
                              draft.headers.filter((_item, i) => i !== index)
                            )
                          }
                          aria-label={`删除请求头 ${index + 1}`}
                          disabled={saving}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={buttonClass({ size: 'xs' })}
                      onClick={() => update('headers', [...draft.headers, { name: '', value: '' }])}
                      disabled={saving}
                    >
                      添加请求头
                    </button>
                  </div>
                  {errors.headers ? <span className="text-xs leading-relaxed text-red-600 dark:text-red-400">{errors.headers}</span> : null}
                </div>
              </section>

              <section className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold">认证</h3>
                <Field
                  id="ed-auth"
                  label="认证方式"
                  help="密钥的实际值在下方凭据区填写；每个实例独立保存自己的密钥。"
                >
                  <Select
                    id="ed-auth"
                    value={draft.authType}
                    options={AUTH_TYPES.map((type) => ({ value: type, label: AUTH_LABELS[type] }))}
                    onChange={(next) => update('authType', next)}
                    ariaLabel="认证方式"
                    ariaDescribedBy={describedBy('ed-auth', {
                      help: '密钥的实际值在下方凭据区填写；每个实例独立保存自己的密钥。',
                    })}
                    disabled={saving}
                  />
                </Field>

                {draft.authType === 'header' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id="ed-auth-header" label="请求头名称" required error={errors.authHeaderName}>
                      <input
                        id="ed-auth-header"
                        type="text"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                        value={draft.authHeaderName}
                        onChange={(event) => update('authHeaderName', event.target.value)}
                        placeholder="api-key"
                        disabled={saving}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </Field>
                    <Field id="ed-auth-prefix" label="值前缀（可空）">
                      <input
                        id="ed-auth-prefix"
                        type="text"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                        value={draft.authPrefix}
                        onChange={(event) => update('authPrefix', event.target.value)}
                        placeholder="留空表示不加前缀"
                        disabled={saving}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </Field>
                  </div>
                ) : null}

                {draft.authType === 'query' ? (
                  <Field id="ed-auth-query" label="查询参数名" required error={errors.authQueryName}>
                    <input
                      id="ed-auth-query"
                      type="text"
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                      value={draft.authQueryName}
                      onChange={(event) => update('authQueryName', event.target.value)}
                      placeholder="key"
                      disabled={saving}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                ) : null}

                {draft.authType === 'none' ? (
                  <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">该实例不使用认证，无需填写密钥；请确认接口本身可匿名访问。</p>
                ) : null}
              </section>

              <section className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold">模型</h3>
                <Field
                  id="ed-model"
                  label="模型名称"
                  required
                  error={errors.model}
                  help="自由输入，例如 deepseek-chat、qwen2.5、llama3."
                >
                  <input
                    id="ed-model"
                    type="text"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                    value={draft.model}
                    onChange={(event) => update('model', event.target.value)}
                    disabled={saving}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              </section>

              <section className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold">生成参数</h3>
                <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">参数默认关闭；关闭后不发送该字段，模型不支持时保持关闭即可。</p>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="inline-flex items-center gap-2 text-sm">
                    <Toggle
                      checked={draft.temperatureEnabled}
                      onChange={(value) => update('temperatureEnabled', value)}
                      ariaLabel="启用 temperature"
                      disabled={saving}
                    />
                    <span>temperature</span>
                  </div>
                  <div className="w-40">
                    <input
                      type="number"
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                      value={draft.temperature}
                      onChange={(event) => update('temperature', event.target.value)}
                      min={0}
                      max={2}
                      step={0.1}
                      disabled={saving || !draft.temperatureEnabled}
                      aria-label="temperature 值"
                    />
                  </div>
                </div>
                {errors.temperature ? <span className="text-xs leading-relaxed text-red-600 dark:text-red-400">{errors.temperature}</span> : null}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="inline-flex items-center gap-2 text-sm">
                    <Toggle
                      checked={draft.topPEnabled}
                      onChange={(value) => update('topPEnabled', value)}
                      ariaLabel="启用 top_p"
                      disabled={saving}
                    />
                    <span>top_p</span>
                  </div>
                  <div className="w-40">
                    <input
                      type="number"
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                      value={draft.topP}
                      onChange={(event) => update('topP', event.target.value)}
                      min={0}
                      max={1}
                      step={0.05}
                      disabled={saving || !draft.topPEnabled}
                      aria-label="top_p 值"
                    />
                  </div>
                </div>
                {errors.topP ? <span className="text-xs leading-relaxed text-red-600 dark:text-red-400">{errors.topP}</span> : null}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="inline-flex items-center gap-2 text-sm">
                    <Toggle
                      checked={draft.maxTokensEnabled}
                      onChange={(value) => update('maxTokensEnabled', value)}
                      ariaLabel="启用 max_tokens"
                      disabled={saving}
                    />
                    <span>max_tokens</span>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <div className="w-40">
                      <Select
                        value={draft.maxTokensField}
                        options={MAX_TOKEN_FIELDS.map((field) => ({ value: field, label: field }))}
                        onChange={(next) => update('maxTokensField', next)}
                        ariaLabel="max_tokens 字段名"
                        disabled={saving || !draft.maxTokensEnabled}
                      />
                    </div>
                    <input
                      type="number"
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900 w-[120px]"
                      value={draft.maxTokens}
                      onChange={(event) => update('maxTokens', event.target.value)}
                      min={1}
                      step={1}
                      disabled={saving || !draft.maxTokensEnabled}
                      aria-label="max_tokens 值"
                    />
                  </div>
                </div>
                {errors.maxTokens ? <span className="text-xs leading-relaxed text-red-600 dark:text-red-400">{errors.maxTokens}</span> : null}

                <Field id="ed-reasoning" label="思考强度模式">
                  <Select
                    id="ed-reasoning"
                    value={draft.reasoningMode}
                    options={REASONING_MODES.map((mode) => ({
                      value: mode,
                      label: REASONING_MODE_LABELS[mode],
                    }))}
                    onChange={(next) => update('reasoningMode', next)}
                    ariaLabel="思考强度模式"
                    disabled={saving}
                  />
                </Field>

                {draft.reasoningMode === 'effort' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id="ed-reasoning-field" label="强度字段" required error={errors.reasoningField}>
                      <input
                        id="ed-reasoning-field"
                        type="text"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                        value={draft.reasoningField}
                        onChange={(event) => update('reasoningField', event.target.value)}
                        placeholder="reasoning_effort"
                        disabled={saving}
                        spellCheck={false}
                      />
                    </Field>
                    <Field id="ed-reasoning-value" label="强度取值" required error={errors.reasoningValue}>
                      {draft.reasoningValues.length > 0 ? (
                        <Select
                          id="ed-reasoning-value"
                          value={draft.reasoningValue}
                          options={draft.reasoningValues.map((value) => ({ value, label: value }))}
                          onChange={(next) => update('reasoningValue', next)}
                          ariaLabel="强度取值"
                          disabled={saving}
                        />
                      ) : (
                        <input
                          id="ed-reasoning-value"
                          type="text"
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                          value={draft.reasoningValue}
                          onChange={(event) => update('reasoningValue', event.target.value)}
                          disabled={saving}
                          spellCheck={false}
                        />
                      )}
                    </Field>
                  </div>
                ) : null}

                {draft.reasoningMode === 'budget' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id="ed-budget-field" label="预算字段" required error={errors.reasoningBudgetField}>
                      <input
                        id="ed-budget-field"
                        type="text"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                        value={draft.reasoningBudgetField}
                        onChange={(event) => update('reasoningBudgetField', event.target.value)}
                        placeholder="thinking.budget_tokens"
                        disabled={saving}
                        spellCheck={false}
                      />
                    </Field>
                    <Field id="ed-budget" label="预算（tokens）" required error={errors.reasoningBudget}>
                      <input
                        id="ed-budget"
                        type="number"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                        value={draft.reasoningBudget}
                        onChange={(event) => update('reasoningBudget', event.target.value)}
                        min={1}
                        step={1}
                        disabled={saving}
                      />
                    </Field>
                  </div>
                ) : null}

                {draft.reasoningMode === 'toggle' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id="ed-toggle-field" label="开关字段" required error={errors.reasoningToggleField}>
                      <input
                        id="ed-toggle-field"
                        type="text"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                        value={draft.reasoningToggleField}
                        onChange={(event) => update('reasoningToggleField', event.target.value)}
                        placeholder="thinking.type"
                        disabled={saving}
                        spellCheck={false}
                      />
                    </Field>
                    <Field id="ed-toggle-on" label="开启值" required error={errors.reasoningOn}>
                      <input
                        id="ed-toggle-on"
                        type="text"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                        value={draft.reasoningOn}
                        onChange={(event) => update('reasoningOn', event.target.value)}
                        disabled={saving}
                        spellCheck={false}
                      />
                    </Field>
                  </div>
                ) : null}

                <div className="flex flex-col gap-1">
                  <span className="text-xs font-semibold">额外参数</span>
                  <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">点路径写入请求体，例如 top_k；不能覆盖 messages / model / stream。</span>
                  <div className="flex flex-col gap-2">
                    {draft.extra.map((row, index) => (
                      <div className="grid gap-2 sm:grid-cols-[1fr_1.2fr_auto] sm:grid-cols-[1fr_0.7fr_1.2fr_auto]" key={`extra-${index}`}>
                        <input
                          type="text"
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                          value={row.path}
                          onChange={(event) =>
                            update(
                              'extra',
                              draft.extra.map((item, i) =>
                                i === index ? { ...item, path: event.target.value } : item
                              )
                            )
                          }
                          placeholder="参数路径"
                          aria-label={`额外参数 ${index + 1} 路径`}
                          disabled={saving}
                          spellCheck={false}
                        />
                        <Select
                          value={row.type}
                          options={EXTRA_TYPES.map((type) => ({ value: type, label: type }))}
                          onChange={(next) =>
                            update(
                              'extra',
                              draft.extra.map((item, i) => (i === index ? { ...item, type: next } : item))
                            )
                          }
                          ariaLabel={`额外参数 ${index + 1} 类型`}
                          disabled={saving}
                        />
                        <input
                          type="text"
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                          value={row.value}
                          onChange={(event) =>
                            update(
                              'extra',
                              draft.extra.map((item, i) =>
                                i === index ? { ...item, value: event.target.value } : item
                              )
                            )
                          }
                          placeholder="值"
                          aria-label={`额外参数 ${index + 1} 值`}
                          disabled={saving}
                          spellCheck={false}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="checkbox"
                            className="size-4 accent-indigo-600"
                            checked={row.enabled}
                            onChange={(event) =>
                              update(
                                'extra',
                                draft.extra.map((item, i) =>
                                  i === index ? { ...item, enabled: event.target.checked } : item
                                )
                              )
                            }
                            aria-label={`启用额外参数 ${index + 1}`}
                            disabled={saving}
                          />
                          <button
                            type="button"
                            className={buttonClass({ variant: 'ghost' })}
                            onClick={() =>
                              update(
                                'extra',
                                draft.extra.filter((_item, i) => i !== index)
                              )
                            }
                            aria-label={`删除额外参数 ${index + 1}`}
                            disabled={saving}
                          >
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={buttonClass({ size: 'xs' })}
                      onClick={() =>
                        update('extra', [
                          ...draft.extra,
                          { path: '', type: 'string', value: '', enabled: true },
                        ])
                      }
                      disabled={saving || draft.extra.length >= 50}
                    >
                      添加额外参数
                    </button>
                  </div>
                  {errors.extra ? <span className="text-xs leading-relaxed text-red-600 dark:text-red-400">{errors.extra}</span> : null}
                </div>
              </section>

              <details
                data-slot="accordion"
                className="group rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
              >
                <summary
                  data-slot="accordion-trigger"
                  className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-4 py-3 text-sm font-semibold text-gray-900 hover:bg-gray-50 dark:text-white dark:hover:bg-gray-800 [&::-webkit-details-marker]:hidden"
                >
                  高级参数（提示词）
                  <ChevronDown
                    className="size-4 shrink-0 text-gray-500 transition-transform group-open:rotate-180 dark:text-gray-400"
                    aria-hidden="true"
                  />
                </summary>
                <div
                  data-slot="accordion-content"
                  className="flex flex-col gap-4 border-t border-gray-200 px-4 py-3 dark:border-gray-700"
                >
                  <div className="flex flex-col gap-3">
                    <Field
                      id="ed-prompt"
                      label="默认翻译提示词"
                      error={errors.systemPrompt}
                      help="用于整页与悬停段落翻译；必须保留 {{targetLang}} 与 {{outputFormat}}，不能出现其它占位符；只保存在本机，不随账号同步。"
                    >
                      <textarea
                        id="ed-prompt"
                        ref={promptRef}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900 font-mono text-xs"
                        rows={10}
                        value={draft.systemPrompt}
                        onChange={(event) => update('systemPrompt', event.target.value)}
                        spellCheck={false}
                        disabled={saving}
                      />
                    </Field>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={buttonClass({ size: 'xs' })}
                        onClick={() => insertPromptToken('systemPrompt', promptRef, '{{targetLang}}')}
                        disabled={saving}
                      >
                        插入目标语言
                      </button>
                      <button
                        type="button"
                        className={buttonClass({ size: 'xs' })}
                        onClick={() => insertPromptToken('systemPrompt', promptRef, '{{outputFormat}}')}
                        disabled={saving}
                      >
                        插入输出格式
                      </button>
                      <button
                        type="button"
                        className={buttonClass({ size: 'xs' })}
                        onClick={() => update('systemPrompt', DEFAULT_SYSTEM_PROMPT)}
                        disabled={saving}
                      >
                        恢复默认提示词
                      </button>
                      <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">
                        {promptCount} / {MAX_PROMPT_CHARS}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 border-t border-gray-200 dark:border-gray-700 pt-3">
                    <Field
                      id="ed-quick-prompt"
                      label="快速翻译提示词"
                      error={errors.quickPrompt}
                      help="只用于弹窗快速翻译：单词第一行音标，之后每个词性一行释义（多个义项用分号分隔），最后两条例句；句子只返回译文；必须保留 {{targetLang}} 与 {{outputFormat}}；只保存在本机。"
                    >
                      <textarea
                        id="ed-quick-prompt"
                        ref={quickPromptRef}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900 font-mono text-xs"
                        rows={10}
                        value={draft.quickPrompt}
                        onChange={(event) => update('quickPrompt', event.target.value)}
                        spellCheck={false}
                        disabled={saving}
                      />
                    </Field>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={buttonClass({ size: 'xs' })}
                        onClick={() => insertPromptToken('quickPrompt', quickPromptRef, '{{targetLang}}')}
                        disabled={saving}
                      >
                        插入目标语言
                      </button>
                      <button
                        type="button"
                        className={buttonClass({ size: 'xs' })}
                        onClick={() => insertPromptToken('quickPrompt', quickPromptRef, '{{outputFormat}}')}
                        disabled={saving}
                      >
                        插入输出格式
                      </button>
                      <button
                        type="button"
                        className={buttonClass({ size: 'xs' })}
                        onClick={() => update('quickPrompt', DEFAULT_QUICK_PROMPT)}
                        disabled={saving}
                      >
                        恢复默认提示词
                      </button>
                      <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">
                        {quickPromptCount} / {MAX_PROMPT_CHARS}
                      </span>
                    </div>
                  </div>
                </div>
              </details>
            </>
          ) : null}

          <details
            data-slot="accordion"
            className="group rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
            open={!isOpenAI}
          >
            <summary
              data-slot="accordion-trigger"
              className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-4 py-3 text-sm font-semibold text-gray-900 hover:bg-gray-50 dark:text-white dark:hover:bg-gray-800 [&::-webkit-details-marker]:hidden"
            >
              批次与并发
              <ChevronDown
                className="size-4 shrink-0 text-gray-500 transition-transform group-open:rotate-180 dark:text-gray-400"
                aria-hidden="true"
              />
            </summary>
            <div
              data-slot="accordion-content"
              className="flex flex-col gap-3 border-t border-gray-200 px-4 py-3 dark:border-gray-700"
            >
              <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300 break-words">{batchLimitText}</p>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <Field id="ed-batch-size" label="单批段数" error={errors.batchSize}>
                  <input
                    id="ed-batch-size"
                    type="number"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                    value={draft.batchSize}
                    onChange={(event) => update('batchSize', event.target.value)}
                    min={MIN_BATCH_SIZE}
                    max={instance.type === 'baidu' ? BAIDU_BATCH_SIZE.max : undefined}
                    step={1}
                    disabled={saving}
                  />
                </Field>
                <Field id="ed-batch-chars" label="批次最大字符数" error={errors.batchMaxChars}>
                  <input
                    id="ed-batch-chars"
                    type="number"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                    value={draft.batchMaxChars}
                    onChange={(event) => update('batchMaxChars', event.target.value)}
                    min={1}
                    max={instance.type === 'baidu' ? BAIDU_BATCH_MAX_CHARS.max : undefined}
                    step={1}
                    disabled={saving}
                  />
                </Field>
                <Field id="ed-concurrency" label="最大并发数" error={errors.maxConcurrency}>
                  <input
                    id="ed-concurrency"
                    type="number"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                    value={draft.maxConcurrency}
                    onChange={(event) => update('maxConcurrency', event.target.value)}
                    min={1}
                    max={instance.type === 'baidu' ? BAIDU_MAX_CONCURRENCY.max : undefined}
                    step={1}
                    disabled={saving}
                  />
                </Field>
              </div>
              {instance.type === 'baidu' ? (
                <Field
                  id="ed-qps"
                  label="接口 QPS"
                  error={errors.qps}
                  help="标准版 1、高级版 10、尊享版 100；每个上游请求计 1 次，批量请求按 1 次计算。同一账号建议只配置一个百度实例。"
                >
                  <input
                    id="ed-qps"
                    type="number"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                    value={draft.qps}
                    onChange={(event) => update('qps', event.target.value)}
                    min={BAIDU_QPS.min}
                    max={BAIDU_QPS.max}
                    step={1}
                    disabled={saving}
                    aria-invalid={Boolean(errors.qps)}
                    aria-describedby={describedBy('ed-qps', {
                      error: errors.qps,
                      help: '标准版 1、高级版 10、尊享版 100；每个上游请求计 1 次，批量请求按 1 次计算。同一账号建议只配置一个百度实例。',
                    })}
                  />
                </Field>
              ) : null}
            </div>
          </details>

          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">
              <KeyRound size={14} aria-hidden="true" /> 凭据
            </h3>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge
                tone={credentials.key === 'ok' || credentials.key === 'none' ? 'ok' : credentials.key === 'partial' ? 'warn' : 'idle'}
              >
                {credentials.label}
              </StatusBadge>
              {!requiresKey ? <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">该实例无需密钥。</span> : null}
              <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">只显示是否已配置，不显示明文。</span>
            </div>

            {!requiresKey ? null : isOpenAI ? (
              <Field
                id="ed-apikey"
                label="API Key"
                badge={
                  <StatusBadge tone={instance.hasKey ? 'ok' : 'idle'}>
                    {instance.hasKey ? '已配置' : '未配置'}
                  </StatusBadge>
                }
                help="留空表示不修改；这里不会显示明文。"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="ed-apikey"
                    type={showSecret ? 'text' : 'password'}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={instance.hasKey ? '已配置，留空表示不修改' : '填写 API Key'}
                    autoComplete="off"
                    disabled={saving}
                  />
                  <button
                    type="button"
                    className={buttonClass({ variant: 'ghost' })}
                    onClick={() => setShowSecret((current) => !current)}
                    aria-label={showSecret ? '隐藏密钥' : '显示密钥'}
                  >
                    {showSecret ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                  </button>
                </div>
              </Field>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  id="ed-appid"
                  label="APPID"
                  badge={
                    <StatusBadge tone={instance.credentialFields?.appId ? 'ok' : 'idle'}>
                      {instance.credentialFields?.appId ? '已配置' : '未配置'}
                    </StatusBadge>
                  }
                  help="留空表示不修改。"
                >
                  <input
                    id="ed-appid"
                    type="text"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                    value={appId}
                    onChange={(event) => setAppId(event.target.value)}
                    placeholder={instance.credentialFields?.appId ? '已配置，留空表示不修改' : '百度 APPID'}
                    autoComplete="off"
                    disabled={saving}
                  />
                </Field>
                <Field
                  id="ed-secret"
                  label="密钥"
                  badge={
                    <StatusBadge tone={instance.credentialFields?.secretKey ? 'ok' : 'idle'}>
                      {instance.credentialFields?.secretKey ? '已配置' : '未配置'}
                    </StatusBadge>
                  }
                  help="留空表示不修改；这里不会显示明文。"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      id="ed-secret"
                      type={showSecret ? 'text' : 'password'}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-indigo-400 dark:focus:ring-indigo-900"
                      value={secretKey}
                      onChange={(event) => setSecretKey(event.target.value)}
                      placeholder={instance.credentialFields?.secretKey ? '已配置，留空表示不修改' : '百度密钥'}
                      autoComplete="off"
                      disabled={saving}
                    />
                    <button
                      type="button"
                      className={buttonClass({ variant: 'ghost' })}
                      onClick={() => setShowSecret((current) => !current)}
                      aria-label={showSecret ? '隐藏密钥' : '显示密钥'}
                    >
                      {showSecret ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                    </button>
                  </div>
                </Field>
              </div>
            )}

            {(instance.hasKey || instance.credentialFields?.apiKey || instance.credentialFields?.appId || instance.credentialFields?.secretKey) ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={buttonClass({ variant: 'danger' })}
                  onClick={() => setConfirmClear(true)}
                  disabled={saving}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  清除凭据
                </button>
                {active ? (
                  <span className="text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">清除当前实例的凭据会自动改选下一个可用实例。</span>
                ) : null}
              </div>
            ) : null}
          </section>

          {saveError ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" role="alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <span className="min-w-0 break-words">{saveError}</span>
            </div>
          ) : null}
        </div>

        <footer className="flex items-center gap-2 border-t border-gray-200 dark:border-gray-700 p-3">
          <button type="button" className={buttonClass({ size: 'sm' })} onClick={requestClose} disabled={saving}>
            取消
          </button>
          <span className="ml-auto" />
          <button
            type="button"
            className={buttonClass({ variant: 'primary' })}
            onClick={save}
            disabled={saving}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>

      {confirmClear ? (
        <ConfirmDialog
          title="清除该实例的凭据？"
          description={active ? '清除后会立即改选下一个可用实例；页面翻译会改用新实例。' : '清除后该实例不能用于翻译，直到重新填写凭据。'}
          confirmLabel="清除凭据"
          tone="error"
          busy={clearing}
          onConfirm={clearCredentials}
          onCancel={() => setConfirmClear(false)}
        />
      ) : null}

      {confirmDiscard ? (
        <ConfirmDialog
          title="放弃未保存的修改？"
          description="有未保存的修改，离开将丢失。"
          confirmLabel="放弃修改"
          cancelLabel="继续编辑"
          tone="error"
          onConfirm={() => {
            setConfirmDiscard(false);
            onClose();
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      ) : null}
    </div>
  );
}
