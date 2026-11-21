import { useEffect, useRef, useState } from "react";
import type { FeedbackOutcome, FeedbackSpec } from "../shell/port";
import { useShell } from "./shell";

const CATEGORIES = ["缺陷", "需求", "建议", "其他"] as const;

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

export interface FeedbackDialogProps {
  version: string;
  build: string;
  boardName: string;
  onClose(): void;
}

/** 首屏反馈表单（#206）：先填写、再预览、确认才调用 Feedback 端口。 */
export function FeedbackDialog({ version, build, boardName, onClose }: FeedbackDialogProps) {
  const port = useShell();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0]);
  const [body, setBody] = useState("");
  const [contact, setContact] = useState("");
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
  };

  const send = async () => {
    const result = await port.feedback.send(spec);
    setOutcome(result);
    setStep("receipt");
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="feedback-title" onKeyDown={(event) => event.key === "Escape" && onClose()}>
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
