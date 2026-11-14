// 高级设置：网关地址、连接测试、按页面并发上限、存储用量与自助清理。
// 可见判定在 ui/settingsPanelView.ts（#137），这里只留接线与 DOM 摆放。
import { useEffect, useState } from "react";
import { useShell } from "./shell";
import { DEFAULT_SETTINGS, MAX_CONCURRENCY, MIN_CONCURRENCY, normalizeBaseUrl } from "../core/settings";
import { UsageSection } from "./UsageSection";
import type { ConnectionResult, useSettings } from "./useSettings";
import { concurrencyOnBlur, connectionText, discoveryText, settingsPanelView, settingsToSave } from "./settingsPanelView";

interface Props {
  settings: ReturnType<typeof useSettings>;
  onClose: () => void;
}

/** 网关地址那一行：输入、错误与明文 HTTP 提示。 */
function GatewayRow({ baseUrl, urlError, plainHttp, onChange }: { baseUrl: string; urlError: string | null; plainHttp: boolean; onChange(value: string): void }) {
  return (
    <>
      <label className="form-row">
        <span>网关基础地址</span>
        <input value={baseUrl} onChange={(e) => onChange(e.target.value)} placeholder={DEFAULT_SETTINGS.base_url} spellCheck={false} />
      </label>
      {urlError && <div className="form-error">{urlError}</div>}
      {plainHttp && <div className="notice notice-warn">明文 HTTP：密钥与图片不加密传输，仅限可信内网使用。</div>}
    </>
  );
}

/** 连接测试那一行。 */
function ConnectionRow({
  testResult,
  canTest,
  testLabel,
  onTest,
}: {
  testResult: ConnectionResult | null;
  canTest: boolean;
  testLabel: string;
  onTest(): void;
}) {
  return (
    <>
      <div className="form-row">
        <span>连接测试</span>
        <button onClick={onTest} disabled={!canTest}>{testLabel}</button>
        {testResult && <span className={testResult.ok ? "ok-text" : "form-error"}>{connectionText(testResult)}</span>}
      </div>
    </>
  );
}

/** 并发上限那一行。 */
function ConcurrencyRow({
  draft,
  concurrency,
  highConcurrency,
  concurrencyHint,
  onChange,
  onBlur,
}: {
  draft: string;
  concurrency: number;
  highConcurrency: boolean;
  concurrencyHint: string;
  onChange(value: string): void;
  onBlur(): void;
}) {
  return (
    <>
      <label className="form-row">
        <span>并发上限</span>
        <input type="number" min={MIN_CONCURRENCY} max={MAX_CONCURRENCY} value={draft} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />
        <span className="muted small">{concurrencyHint}</span>
      </label>
      {highConcurrency && <div className="muted small form-hint">qwen 模型曾在 6 个以上并发时触发网关限流；限流时整条队列会暂停等待。</div>}
      <span hidden data-concurrency={concurrency} />
    </>
  );
}

export function SettingsPanel({ settings, onClose }: Props) {
  const port = useShell();
  const [baseUrl, setBaseUrl] = useState(settings.settings.base_url);
  // 草稿是原始文本，输入中可为空或越界；失焦与保存时才经 parseConcurrency 钳制。
  const [concurrencyDraft, setConcurrencyDraft] = useState(String(settings.settings.concurrency));
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void port.ui.version().then(setVersion, () => undefined);
  }, []);

  const view = settingsPanelView({
    baseUrl,
    concurrencyDraft,
    savedConcurrency: settings.settings.concurrency,
    file: settings.file,
    apiKey: settings.apiKey,
    testing,
    saving,
  });
  const { discovery } = settings;

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    setTestResult(await settings.testConnection(normalizeBaseUrl(baseUrl), settings.apiKey));
    setTesting(false);
  };

  const submit = async () => {
    if (view.urlError) return;
    setSaving(true);
    setError(null);
    const problem = await settings.save(settingsToSave(settings.settings, baseUrl, concurrencyDraft), settings.apiKey);
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

        <GatewayRow baseUrl={baseUrl} urlError={view.urlError} plainHttp={view.plainHttp} onChange={setBaseUrl} />

        <div className="form-row">
          <span>API 密钥</span>
          <span className="muted small">密钥由进入界面管理；换密钥即视为新用户，看不到原来的画板与结果。要换密钥请先退出。</span>
        </div>

        <ConnectionRow testResult={testResult} canTest={view.canTest} testLabel={view.testLabel} onTest={() => void test()} />
        <div className="muted small form-hint">{discoveryText(discovery)}</div>

        <ConcurrencyRow
          draft={concurrencyDraft}
          concurrency={view.concurrency}
          highConcurrency={view.highConcurrency}
          concurrencyHint={view.concurrencyHint}
          onChange={setConcurrencyDraft}
          onBlur={() => setConcurrencyDraft(concurrencyOnBlur(concurrencyDraft, settings.settings.concurrency))}
        />

        <UsageSection />
        {error && <div className="form-error">{error}</div>}
        <div className="modal-foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void submit()} disabled={!view.canSave}>保存</button>
        </div>
      </div>
    </div>
  );
}
