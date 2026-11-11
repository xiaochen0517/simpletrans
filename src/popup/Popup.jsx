import { useEffect, useState } from 'react';
import { getPublicSettings, saveSettings } from '../shared/settings.js';
import './popup.css';

export default function Popup() {
  const [settings, setSettings] = useState(null);
  const [selection, setSelection] = useState('');

  useEffect(() => {
    getPublicSettings().then(setSettings);

    // 向当前标签页的 content script 获取选中文本
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.id) return;
      chrome.tabs
        .sendMessage(tab.id, { type: 'GET_SELECTION' })
        .then((res) => setSelection(res?.text ?? ''))
        .catch(() => setSelection(''));
    });
  }, []);

  if (!settings) return null;

  const toggle = async () => {
    const next = { ...settings, enabled: !settings.enabled };
    setSettings(next);
    await saveSettings({ enabled: next.enabled });
  };

  return (
    <div className="popup p-4 flex flex-col gap-3">
      <h1 className="text-lg font-bold m-0">SimpleTrans</h1>

      <label className="label cursor-pointer justify-start gap-2 p-0">
        <input type="checkbox" className="toggle toggle-primary toggle-sm" checked={settings.enabled} onChange={toggle} />
        <span>启用插件</span>
      </label>

      <div className="flex items-center gap-2">
        <span>目标语言：</span>
        <span className="badge badge-primary badge-outline">{settings.targetLang}</span>
      </div>

      <div className="bg-base-200 rounded-lg p-2">
        <div className="text-xs text-base-content/60 mb-1">当前页面选中文本：</div>
        <div className="max-h-32 overflow-auto wrap-break-word text-sm">
          {selection || <em className="text-base-content/50">（无）</em>}
        </div>
      </div>

      <button className="btn btn-primary btn-sm" onClick={() => chrome.runtime.openOptionsPage()}>
        打开设置
      </button>
    </div>
  );
}
