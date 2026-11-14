// 壳层的同源 HTTP 出口（#137）：所有业务请求都从这里走，连不上服务端统一报网络失败（status 0），
// 401 统一通知会话失效，非 2xx 一律抛 ApiError。
// 从 ipc.ts 拆出，便于单测这一层的行为（网络失败 / 401 / 非 JSON 错误体）。
import { ApiError } from "./apiError";
import { errorText } from "../core/errors";

/** 会话失效事件：HTTP 层统一识别 401，页面据此回到粘贴密钥界面（不能当成「没有数据」）。 */
export type SessionListener = () => void;

const sessionListeners = new Set<SessionListener>();

/** 订阅会话失效；返回退订的办法。 */
export function onSessionExpired(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

/** 通知所有订阅者会话已失效。 */
export function notifySessionExpired(): void {
  sessionListeners.forEach((l) => l());
}

/** 所有同源请求的唯一出口：连不上服务端统一报网络失败（status 0），401 统一通知会话失效。 */
export async function send(url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", ...init });
  } catch (e) {
    throw new ApiError(0, "network", `无法连接服务端：${errorText(e)}`);
  }
  if (res.status === 401) notifySessionExpired();
  return res;
}

/** 错误响应体里的 code / message / upstream_status：非 JSON 错误体（如网关代理的 HTML）保留状态码文案。 */
interface ErrorBody {
  code?: unknown;
  message?: unknown;
  upstream_status?: unknown;
}

/** 从错误响应体里读出 code 与 message；读不出来就用状态码文案。 */
async function errorFields(res: Response): Promise<{ code: string; message: string; upstreamStatus?: number }> {
  let code = "http_error";
  let message = `服务端返回 HTTP ${res.status}`;
  let upstreamStatus: number | undefined;
  try {
    const body = (await res.json()) as ErrorBody;
    if (typeof body?.code === "string") code = body.code;
    if (typeof body?.message === "string") message = body.message;
    if (typeof body?.upstream_status === "number") upstreamStatus = body.upstream_status;
  } catch {
    // 非 JSON 错误体：保留状态码文案。
  }
  return upstreamStatus === undefined ? { code, message } : { code, message, upstreamStatus };
}

/** 非 2xx 一律抛 ApiError；响应体（下载流、上传句柄）留给调用方读。 */
export async function apiResponse(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await send(url, init);
  if (res.ok) return res;
  const { code, message, upstreamStatus } = await errorFields(res);
  throw new ApiError(res.status, code, message, upstreamStatus);
}

/** 请求并解析 JSON 响应；204 无内容。 */
export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await apiResponse(url, init);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * 元数据接口（settings / ui-state / models-cache / capability-override）回的是 JSON 原文，不是 JSON 字符串：
 * 必须按文本读，否则 res.json() 会把内容解析成对象，前端当成损坏而静默重置。
 */
export async function apiText(url: string): Promise<string | null> {
  const res = await send(url);
  if (!res.ok) throw new ApiError(res.status, "read_failed", `读取失败（HTTP ${res.status}）：${url}`);
  const text = await res.text();
  return text.trim() === "null" || text === "" ? null : text;
}

/** 请求体：PUT 一段 JSON 原文。 */
export const textBody = (text: string): RequestInit => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: text });

/** 请求体：POST 一段 JSON。 */
export const jsonPost = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal: signal ?? null,
});
