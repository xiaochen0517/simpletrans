import { useEffect, useState } from 'react';
import { SUPPORTED_LANGS } from '../shared/constants.js';
import { getSettings, saveSettings } from '../shared/settings.js';
import { translateText } from '../shared/translate/deepseek.js';

const KEY_STORAGE_OPTIONS = [
  { value: 'local', label: '仅本机（推荐）', hint: '保存于 chrome.storage.local，不随账号同步。' },
  { value: 'sync', label: '随账号同步', hint: '保存于 chrome.storage.sync，会经过云端并可同步到其它设备。' },
];

export default function Options() {
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(false);

  const [testInput, setTestInput] = useState('Hello, world!');
  const [testResult, setTestResult] = useState('');
  const [testError, setTestError] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  if (!settings) return null;

  const keyStorageHint = KEY_STORAGE_OPTIONS.find((item) => item.value === settings.keyStorage)?.hint ?? '';

  const onSave = async () => {
    await saveSettings(settings);
    setSettings(await getSettings());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const onTestTranslate = async () => {
    setTesting(true);
    setTestError('');
    setTestResult('');
    try {
      const result = await translateText({
        text: testInput,
        targetLang: settings.targetLang,
        apiKey: settings.deepseekApiKey,
      });
      setTestResult(result);
    } catch (err) {
      setTestError(err.message ?? String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto my-10 px-4">
      <h1 className="text-2xl font-bold mb-6">SimpleTrans 设置</h1>

      <div className="card bg-base-100 shadow-sm border border-base-200 mb-4">
        <div className="card-body gap-4">
          <label className="label cursor-pointer justify-start gap-3">
            <input
              type="checkbox"
              className="toggle toggle-primary"
              checked={settings.enabled}
              onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
            />
            <span>启用插件</span>
          </label>

          <label className="form-control w-full max-w-xs">
            <div className="label">
              <span className="label-text">目标语言</span>
            </div>
            <select
              className="select select-bordered"
              value={settings.targetLang}
              onChange={(e) => setSettings({ ...settings, targetLang: e.target.value })}
            >
              {SUPPORTED_LANGS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>

          <label className="form-control w-full">
            <div className="label">
              <span className="label-text">DeepSeek API Key</span>
            </div>
            <input
              type="password"
              className="input input-bordered w-full"
              placeholder="sk-..."
              value={settings.deepseekApiKey}
              onChange={(e) => setSettings({ ...settings, deepseekApiKey: e.target.value })}
            />
          </label>

          <label className="form-control w-full max-w-xs">
            <div className="label">
              <span className="label-text">密钥保存位置</span>
            </div>
            <select
              className="select select-bordered"
              value={settings.keyStorage}
              onChange={(e) => setSettings({ ...settings, keyStorage: e.target.value })}
            >
              {KEY_STORAGE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <div className="label">
              <span className="label-text-alt text-base-content/60">{keyStorageHint}</span>
            </div>
          </label>

          <div className="flex items-center gap-3">
            <button className="btn btn-primary" onClick={onSave}>
              保存
            </button>
            {saved && <span className="text-success text-sm">已保存</span>}
          </div>
        </div>
      </div>

      <div className="card bg-base-100 shadow-sm border border-base-200">
        <div className="card-body gap-3">
          <h2 className="card-title text-base">翻译测试（DeepSeek）</h2>

          <textarea
            className="textarea textarea-bordered w-full"
            rows={3}
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
          />

          <button className="btn btn-outline btn-primary w-fit" onClick={onTestTranslate} disabled={testing}>
            {testing && <span className="loading loading-spinner loading-sm" />}
            测试翻译
          </button>

          {testError && (
            <div className="alert alert-error text-sm py-2">
              <span>{testError}</span>
            </div>
          )}

          {testResult && (
            <div className="bg-base-200 rounded-lg p-3 text-sm whitespace-pre-wrap">{testResult}</div>
          )}
        </div>
      </div>
    </div>
  );
}
