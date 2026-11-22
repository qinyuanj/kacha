import { useEffect, useRef, useState } from 'react';
import type { DiagnosticsPackOutcome, FeedbackAttachment, FeedbackKind, FeedbackOutcome, FeedbackSpec } from '../shell/port';
import { FEEDBACK_CATEGORIES, FEEDBACK_FAILURE_MESSAGES as FEEDBACK_MESSAGES, FEEDBACK_MAX_SCREENSHOT_BYTES as MAX_SCREENSHOT_BYTES, FEEDBACK_MAX_SCREENSHOTS as MAX_SCREENSHOTS, FEEDBACK_TOKEN_NOTICE, FEEDBACK_TOKEN_REQUIRED, FEEDBACK_TOKEN_SCOPE, feedbackCategoryLabel } from '../core/feedback';
import { useShell } from './shell';

const IMAGE_TYPES = ['image/png', 'image/jpeg'];

/** #206 的脱敏只处理预览可见文本：本机路径换成占位，凭据整段移除。 */
export function redactFeedbackText(text: string): string {
  return text
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s:："'<>|*?]+[\\/])+[^\s:："'<>|*?]*/g, '<本地路径>')
    .replace(/(?:sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/g, '<已隐藏>')
    .replace(/(?:api[_-]?key|gateway[_-]?key|token|secret|authorization|bearer)\s*[:=]\s*(?:"[^"]+"|'[^']+'|\S+)/gi, '<已隐藏>');
}

/** 画板名只取最后一段，绝不把路径带进反馈。 */
export function feedbackBoardName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1)?.replace(/\.kacha$/i, '') ?? '';
}

function feedbackMessage(outcome: FeedbackOutcome): string {
  if (outcome.kind === 'duplicate' && outcome.number) return `刚刚已提交过 #${outcome.number}，请勿重复提交。`;
  return FEEDBACK_MESSAGES[outcome.kind as Exclude<FeedbackKind, 'ok'>];
}

/** 失败后一键复制的是已脱敏的完整文字内容，附件只列摘要，不复制二进制。 */
function feedbackClipboardText(spec: FeedbackSpec): string {
  return [
    `标题：${spec.title || '（无）'}`,
    `分类：${feedbackCategoryLabel(spec.category)}`,
    `正文：${spec.body}`,
    `版本：${spec.version}（build ${spec.build || '未知'}）`,
    `系统：${spec.os}`,
    `当前画板：${spec.board_name || '（未打开画板）'}`,
    `提交者：${spec.contact ?? '匿名'}`,
    `截图：${spec.screenshots?.length ? spec.screenshots.map((a) => a.name).join('、') : '（无）'}`,
    `诊断包：${spec.diagnostics_pack?.name ?? '（未附带）'}`,
  ].join('\n');
}

function isFailure(outcome: FeedbackOutcome): boolean {
  return !outcome.ok;
}

/** 先校验再读字节：坏图不占发送队列，错误文案直接告诉用户怎么改。 */
function screenshotError(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return `截图 ${file.name} 只支持 PNG/JPG 格式，请转换格式后重试`;
  if (file.size > MAX_SCREENSHOT_BYTES) return `截图 ${file.name} 超过 10MB，请压缩后重试`;
  return null;
}

async function attachmentOf(file: File): Promise<FeedbackAttachment> {
  let bytes: Uint8Array;
  if (typeof file.arrayBuffer === 'function') {
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取截图失败'));
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(file);
    });
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return { name: file.name, content_type: file.type, data: btoa(binary) };
}

export interface FeedbackDialogProps {
  version: string;
  build: string;
  boardName: string;
  /** #211：由设置解析器算出的中继地址；每次发送都随 spec 进端口。 */
  relayUrl?: string;
  onClose(): void;
}

type FeedbackStep = 'form' | 'preview' | 'receipt';
type Setter<T> = (next: T | ((current: T) => T)) => void;

interface FeedbackSpecInput {
  title: string;
  category: string;
  body: string;
  version: string;
  build: string;
  boardName: string;
  relayUrl?: string;
  contact: string;
  token: string;
  screenshots: FeedbackAttachment[];
  diagnosticsPack: FeedbackAttachment | null;
}

function feedbackSpecOf(input: FeedbackSpecInput): FeedbackSpec {
  const contact = input.contact.trim();
  return {
    title: input.title.trim(),
    category: input.category,
    body: redactFeedbackText(input.body.trim()),
    version: input.version,
    build: input.build,
    os: navigator.userAgent,
    board_name: feedbackBoardName(input.boardName),
    ...(input.relayUrl ? { relay_url: input.relayUrl } : {}),
    ...(contact ? { contact } : {}),
    ...(input.token.trim() ? { gitea_token: input.token.trim() } : {}),
    ...(input.screenshots.length ? { screenshots: input.screenshots } : {}),
    ...(input.diagnosticsPack ? { diagnostics_pack: input.diagnosticsPack } : {}),
  };
}

async function addScreenshots(files: File[], current: FeedbackAttachment[], setScreenshots: Setter<FeedbackAttachment[]>, setAttachmentError: Setter<string>): Promise<void> {
  if (files.length === 0) return;
  if (current.length + files.length > MAX_SCREENSHOTS) {
    setAttachmentError('最多 5 张截图，请删掉多余的再添加');
    return;
  }
  for (const file of files) {
    const error = screenshotError(file);
    if (error) {
      setAttachmentError(error);
      return;
    }
  }
  const added = await Promise.all(files.map(attachmentOf));
  setScreenshots((items) => [...items, ...added].slice(0, MAX_SCREENSHOTS));
  setAttachmentError('');
}

async function pickScreenshots(port: ReturnType<typeof useShell>, add: (files: File[]) => Promise<void>, setAttachmentError: Setter<string>): Promise<void> {
  try {
    await add(await port.media.pickImages(true));
  } catch {
    setAttachmentError('选择截图失败，请重新选择 PNG/JPG 图片');
  }
}

async function pasteScreenshots(event: React.ClipboardEvent, add: (files: File[]) => Promise<void>): Promise<void> {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length === 0 && event.clipboardData?.items) {
    for (const item of Array.from(event.clipboardData.items)) {
      const file = item.getAsFile?.();
      if (file) files.push(file);
    }
  }
  if (files.length === 0) return;
  event.preventDefault();
  await add(files);
}

async function toggleDiagnostics(port: ReturnType<typeof useShell>, pressed: boolean, setPack: Setter<FeedbackAttachment | null>, setAttachmentError: Setter<string>): Promise<void> {
  if (!pressed) {
    setPack(null);
    setAttachmentError('');
    return;
  }
  const result: DiagnosticsPackOutcome = await port.ui.diagnosticsPack();
  if (result.kind === 'failed') {
    setPack(null);
    setAttachmentError(result.message || '诊断包生成失败，请重试');
    return;
  }
  setPack({ name: result.name, content_type: result.contentType, data: result.data });
  setAttachmentError('');
}

async function sendFeedback(port: ReturnType<typeof useShell>, request: FeedbackSpec, sending: boolean, setSending: Setter<boolean>, setOutcome: Setter<FeedbackOutcome | null>, setStep: Setter<FeedbackStep>, setSubmittedSpec: Setter<FeedbackSpec | null>): Promise<void> {
  if (sending) return;
  setSending(true);
  setSubmittedSpec(request);
  try {
    setOutcome(await port.feedback.send(request));
    setStep('receipt');
  } finally {
    setSending(false);
  }
}

function closeOnBackdrop(event: React.MouseEvent, onClose: () => void): void {
  if (event.target === event.currentTarget) onClose();
}

function closeOnEscape(event: React.KeyboardEvent, onClose: () => void): void {
  if (event.key === 'Escape') onClose();
}

interface FeedbackFormProps {
  title: string; setTitle: Setter<string>;
  category: string; setCategory: Setter<string>;
  body: string; setBody: Setter<string>;
  contact: string; setContact: Setter<string>;
  token: string; setToken: Setter<string>; tokenVisible: boolean; setTokenVisible: Setter<boolean>;
  screenshots: FeedbackAttachment[]; setScreenshots: Setter<FeedbackAttachment[]>;
  diagnosticsPack: FeedbackAttachment | null; attachmentError: string;
  diagnosticsAvailable: boolean;
  onPick(): void; onToggleDiagnostics(pressed: boolean): void;
  onClose(): void; onPreview(): void;
}

function FeedbackForm(props: FeedbackFormProps) {
  return (
    <>
      <label className='form-row'>
        <span className='form-row-label'>标题（可选）</span>
        <input value={props.title} onChange={(event) => props.setTitle(event.target.value)} />
      </label>
      <label className='form-row'>
        <span className='form-row-label'>分类</span>
        <select value={props.category} onChange={(event) => props.setCategory(event.target.value)}>{FEEDBACK_CATEGORIES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select>
      </label>
      <label className='form-row'>
        <span className='form-row-label'>正文</span>
        <textarea value={props.body} onChange={(event) => props.setBody(event.target.value)} rows={8} />
      </label>
      <label className='form-row'>
        <span className='form-row-label'>称呼或联系方式（可选，默认匿名）</span>
        <input value={props.contact} placeholder='匿名' onChange={(event) => props.setContact(event.target.value)} />
      </label>
      <label className='form-row'>
        <span className='form-row-label'>Gitea token（仅本次提交）</span>
        <input type={props.tokenVisible ? 'text' : 'password'} value={props.token} placeholder='粘贴你的 Gitea token' onChange={(event) => props.setToken(event.target.value)} />
      </label>
      <div className='form-row feedback-actions'>
        <button type='button' onClick={() => props.setTokenVisible(!props.tokenVisible)}>{props.tokenVisible ? '隐藏 token' : '显示 token'}</button>
        <span className='form-row-hint'>仅本次提交给 kacha-feedback 的中继，不保存、不进预览。</span>
      </div>
      <div className='form-row feedback-pick-row'>
        <span className='form-row-label'>截图（可粘贴，0–5 张 PNG/JPG，单张 ≤10MB）</span>
        <button type='button' onClick={props.onPick}>选择截图</button>
      </div>
      {props.screenshots.length > 0 && (
        <ul className='feedback-attachments'>
          {props.screenshots.map((shot, index) => (
            <li className='feedback-attachment' key={`${shot.name}-${index}`}>
              <span className='feedback-attachment-name'>{shot.name}</span>
              <button className='feedback-attachment-remove' type='button' aria-label={`移除 ${shot.name}`} onClick={() => props.setScreenshots((items) => items.filter((_, i) => i !== index))}>移除</button>
            </li>
          ))}
        </ul>
      )}
      <div className='form-row feedback-actions'>
        {props.diagnosticsAvailable ? (
          <>
            <button type='button' aria-pressed={props.diagnosticsPack !== null} onClick={() => props.onToggleDiagnostics(props.diagnosticsPack === null)}>
              {props.diagnosticsPack ? '取消附带脱敏诊断包' : '附带脱敏诊断包'}
            </button>
            <span className='form-row-hint'>仅版本、平台、运行状态与脱敏日志；不含密钥、凭据、主机名或画板内容。</span>
          </>
        ) : (
          <span className='form-row-hint'>诊断包导出暂不可用，反馈正文仍可发送。</span>
        )}
      </div>
      {props.attachmentError && <div className='form-alert form-alert-error' role='alert'>{props.attachmentError}</div>}
      <div className='modal-foot'>
        {!props.token.trim() && <span className='form-error modal-foot-note' role='alert'>{FEEDBACK_TOKEN_REQUIRED}</span>}
        <button onClick={props.onClose}>取消</button>
        <button className='primary' onClick={props.onPreview} disabled={!props.body.trim() || !props.token.trim()}>预览</button>
      </div>
    </>
  );
}

interface FeedbackPreviewProps {
  title: string; setTitle: Setter<string>; category: string; setCategory: Setter<string>;
  body: string; setBody: Setter<string>; spec: FeedbackSpec; attachmentSummary: string;
  sending: boolean; onBack(): void; onClose(): void; onSend(): void;
}

function FeedbackPreview(props: FeedbackPreviewProps) {
  return (
    <>
      <div className='feedback-preview'>
        <label className='form-row'>
          <span className='form-row-label'>标题（可选）</span>
          <input value={props.title} onChange={(event) => props.setTitle(event.target.value)} />
        </label>
        <label className='form-row'>
          <span className='form-row-label'>分类</span>
          <select value={props.category} onChange={(event) => props.setCategory(event.target.value)}>{FEEDBACK_CATEGORIES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select>
        </label>
        <label className='form-row'>
          <span className='form-row-label'>正文（可修改）</span>
          <textarea value={redactFeedbackText(props.body)} onChange={(event) => props.setBody(event.target.value)} rows={6} />
        </label>
        <div className='feedback-summary'>
          <p className='feedback-line'>标题：{props.spec.title || '（无）'}</p>
          <p className='feedback-line'>分类：{feedbackCategoryLabel(props.spec.category)}</p>
          <p className='feedback-line'>正文：{props.spec.body}</p>
          <p className='feedback-preview-meta'>自动元数据：版本 {props.spec.version}（build {props.spec.build || '未知'}）、系统 {props.spec.os}、当前画板 {props.spec.board_name || '（未打开画板）'}；只含画板名字，不含路径或密钥。</p>
          <p className='feedback-token-notice'>{FEEDBACK_TOKEN_NOTICE}</p>
          <p className='feedback-token-scope'>{FEEDBACK_TOKEN_SCOPE}</p>
          <p className='feedback-line'>提交者：{props.spec.contact ?? '匿名'}</p>
          <p className='feedback-line'>附件摘要：{props.attachmentSummary}。</p>
        </div>
      </div>
      <div className='modal-foot'>
        <button disabled={props.sending} onClick={props.onBack}>返回修改</button>
        <button disabled={props.sending} onClick={props.onClose}>取消</button>
        <button className='primary' disabled={props.sending} onClick={props.onSend}>确认发送</button>
      </div>
    </>
  );
}

interface FeedbackSuccessProps { outcome: FeedbackOutcome; }

function FeedbackSuccess({ outcome }: FeedbackSuccessProps) {
  return (
    <div className='feedback-receipt'>
      <p className='feedback-receipt-title'>已提交 {outcome.number ? <a href={outcome.url} target='_blank' rel='noreferrer'>#{outcome.number}</a> : ''}</p>
      {outcome.url && <p className='feedback-url'>{outcome.url}</p>}
    </div>
  );
}

interface FeedbackFailureProps {
  outcome: FeedbackOutcome; copied: boolean; sending: boolean;
  onClose(): void; onEditAgain(): void; onCopy(): void; onRetry(): void;
}

function FeedbackFailure(props: FeedbackFailureProps) {
  return (
    <>
      <div className='form-alert form-alert-error' role='alert'><p>{feedbackMessage(props.outcome)}</p></div>
      {props.outcome.url && (
        <p className='feedback-return-link'>返回链接：<a href={props.outcome.url} target='_blank' rel='noreferrer'>{props.outcome.number ? `#${props.outcome.number}` : '查看反馈'}</a></p>
      )}
      <div className='modal-foot'>
        <button onClick={props.onClose}>关闭</button>
        <button onClick={props.onEditAgain}>返回修改</button>
        <button disabled={props.copied} onClick={props.onCopy}>{props.copied ? '已复制内容' : '复制内容'}</button>
        {props.outcome.kind !== 'duplicate' && <button className='primary' disabled={props.sending} onClick={props.onRetry}>重试</button>}
      </div>
    </>
  );
}

interface FeedbackReceiptProps {
  outcome: FeedbackOutcome; copied: boolean; sending: boolean;
  onClose(): void; onEditAgain(): void; onCopy(): void; onRetry(): void;
}

function FeedbackReceipt(props: FeedbackReceiptProps) {
  if (isFailure(props.outcome)) return <FeedbackFailure {...props} />;
  return <FeedbackSuccess outcome={props.outcome} />;
}

/** 首屏反馈表单（#206 / #207 / #208）：预览可改，失败不丢内容，按 kind 给不同结局。 */
export function FeedbackDialog({ version, build, boardName, relayUrl, onClose }: FeedbackDialogProps) {
  const port = useShell();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<string>(FEEDBACK_CATEGORIES[0].code);
  const [body, setBody] = useState('');
  const [contact, setContact] = useState('');
  const [token, setToken] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [screenshots, setScreenshots] = useState<FeedbackAttachment[]>([]);
  const [diagnosticsPack, setDiagnosticsPack] = useState<FeedbackAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState('');
  const [step, setStep] = useState<FeedbackStep>('form');
  const [outcome, setOutcome] = useState<FeedbackOutcome | null>(null);
  const [sending, setSending] = useState(false);
  const [submittedSpec, setSubmittedSpec] = useState<FeedbackSpec | null>(null);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const spec = feedbackSpecOf({ title, category, body, version, build, boardName, relayUrl, contact, token, screenshots, diagnosticsPack });
  const attachmentSummary = [
    screenshots.length ? `截图 ${screenshots.length} 张（${screenshots.map((a) => a.name).join('、')}）` : '截图 0 张（无）',
    `诊断包 ${diagnosticsPack?.name ?? '未附带'}`,
  ].join('；');
  const add = (files: File[]) => addScreenshots(files, screenshots, setScreenshots, setAttachmentError);
  const pick = () => pickScreenshots(port, add, setAttachmentError);
  const paste = (event: React.ClipboardEvent) => pasteScreenshots(event, add);
  const toggle = (pressed: boolean) => toggleDiagnostics(port, pressed, setDiagnosticsPack, setAttachmentError);
  const send = (request: FeedbackSpec) => sendFeedback(port, request, sending, setSending, setOutcome, setStep, setSubmittedSpec);
  const editAgain = () => { setOutcome(null); setCopied(false); setStep('form'); };
  const copyContent = async () => { await port.media.copyText(feedbackClipboardText(submittedSpec ?? spec)); setCopied(true); };

  return (
    <div className='modal-backdrop' onMouseDown={(event) => closeOnBackdrop(event, onClose)}>
      <div className='modal feedback-dialog' role='dialog' aria-modal='true' aria-labelledby='feedback-title' onKeyDown={(event) => closeOnEscape(event, onClose)} onPaste={(event) => void paste(event)}>
        <div className='modal-head'>
          <h2 id='feedback-title'>反馈</h2>
          <button ref={closeRef} className='icon-button' aria-label='关闭反馈' onClick={onClose}>✕</button>
        </div>
        {step === 'form' && <FeedbackForm title={title} setTitle={setTitle} category={category} setCategory={setCategory} body={body} setBody={setBody} contact={contact} setContact={setContact} screenshots={screenshots} setScreenshots={setScreenshots} diagnosticsPack={diagnosticsPack} attachmentError={attachmentError} diagnosticsAvailable={!!port.features.diagnostics} onPick={() => void pick()} onToggleDiagnostics={(pressed) => void toggle(pressed)} token={token} setToken={setToken} tokenVisible={tokenVisible} setTokenVisible={setTokenVisible} onClose={onClose} onPreview={() => setStep('preview')} />}
        {step === 'preview' && <FeedbackPreview title={title} setTitle={setTitle} category={category} setCategory={setCategory} body={body} setBody={setBody} spec={spec} attachmentSummary={attachmentSummary} sending={sending} onBack={() => setStep('form')} onClose={onClose} onSend={() => void send(spec)} />}
        {step === 'receipt' && outcome && <FeedbackReceipt outcome={outcome} copied={copied} sending={sending} onClose={onClose} onEditAgain={editAgain} onCopy={() => void copyContent()} onRetry={() => void send(submittedSpec ?? spec)} />}
      </div>
    </div>
  );
}
