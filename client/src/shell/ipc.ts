// 壳层（唯一实现）：业务调用走同源 HTTP，密钥存 localStorage，网关由浏览器直连（ADR 0018）。
// UI 与 core 不直接调业务 HTTP，都经这里的端口。
import type { FetchLike } from "../core/gateway";
import { PACK_CANCELLED, type PackContent, type PackEntryFact } from "../core/boardPack";
import type { ZipEntry } from "../core/zipIndex";
import { entryBody } from "../core/packHash";
import type { WorkerMessage, WorkerRequest } from "./packHash.worker";
import { ApiError } from "./apiError";
import { DEFAULT_SETTINGS, serializeSettings } from "../core/settings";
import type { BrowserPort, Ipc, PackContentPort, PackUploadPort, RelayPort, SessionPort, TransferPort, UsagePort } from "./types";

export type { BoardTexts, BrowserPort, ImageInfo, Ipc, PackContentPort, PackUploadPort, RelayPort, SessionPort, TransferPort, Usage, UsageCandidate, UsagePort } from "./types";

/** core/ 按「用户数据根 + 相对路径」拼路径；用户数据根在浏览器里是固定的虚拟根，壳层在边界剥掉，服务端只收相对路径。 */
export const VIRTUAL_ROOT = "/~";
export const userRoot = VIRTUAL_ROOT;
export const API_KEY_STORAGE = "kacha.apiKey";

/** 会话失效事件：HTTP 层统一识别 401，页面据此回到粘贴密钥界面（不能当成「没有数据」）。 */
type SessionListener = () => void;
const sessionListeners = new Set<SessionListener>();
export function onSessionExpired(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

export const stripRoot = (path: string): string =>
  path === VIRTUAL_ROOT ? "" : path.startsWith(`${VIRTUAL_ROOT}/`) ? path.slice(VIRTUAL_ROOT.length + 1) : path;

const query = (path: string) => `path=${encodeURIComponent(stripRoot(path))}`;

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", ...init });
  } catch (e) {
    throw new ApiError(0, "network", `无法连接服务端：${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401) sessionListeners.forEach((l) => l());
  if (!res.ok) {
    let code = "http_error";
    let message = `服务端返回 HTTP ${res.status}`;
    let upstreamStatus: number | undefined;
    try {
      const body = await res.json();
      if (typeof body?.code === "string") code = body.code;
      if (typeof body?.message === "string") message = body.message;
      if (typeof body?.upstream_status === "number") upstreamStatus = body.upstream_status;
    } catch {
      // 非 JSON 错误体（如网关代理的 HTML）保留状态码文案。
    }
    throw new ApiError(res.status, code, message, upstreamStatus);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** 元数据接口（settings / ui-state / models-cache / capability-override）回的是 JSON 原文，不是 JSON 字符串：
 *  必须按文本读，否则 res.json() 会把内容解析成对象，前端当成损坏而静默重置。 */
async function apiText(url: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin" });
  } catch (e) {
    throw new ApiError(0, "network", `无法连接服务端：${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401) sessionListeners.forEach((l) => l());
  if (!res.ok) throw new ApiError(res.status, "read_failed", `读取失败（HTTP ${res.status}）：${url}`);
  const text = await res.text();
  return text.trim() === "null" || text === "" ? null : text;
}

const textBody = (text: string): RequestInit => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: text });

async function readBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(`/api/fs/file?${query(path)}`, { credentials: "same-origin" });
  if (res.status === 401) sessionListeners.forEach((l) => l());
  if (!res.ok) throw new ApiError(res.status, "read_failed", `读取文件失败（HTTP ${res.status}）：${path}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function writeNewFile(path: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(`/api/fs/file?${query(path)}`, { method: "PUT", credentials: "same-origin", body: bytes.slice().buffer as ArrayBuffer });
  if (res.status === 401) sessionListeners.forEach((l) => l());
  if (res.status === 409) throw new ApiError(409, "already_exists", "目标已存在，只新建不覆盖");
  if (!res.ok) throw new ApiError(res.status, "write_failed", `写入文件失败（HTTP ${res.status}）：${path}`);
}

export const sessionApi = {
  /** 服务端向网关验证密钥；invalid_key 与 gateway_unavailable 由 ApiError.code 区分。 */
  login: (key: string) => api<{ fingerprint: string }>("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) }),
  current: () => api<{ fingerprint: string }>("/api/session"),
  logout: () => api<void>("/api/session", { method: "DELETE" }),
};

export const webConfig = () => api<{ version: string; gateway_url: string }>("/api/config");

// ---- 画板包（#24）----
// 导出 = 服务端边打包边发送的下载流；导入 = 流式上传到服务端临时文件，再判定与合并。
// 取消与进度按操作 id 隔离（一个用户的取消不影响其他用户 / 其他页面）：runCancellable 先 cancel(false)
// 复位，这里借此生成新的操作 id；之后同一次导出 / 导入与进度轮询都用它。

const newOpId = () => `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let currentOp: string | null = null;
const cancelledOps = new Set<string>();

/** 正在进行、带操作 id 的请求数：进度轮询只在有请求进行时才问服务端，操作结束后不再请求（#59）。 */
const inFlight = new Map<string, number>();
/** 每个操作一个中止信号：整包上传，以及去重导入里问已有、hash、开暂存、逐份上传都挂在它上面，取消时一并中止
 *  （同时通知服务端）。合并请求不挂：合并的取消经服务端的取消标记生效。 */
const opAborts = new Map<string, AbortController>();
/** 该操作的中止信号；还没有就建一个（操作 id 也可能由 requireOp 懒生成，没经过 cancel(false)）。 */
function opSignal(op: string): AbortSignal {
  let abort = opAborts.get(op);
  if (!abort) opAborts.set(op, (abort = new AbortController()));
  return abort.signal;
}
/** 浏览器本地阶段（Worker 里 hash）的进度：有值时进度轮询直接报它，不问服务端。 */
const localProgress = new Map<string, { done: number; total: number }>();

const requireOp = () => (currentOp ??= newOpId());

async function tracked<T>(op: string, run: () => Promise<T>): Promise<T> {
  inFlight.set(op, (inFlight.get(op) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const left = (inFlight.get(op) ?? 1) - 1;
    if (left > 0) inFlight.set(op, left);
    else inFlight.delete(op);
  }
}

/** 上传类请求按状态码给可读的失败文案（#60）：反向代理回的非 JSON 错误体也能看懂。 */
const UPLOAD_FAILURES: Record<number, string> = {
  408: "上传中断：超过 60 秒没有收到数据，请检查网络后重试",
  507: "服务器空间不足，请联系管理员",
};
const uploadFailure = (e: unknown) => (e instanceof ApiError && UPLOAD_FAILURES[e.status] ? new ApiError(e.status, e.code, UPLOAD_FAILURES[e.status]) : e);

/** 本操作已被取消，或服务端以 409 cancelled / 文案「已取消」回取消：统一成与桌面一致的取消文案。 */
const asCancelled = (op: string, e: unknown) => (cancelledOps.has(op) || (e instanceof ApiError && e.message === PACK_CANCELLED) ? new Error(PACK_CANCELLED) : e);

async function apiResponse(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", ...init });
  } catch (e) {
    throw new ApiError(0, "network", `无法连接服务端：${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401) sessionListeners.forEach((l) => l());
  if (!res.ok) {
    let code = "http_error";
    let message = `服务端返回 HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body?.code === "string") code = body.code;
      if (typeof body?.message === "string") message = body.message;
    } catch {
      // 非 JSON 错误体保留状态码文案。
    }
    throw new ApiError(res.status, code, message);
  }
  return res;
}

/** 触发浏览器下载；文件名由前端给定（不依赖 Content-Disposition 的中文编码）。 */
function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 延迟回收：让下载先拿到对象 URL。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 导出下载：响应体即 zip 流。中途取消 / 失败会中止流，blob() 随之 reject。 */
async function boardPackExport(spec: unknown, target: string): Promise<{ task_dirs: number; bytes: number }> {
  const op = requireOp();
  try {
    return await tracked(op, async () => {
      const res = await apiResponse(`/api/packs/export?op=${encodeURIComponent(op)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec) });
      const blob = await res.blob();
      // 取消请求晚于打包完成到达时，服务端照常发完；以前端的取消为准，不再触发下载。
      if (cancelledOps.has(op)) throw new Error(PACK_CANCELLED);
      downloadBlob(blob, target);
      return { task_dirs: (spec as { task_dirs: string[] }).task_dirs.length, bytes: blob.size };
    });
  } catch (e) {
    if (cancelledOps.has(op)) throw new Error(PACK_CANCELLED);
    throw e;
  }
}

/** 导出的 hash 阶段：服务端按操作 id 报进度、可取消（409 已取消）。 */
async function boardPackFacts(spec: unknown): Promise<PackEntryFact[]> {
  const op = requireOp();
  try {
    return await tracked(op, async () => {
      const facts = await api<PackEntryFact[]>(`/api/packs/export/facts?op=${encodeURIComponent(op)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec) });
      // 取消请求晚于服务端算完到达：以前端的取消为准。
      if (cancelledOps.has(op)) throw new Error(PACK_CANCELLED);
      return facts;
    });
  } catch (e) {
    throw asCancelled(op, e);
  }
}

/** 流式上传：请求体是 File 本身（浏览器按流发送），不读进内存。带当前操作 id：服务端报进度、可取消（#59）。 */
async function uploadPack(file: File): Promise<string> {
  const op = requireOp();
  if (cancelledOps.has(op)) throw new Error(PACK_CANCELLED);
  try {
    return await tracked(op, async () => {
      const res = await apiResponse(`/api/packs/uploads?op=${encodeURIComponent(op)}`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: file, signal: opSignal(op) });
      return ((await res.json()) as { id: string }).id;
    });
  } catch (e) {
    throw uploadFailure(asCancelled(op, e));
  }
}

const discardUpload = async (id: string) => void (await api(`/api/packs/uploads/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }));

/** 进度轮询：画板包服务端按操作 id 报告 done/total。 */
function onPackProgress(handler: (progress: { done: number; total: number }) => void): () => void {
  let stopped = false;
  const tick = async () => {
    const local = currentOp ? localProgress.get(currentOp) : undefined;
    if (!stopped && local) return handler(local);
    if (stopped || !currentOp || !inFlight.has(currentOp)) return;
    try {
      const res = await fetch(`/api/packs/ops/${encodeURIComponent(currentOp)}`, { credentials: "same-origin" });
      if (res.ok) handler((await res.json()) as { done: number; total: number });
    } catch {
      // 网络抖动不当作进度。
    }
  };
  const timer = setInterval(tick, 200);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export const ipc: Ipc = {
  readBoard: (path) => api(`/api/boards?${query(path)}`),
  writeBoard: async (path, text, options) => {
    const params = new URLSearchParams({ path: stripRoot(path) });
    if (options?.createOnly) params.set("create_only", "true");
    else if (options?.version) params.set("version", options.version);
    await api(`/api/boards?${params}`, textBody(text));
  },
  renameBoard: async (from, to, version) =>
    void (await api("/api/boards/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: stripRoot(from), to: stripRoot(to), ...(version ? { version } : {}) }) })),
  deleteBoard: async (path, version) => {
    const params = new URLSearchParams({ path: stripRoot(path) });
    if (version) params.set("version", version);
    await api(`/api/boards?${params}`, { method: "DELETE" });
  },
  listBoardNames: (dir) => api(`/api/boards/names?dir=${encodeURIComponent(stripRoot(dir))}`),
  readUiState: () => apiText("/api/ui-state"),
  writeUiState: async (text) => void (await api("/api/ui-state", textBody(text))),
  readCapabilityOverride: () => apiText("/api/capability-override"),
  inspectImage: (path) => api(`/api/fs/inspect-image?${query(path)}`),
  // 首次使用（服务端还没有 settings.json）时以服务端下发的网关地址为默认，避免两端默认不一致。
  readSettings: async () => {
    const text = await apiText("/api/settings");
    if (text !== null) return text;
    const config = await webConfig();
    return serializeSettings({ ...DEFAULT_SETTINGS, base_url: config.gateway_url });
  },
  writeSettings: async (text) => void (await api("/api/settings", textBody(text))),
  readModelsCache: () => apiText("/api/models-cache"),
  writeModelsCache: async (text) => void (await api("/api/models-cache", textBody(text))),
  logEvent: async (kind, fields) =>
    void (await api("/api/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, fields }) })),
  // spec.files[].source 是 core 拼出的虚拟根绝对路径：在边界剥成相对用户数据根，服务端只收相对路径。
  boardPackFacts: async (spec) => boardPackFacts({ ...spec, files: spec.files.map((f) => ({ ...f, source: stripRoot(f.source) })) }),
  boardPackExport: async (target, spec) => boardPackExport({ ...spec, files: spec.files.map((f) => ({ ...f, source: stripRoot(f.source) })) }, target),
  boardPackEntries: (pack) => api(`/api/packs/uploads/${encodeURIComponent(pack)}/entries`),
  boardPackReadTexts: (pack, names) => api(`/api/packs/uploads/${encodeURIComponent(pack)}/texts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(names) }),
  boardPackImport: async (pack, units, duplicates) => {
    const op = requireOp();
    // 上传之后、合并之前被取消：服务端还没有这个操作，取消标记只在这里，不再发起合并。
    if (cancelledOps.has(op)) throw new Error(PACK_CANCELLED);
    try {
      return await tracked(op, () => api(`/api/packs/uploads/${encodeURIComponent(pack)}/import?op=${encodeURIComponent(op)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ units, duplicates: Object.entries(duplicates).map(([path, source]) => ({ path, source })) }) }));
    } catch (e) {
      throw asCancelled(op, e);
    }
  },
  boardPackCancel: async (cancelled) => {
    if (cancelled) {
      const op = currentOp;
      if (!op) return;
      cancelledOps.add(op);
      opAborts.get(op)?.abort(new Error(PACK_CANCELLED));
      await api(`/api/packs/ops/${encodeURIComponent(op)}/cancel`, { method: "POST", keepalive: true });
    } else {
      // 换新操作：上一个操作的中止信号不再有人用。
      if (currentOp) opAborts.delete(currentOp);
      currentOp = newOpId();
      opSignal(currentOp);
    }
  },
  listDir: (path) => api(`/api/fs/dir?${query(path)}`),
  fileSha256: (path) => api(`/api/fs/sha256?${query(path)}`),
  isFile: (path) => api(`/api/fs/is-file?${query(path)}`),
  readFileBytes: readBytes,
  writeNewFile,
};

/** 网关请求由浏览器原生 fetch 直连（网关 CORS 已放开）。 */
export const httpFetch: FetchLike = (url, init) => fetch(url, init);

/** 图片地址走同源读文件接口，靠会话 cookie 认人。 */
export const fileUrl = (path: string) => `/api/fs/file?${query(path)}`;

/** 节点上显示用的缩略图地址；放大预览、图层查看、下载与上传参考图仍用 `fileUrl` / 原图字节。 */
export const thumbUrl = (path: string) => `/api/fs/thumb?${query(path)}`;

export const browser: BrowserPort = {
  ask: async (text, options) => window.confirm(options?.title ? `${options.title}\n\n${text}` : text),
  message: async (text, options) => void window.alert(options?.title ? `${options.title}\n\n${text}` : text),
  onPackProgress: async (handler) => onPackProgress(handler),
  openExternal: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
  version: async () => (await webConfig()).version,
};

export const session: SessionPort = {
  login: sessionApi.login,
  current: sessionApi.current,
  logout: sessionApi.logout,
  config: webConfig,
  onExpired: onSessionExpired,
  readStoredKey: () => localStorage.getItem(API_KEY_STORAGE),
  storeKey: (key) => localStorage.setItem(API_KEY_STORAGE, key),
  clearStoredKey: () => localStorage.removeItem(API_KEY_STORAGE),
};

/** 结果中转：地址交给服务端，取消经 AbortSignal 传到服务端（断开即中止下载）。 */
export const relay: RelayPort = {
  relayResult: ({ url, relDir, stem, signal }) =>
    api("/api/fs/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, dir: stripRoot(relDir), stem }), signal: signal ?? null }),
  commitRelayed: (relDir, from, stem) =>
    api("/api/fs/relay/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir: stripRoot(relDir), from, stem }) }),
  discardRelayed: async (relDir) => void (await api(`/api/fs/relay?dir=${encodeURIComponent(stripRoot(relDir))}`, { method: "DELETE", keepalive: true })),
};

/** 浏览器文件传输（#28）：本机图片经隐藏 input 选择 / HTML5 拖入，上传后由服务端按内容哈希落盘；
 *  下载用隐藏 <a> 指向附件接口（响应带 Content-Disposition，浏览器另存为）。 */
export const transfer: TransferPort = {
  pickLocalImages: (multiple) =>
    new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,.heic,.heif";
      input.multiple = multiple;
      // 必须留在文档里：部分浏览器对脱离文档的 input 不弹选择器。
      input.style.position = "fixed";
      input.style.left = "-10000px";
      const done = (files: File[]) => {
        input.remove();
        resolve(files);
      };
      input.addEventListener("change", () => done([...(input.files ?? [])]));
      input.addEventListener("cancel", () => done([]));
      document.body.append(input);
      input.click();
    }),
  uploadReference: (file) => api<{ path: string; sha256: string }>("/api/upload/reference", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file }),
  downloadImage: (path, name) => {
    const params = new URLSearchParams({ path: stripRoot(path) });
    if (name) params.set("name", name);
    triggerDownload(`/api/download/result?${params}`);
  },
  downloadBoardResults: (boardPath) => triggerDownload(`/api/download/board-results?path=${encodeURIComponent(stripRoot(boardPath))}`),
};

function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  // 真正的保存对话框由 Content-Disposition 触发；download 属性只兜底。
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
}

export const usage: UsagePort = {
  usage: () => api("/api/usage"),
  cleanupUnreferenced: (dirs) => api("/api/cleanup/unreferenced", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dirs }) }),
};

export const packUpload: PackUploadPort = { upload: uploadPack, discard: discardUpload };

// ---- 去重上传（#62）----

const jsonPost = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: signal ?? null });

/** 在当前操作下跑一个可取消的请求：已取消就不发；被中止或服务端回取消都统一成取消文案，上传类状态码给可读文案。 */
async function inOp<T>(run: (op: string, signal: AbortSignal) => Promise<T>): Promise<T> {
  const op = requireOp();
  if (cancelledOps.has(op)) throw new Error(PACK_CANCELLED);
  try {
    return await tracked(op, () => run(op, opSignal(op)));
  } catch (e) {
    throw uploadFailure(asCancelled(op, e));
  }
}

/**
 * 在当前操作下跑一次 Worker（见 packHash.worker.ts）：已取消就不起；操作被中止即以「已取消」reject 并 terminate。
 * onProgress 收到的进度经 localProgress 报给进度轮询。
 */
function inWorker<T>(request: WorkerRequest, settle: (m: Exclude<WorkerMessage, { kind: "progress" | "error" }>) => T, onProgress?: (done: number, total: number) => void): Promise<T> {
  const op = requireOp();
  if (cancelledOps.has(op)) return Promise.reject(new Error(PACK_CANCELLED));
  const signal = opSignal(op);
  const worker = new Worker(new URL("./packHash.worker.ts", import.meta.url), { type: "module" });
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error(PACK_CANCELLED)), { once: true });
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.kind === "progress") onProgress?.(m.done, m.total);
      else if (m.kind === "error") reject(new Error(`无法读取画板包：${m.message}`));
      else resolve(settle(m));
    };
    worker.onerror = (e) => reject(new Error(`无法读取画板包：${e.message}`));
    worker.postMessage(request);
  }).finally(() => worker.terminate());
}

/** hash 阶段：Worker 里按条目流式算 sha256，进度经 localProgress 报给进度轮询；取消即 terminate。 */
function hashInWorker(file: File, entries: ZipEntry[]): Promise<PackEntryFact[]> {
  const op = requireOp();
  localProgress.set(op, { done: 0, total: entries.reduce((n, e) => n + e.size, 0) });
  return inWorker(
    { kind: "hash", file, entries },
    (m) => {
      if (m.kind !== "hashed") throw new Error("无法读取画板包：Worker 回了意外的消息");
      return m.facts;
    },
    (done, total) => localProgress.set(op, { done, total }),
  ).finally(() => localProgress.delete(op));
}

/** 一份内容的上传体：stored 条目是包文件的切片（浏览器按流发送，不读进内存）；deflate 条目在 Worker 里解压成 Blob，
 *  解压后的字节不进主线程内存。 */
async function contentBody({ file, entry }: PackContent): Promise<Blob> {
  if (entry.method === 0) return entryBody(file, entry);
  return inWorker({ kind: "body", file, entry }, (m) => {
    if (m.kind !== "body") throw new Error("无法读取画板包：Worker 回了意外的消息");
    return m.body;
  });
}

export const packContent: PackContentPort = {
  existing: (units) => inOp((_op, signal) => api("/api/packs/existing", jsonPost(units, signal))),
  hash: hashInWorker,
  stage: () => inOp(async (_op, signal) => (await api<{ id: string }>("/api/packs/staging", { method: "POST", signal })).id),
  uploadContent: (staging, sha256, content, progress) =>
    inOp(async (op, signal) => {
      const body = await contentBody(content);
      const params = new URLSearchParams({ op, done: String(progress.done), total: String(progress.total) });
      await apiResponse(`/api/packs/staging/${encodeURIComponent(staging)}/contents/${sha256}?${params}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body, signal });
    }),
  // 合并不中止请求：取消经服务端的取消标记生效（409），与整包导入一致。
  importContent: (staging, units, files) => inOp((op) => api(`/api/packs/staging/${encodeURIComponent(staging)}/import?op=${encodeURIComponent(op)}`, jsonPost({ units, files }))),
  discardStaging: async (staging) => void (await api(`/api/packs/staging/${encodeURIComponent(staging)}`, { method: "DELETE", keepalive: true })),
};
