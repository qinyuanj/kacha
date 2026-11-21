import { useEffect, useRef, useState } from "react";
import type { DiagnosticsPackOutcome, FeedbackAttachment, FeedbackOutcome, FeedbackSpec } from "../shell/port";
import { useShell } from "./shell";

const CATEGORIES = ["缺陷", "需求", "建议", "其他"] as const;
const MAX_SCREENSHOTS = 5;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg"];

/** #206 的脱敏只处理预览可见文本：本机路径换成占位，凭据整段移除。 */
export function redactFeedbackText(text: string): string {
  return text
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s:："'<>|*?]+[\\/])+[^\s:："'<>|*?]*/g, "<本地路径>")
    .replace(/(?:sk-[A-Za-z0-9_-]+|api[_-]?key\s*[:=]\s*\S+|token\s*[:=]\s*\S+)/gi, "<已隐藏>");
}

/** 画板名只取最后一段，绝不把路径带进反馈。 */
export function feedbackBoardName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1)?.replace(/\.kacha$/i, "") ?? "";
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
  if (typeof file.arrayBuffer === "function") {
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取截图失败"));
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(file);
    });
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return { name: file.name, content_type: file.type, data: btoa(binary) };
}

export interface FeedbackDialogProps {
  version: string;
  build: string;
  boardName: string;
  onClose(): void;
}

/** 首屏反馈表单（#206 / #207）：附件先本地校验，再随同一份 spec 交给 Feedback 端口。 */
export function FeedbackDialog({ version, build, boardName, onClose }: FeedbackDialogProps) {
  const port = useShell();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0]);
  const [body, setBody] = useState("");
  const [contact, setContact] = useState("");
  const [screenshots, setScreenshots] = useState<FeedbackAttachment[]>([]);
  const [diagnosticsPack, setDiagnosticsPack] = useState<FeedbackAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const [step, setStep] = useState<"form" | "preview" | "receipt">("form");
  const [outcome, setOutcome] = useState<FeedbackOutcome | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const name = feedbackBoardName(boardName);
  const spec: FeedbackSpec = {
    title: title.trim(),
    category,
    body: redactFeedbackText(body.trim()),
    version,
    build,
    os: navigator.userAgent,
    board_name: name,
    ...(contact.trim() ? { contact: contact.trim() } : {}),
    ...(screenshots.length ? { screenshots } : {}),
    ...(diagnosticsPack ? { diagnostics_pack: diagnosticsPack } : {}),
  };

  const addScreenshots = async (files: File[]) => {
    if (files.length === 0) return;
    if (screenshots.length + files.length > MAX_SCREENSHOTS) {
      setAttachmentError("最多 5 张截图，请删掉多余的再添加");
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
    setScreenshots((current) => [...current, ...added].slice(0, MAX_SCREENSHOTS));
    setAttachmentError("");
  };

  const pickScreenshots = async () => {
    try {
      await addScreenshots(await port.media.pickImages(true));
    } catch {
      setAttachmentError("选择截图失败，请重新选择 PNG/JPG 图片");
    }
  };

  const pasteScreenshots = async (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0 && event.clipboardData?.items) {
      for (const item of Array.from(event.clipboardData.items)) {
        const file = item.getAsFile?.();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) return;
    event.preventDefault();
    await addScreenshots(files);
  };

  const toggleDiagnostics = async (pressed: boolean) => {
    if (!pressed) {
      setDiagnosticsPack(null);
      setAttachmentError("");
      return;
    }
    const result: DiagnosticsPackOutcome = await port.ui.diagnosticsPack();
    if (result.kind === "failed") {
      setDiagnosticsPack(null);
      setAttachmentError(result.message || "诊断包生成失败，请重试");
      return;
    }
    setDiagnosticsPack({ name: result.name, content_type: result.contentType, data: result.data });
    setAttachmentError("");
  };

  const send = async () => {
    const result = await port.feedback.send(spec);
    setOutcome(result);
    setStep("receipt");
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="feedback-title" onKeyDown={(event) => event.key === "Escape" && onClose()} onPaste={(event) => void pasteScreenshots(event)}>
        <div className="modal-head">
          <h2 id="feedback-title">反馈</h2>
          <button ref={closeRef} className="icon-button" aria-label="关闭反馈" onClick={onClose}>✕</button>
        </div>
        {step === "form" && (
          <>
            <label className="form-row">标题（可选）<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label className="form-row">分类<select value={category} onChange={(event) => setCategory(event.target.value)}>{CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <label className="form-row">正文<textarea value={body} onChange={(event) => setBody(event.target.value)} rows={8} /></label>
            <label className="form-row">称呼或联系方式（可选，默认匿名）<input value={contact} placeholder="匿名" onChange={(event) => setContact(event.target.value)} /></label>
            <div className="form-row">
              <span>截图（可粘贴，0–5 张 PNG/JPG，单张 ≤10MB）</span>
              <button type="button" onClick={() => void pickScreenshots()}>选择截图</button>
            </div>
            {screenshots.length > 0 && (
              <ul className="feedback-attachments">
                {screenshots.map((shot, index) => (
                  <li key={`${shot.name}-${index}`}>
                    {shot.name}
                    <button type="button" aria-label={`移除 ${shot.name}`} onClick={() => setScreenshots((items) => items.filter((_, i) => i !== index))}>移除</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="form-row">
              <button type="button" aria-pressed={diagnosticsPack !== null} onClick={() => void toggleDiagnostics(diagnosticsPack === null)}>
                {diagnosticsPack ? "取消附带脱敏诊断包" : "附带脱敏诊断包"}
              </button>
              <span className="muted small">仅版本、平台、运行状态与脱敏日志；不含密钥、凭据、主机名或画板内容。</span>
            </div>
            {attachmentError && <div className="form-error" role="alert">{attachmentError}</div>}
            <div className="modal-foot">
              <button onClick={onClose}>取消</button>
              <button className="primary" onClick={() => setStep("preview")} disabled={!body.trim()}>预览</button>
            </div>
          </>
        )}
        {step === "preview" && (
          <>
            <div className="feedback-preview">
              <p>标题：{spec.title || "（无）"}</p>
              <p>分类：{spec.category}</p>
              <p>正文：{spec.body}</p>
              <p>版本：{spec.version}（build {spec.build || "未知"}）</p>
              <p>系统：{spec.os}</p>
              <p>当前画板：{spec.board_name || "（未打开画板）"}</p>
              <p>提交者：{spec.contact ?? "匿名"}</p>
              <p>截图：{screenshots.length ? screenshots.map((a) => a.name).join("、") : "（无）"}</p>
              <p>诊断包：{diagnosticsPack?.name ?? "（未附带）"}</p>
            </div>
            <div className="modal-foot">
              <button onClick={() => setStep("form")}>返回修改</button>
              <button onClick={onClose}>取消</button>
              <button className="primary" onClick={() => void send()}>确认发送</button>
            </div>
          </>
        )}
        {step === "receipt" && outcome && (
          <>
            {isFailure(outcome) ? (
              <div className="form-error" role="alert">{outcome.message}；请稍后重试。</div>
            ) : (
              <div className="feedback-receipt">
                <p>已提交 {outcome.number ? <a href={outcome.url} target="_blank" rel="noreferrer">#{outcome.number}</a> : ""}</p>
                {outcome.url && <p className="feedback-url">{outcome.url}</p>}
              </div>
            )}
            <div className="modal-foot">
              <button onClick={onClose}>关闭</button>
              {isFailure(outcome) && <button className="primary" onClick={() => void send()}>重试</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
