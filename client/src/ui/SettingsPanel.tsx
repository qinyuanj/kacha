// 高级设置：网关地址、连接测试、按页面并发上限、存储用量与自助清理。
// 可见判定在 ui/settingsPanelView.ts（#137），这里只留接线与 DOM 摆放。
import { useEffect, useState } from "react";
import { useShell } from "./shell";
import { DataRootSection } from "./DataRootSection";
import type { DataRootActions } from "./dataRootMove";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { DEFAULT_FEEDBACK_RELAY_URL, DEFAULT_SETTINGS, MAX_CONCURRENCY, MIN_CONCURRENCY, normalizeBaseUrl } from "../core/settings";
import { UsageSection } from "./UsageSection";
import type { ConnectionResult, useSettings } from "./useSettings";
import { concurrencyOnBlur, connectionText, discoveryText, settingsPanelView, settingsToSave } from "./settingsPanelView";

interface Props {
  settings: ReturnType<typeof useSettings>;
  onClose: () => void;
  /** 数据位置迁移的接线（#161）；工作台没给就不显示这一段。 */
  dataRoot?: DataRootActions;
}

/** 网关地址那一行：输入、错误与明文 HTTP 提示。 */
function GatewayRow({ baseUrl, urlError, plainHttp, onChange }: { baseUrl: string; urlError: string | null; plainHttp: boolean; onChange(value: string): void }) {
  return (
    <>
      <label className="form-row">
        <span className="form-row-label">网关基础地址</span>
        <input value={baseUrl} onChange={(e) => onChange(e.target.value)} placeholder={DEFAULT_SETTINGS.base_url} spellCheck={false} />
      </label>
      {urlError && <div className="form-error">{urlError}</div>}
      {plainHttp && <div className="notice notice-warn">明文 HTTP：密钥与图片不加密传输，仅限可信内网使用。</div>}
    </>
  );
}

/** 反馈中继覆盖那一行：留空即使用内置默认地址。 */
function RelayRow({ value, error, onChange }: { value: string; error: string | null; onChange(value: string): void }) {
  return (
    <>
      <label className="form-row">
        <span className="form-row-label">反馈中继地址</span>
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={DEFAULT_FEEDBACK_RELAY_URL} spellCheck={false} />
        <span className="form-row-hint">留空使用 {DEFAULT_FEEDBACK_RELAY_URL}；覆盖值优先</span>
      </label>
      {error && <div className="form-error">{error}</div>}
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
        <span className="form-row-label">连接测试</span>
        <button onClick={onTest} disabled={!canTest}>{testLabel}</button>
        {testResult && <span className={testResult.ok ? "ok-text" : "form-error"}>{connectionText(testResult)}</span>}
      </div>
    </>
  );
}

/** 并发上限那一行。 */
function ConcurrencyRow({
  draft,
  highConcurrency,
  concurrencyHint,
  onChange,
  onBlur,
}: {
  draft: string;
  highConcurrency: boolean;
  concurrencyHint: string;
  onChange(value: string): void;
  onBlur(): void;
}) {
  return (
    <>
      <label className="form-row">
        <span className="form-row-label">并发上限</span>
        <input type="number" min={MIN_CONCURRENCY} max={MAX_CONCURRENCY} value={draft} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />
        <span className="form-row-hint">{concurrencyHint}</span>
      </label>
      {highConcurrency && <div className="muted small form-hint">qwen 模型曾在 6 个以上并发时触发网关限流；限流时整条队列会暂停等待。</div>}
    </>
  );
}

function closeOnBackdrop(event: React.MouseEvent, onClose: () => void): void {
  if (event.target === event.currentTarget) onClose();
}

/** 面板上的三个动作：测试连接、保存、清除密钥。状态归面板所有，这里只收流程与「成功才关窗」。 */
function panelActions(input: {
  settings: ReturnType<typeof useSettings>;
  view: ReturnType<typeof settingsPanelView>;
  baseUrl: string;
  feedbackRelayUrl: string;
  concurrencyDraft: string;
  apiKeyDraft: string;
  setApiKeyDraft(value: string): void;
  setTesting(value: boolean): void;
  setTestResult(value: ConnectionResult | null): void;
  setSaving(value: boolean): void;
  setError(value: string | null): void;
  onClose(): void;
}) {
  const { settings, view, baseUrl, feedbackRelayUrl, concurrencyDraft, apiKeyDraft } = input;
  const { setApiKeyDraft, setTesting, setTestResult, setSaving, setError, onClose } = input;

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    setTestResult(await settings.testConnection(normalizeBaseUrl(baseUrl), apiKeyDraft));
    setTesting(false);
  };

  const submit = async () => {
    if (view.urlError || view.feedbackRelayUrlError) return;
    setSaving(true);
    setError(null);
    const problem = await settings.save(settingsToSave(settings.settings, baseUrl, concurrencyDraft, feedbackRelayUrl), apiKeyDraft);
    setSaving(false);
    if (problem) return setError(problem);
    onClose();
  };

  // 清除是显式动作：立即用空密钥保存，同时清掉草稿；不留下「看起来清了、盘上还有」的状态。
  const clearKey = async () => {
    setSaving(true);
    setError(null);
    const problem = await settings.save(settings.settings, "");
    setSaving(false);
    if (problem) return setError(problem);
    setApiKeyDraft("");
  };

  return { test, submit, clearKey };
}

export function SettingsPanel({ settings, onClose, dataRoot }: Props) {
  const port = useShell();
  const [baseUrl, setBaseUrl] = useState(settings.settings.base_url);
  // 空白表示没有显式覆盖；默认地址只作输入框占位，不写回 settings.json。
  const [feedbackRelayUrl, setFeedbackRelayUrl] = useState(settings.settings.feedback_relay_url);
  // 草稿是原始文本，输入中可为空或越界；失焦与保存时才经 parseConcurrency 钳制。
  const [concurrencyDraft, setConcurrencyDraft] = useState(String(settings.settings.concurrency));
  // 密钥草稿：只有点保存 / 清除才写进系统保护存储；测试连接用草稿，不用上一次读到的旧值。
  const [apiKeyDraft, setApiKeyDraft] = useState(settings.apiKey);
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
    feedbackRelayUrl,
    concurrencyDraft,
    savedConcurrency: settings.settings.concurrency,
    file: settings.file,
    apiKey: apiKeyDraft,
    testing,
    saving,
  });
  const { discovery } = settings;
  const { test, submit, clearKey } = panelActions({
    settings,
    view,
    baseUrl,
    feedbackRelayUrl,
    concurrencyDraft,
    apiKeyDraft,
    setApiKeyDraft,
    setTesting,
    setTestResult,
    setSaving,
    setError,
    onClose,
  });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => closeOnBackdrop(e, onClose)}>
      <div className="modal settings-dialog" role="dialog" aria-label="高级设置">
        <div className="modal-head">
          <strong>高级设置</strong>
          {version && <span className="muted small">版本 {version}</span>}
          <button className="icon-button" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        {settings.fileProblem && <div className="notice notice-warn">{settings.fileProblem}</div>}

        <div className="settings-section">
          <GatewayRow baseUrl={baseUrl} urlError={view.urlError} plainHttp={view.plainHttp} onChange={setBaseUrl} />
        </div>
        <div className="settings-section">
          <RelayRow value={feedbackRelayUrl} error={view.feedbackRelayUrlError} onChange={setFeedbackRelayUrl} />
        </div>

        <div className="settings-section">
          <label className="form-row">
            <span className="form-row-label">API 密钥</span>
            <input type="password" value={apiKeyDraft} onChange={(e) => setApiKeyDraft(e.target.value)} placeholder="粘贴团队网关 API 密钥" autoComplete="off" spellCheck={false} />
            <button onClick={() => void clearKey()} disabled={saving || !apiKeyDraft.trim()}>清除密钥</button>
          </label>
          <div className="muted small form-hint">密钥保存在本机并受 Windows 系统保护，不写入设置文件或诊断；更换或清除密钥不会改变本机画板身份。</div>
        </div>

        <div className="settings-section">
          <ConnectionRow testResult={testResult} canTest={view.canTest} testLabel={view.testLabel} onTest={() => void test()} />
          <div className="muted small form-hint">{discoveryText(discovery)}</div>
        </div>

        <div className="settings-section">
          <ConcurrencyRow
            draft={concurrencyDraft}
            highConcurrency={view.highConcurrency}
            concurrencyHint={view.concurrencyHint}
            onChange={setConcurrencyDraft}
            onBlur={() => setConcurrencyDraft(concurrencyOnBlur(concurrencyDraft, settings.settings.concurrency))}
          />
        </div>

        {dataRoot && (
          <div className="settings-section">
            <DataRootSection actions={dataRoot} />
          </div>
        )}

        {port.features.diagnostics && (
          <div className="settings-section">
            <DiagnosticsSection />
          </div>
        )}

        <div className="settings-section">
          <UsageSection />
        </div>
        {error && <div className="form-alert form-alert-error">{error}</div>}
        <div className="modal-foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void submit()} disabled={!view.canSave}>保存</button>
        </div>
      </div>
    </div>
  );
}