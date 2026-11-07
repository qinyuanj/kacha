// 高级设置：网关地址、连接测试、按页面并发上限、存储用量与自助清理。
import { browser } from "../shell/ipc";
import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, isPlainHttp, MAX_CONCURRENCY, mayOverwriteSettings, MIN_CONCURRENCY, normalizeBaseUrl, parseConcurrency, settingsFromForm, validateBaseUrl } from "../core/settings";
import { UsageSection } from "./UsageSection";
import type { ConnectionResult, useSettings } from "./useSettings";

interface Props {
  settings: ReturnType<typeof useSettings>;
  onClose: () => void;
}

export function SettingsPanel({ settings, onClose }: Props) {
  const [baseUrl, setBaseUrl] = useState(settings.settings.base_url);
  // 草稿是原始文本，输入中可为空或越界；失焦与保存时才经 parseConcurrency 钳制。
  const [concurrencyDraft, setConcurrencyDraft] = useState(String(settings.settings.concurrency));
  const concurrency = parseConcurrency(concurrencyDraft, settings.settings.concurrency);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void browser.version().then(setVersion, () => undefined);
  }, []);

  const urlError = validateBaseUrl(baseUrl);
  const readOnly = !mayOverwriteSettings(settings.file);
  const { discovery } = settings;

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    setTestResult(await settings.testConnection(normalizeBaseUrl(baseUrl), settings.apiKey));
    setTesting(false);
  };

  const submit = async () => {
    if (urlError) return;
    setSaving(true);
    setError(null);
    const problem = await settings.save(settingsFromForm(settings.settings, { baseUrl, concurrencyDraft }), settings.apiKey);
    setSaving(false);
    if (problem) return setError(problem);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="高级设置">
        <div className="modal-head">
          <strong>高级设置</strong>
          {version && <span className="muted small">版本 {version}</span>}
          <button className="link" onClick={onClose}>关闭</button>
        </div>
        {settings.fileProblem && <div className="notice notice-warn">{settings.fileProblem}</div>}

        <label className="form-row">
          <span>网关基础地址</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={DEFAULT_SETTINGS.base_url} spellCheck={false} />
        </label>
        {urlError && <div className="form-error">{urlError}</div>}
        {!urlError && isPlainHttp(baseUrl) && <div className="notice notice-warn">明文 HTTP：密钥与图片不加密传输，仅限可信内网使用。</div>}

        <div className="form-row">
          <span>API 密钥</span>
          <span className="muted small">密钥由进入界面管理；换密钥即视为新用户，看不到原来的画板与结果。要换密钥请先退出。</span>
        </div>

        <div className="form-row">
          <span>连接测试</span>
          <button onClick={() => void test()} disabled={testing || !!urlError || !settings.apiKey.trim()}>{testing ? "测试中…" : "测试连接并刷新模型"}</button>
          {testResult && <span className={testResult.ok ? "ok-text" : "form-error"}>{testResult.ok ? `连接成功，网关提供 ${testResult.count} 个模型` : testResult.message}</span>}
        </div>
        <div className="muted small form-hint">
          {discovery.source === "live" && `模型列表：已从网关获取（${new Date(discovery.fetchedAt).toLocaleString()}）`}
          {discovery.source === "cached" && `模型列表：离线，使用缓存（${new Date(discovery.fetchedAt).toLocaleString()}）`}
          {discovery.source === "none" && "模型列表：尚未从网关获取，暂按上架清单显示"}
        </div>

        <label className="form-row">
          <span>并发上限</span>
          <input type="number" min={MIN_CONCURRENCY} max={MAX_CONCURRENCY} value={concurrencyDraft}
            onChange={(e) => setConcurrencyDraft(e.target.value)} onBlur={() => setConcurrencyDraft(String(concurrency))} />
          <span className="muted small">1～{MAX_CONCURRENCY}，默认 {DEFAULT_SETTINGS.concurrency}；按页面各自计算，同一密钥开多个页面时互不共享</span>
        </label>
        {concurrency > 5 && <div className="muted small form-hint">qwen 模型曾在 6 个以上并发时触发网关限流；限流时整条队列会暂停等待。</div>}

        <UsageSection />
        {error && <div className="form-error">{error}</div>}
        <div className="modal-foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void submit()} disabled={saving || !!urlError || readOnly}>保存</button>
        </div>
      </div>
    </div>
  );
}
