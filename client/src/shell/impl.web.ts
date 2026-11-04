// Web 版壳层：业务调用走同源 HTTP，密钥存 localStorage，网关由浏览器直连（ADR 0018）。
// 不 import 任何 @tauri-apps/*；UI 与 core 不直接调 HTTP，都经这里的端口。
import type { FetchLike } from "../core/gateway";
import { PACK_CANCELLED } from "../core/boardPack";
import { ApiError } from "./apiError";
import { DEFAULT_SETTINGS, serializeSettings } from "../core/settings";
import type { UpdateFlowPorts } from "../core/updateFlow";
import type { DesktopPort, Ipc, RelayPort, SessionPort, ShellImpl, UsagePort } from "./types";

/** core/ 仍按「输出根 + 相对路径」拼路径；Web 版固定一个虚拟根，壳层在边界剥掉。 */
export const VIRTUAL_ROOT = "/~";
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
    try {
      const body = await res.json();
      if (typeof body?.code === "string") code = body.code;
      if (typeof body?.message === "string") message = body.message;
    } catch {
      // 非 JSON 错误体（如网关代理的 HTML）保留状态码文案。
    }
    throw new ApiError(res.status, code, message);
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

const requireOp = () => (currentOp ??= newOpId());

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
    const res = await apiResponse(`/api/packs/export?op=${encodeURIComponent(op)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec) });
    const blob = await res.blob();
    downloadBlob(blob, target);
    return { task_dirs: (spec as { task_dirs: string[] }).task_dirs.length, bytes: blob.size };
  } catch (e) {
    if (cancelledOps.has(op)) throw new Error(PACK_CANCELLED);
    throw e;
  }
}

/** 流式上传：请求体是 File 本身（浏览器按流发送），不读进内存。 */
async function uploadPack(file: File): Promise<string> {
  const res = await apiResponse("/api/packs/uploads", { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
  return ((await res.json()) as { id: string }).id;
}

const discardUpload = async (id: string) => void (await api(`/api/packs/uploads/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }));

/** 进度轮询：桌面是事件推送，Web 轮询当前操作的 done/total。 */
function onPackProgress(handler: (progress: { done: number; total: number }) => void): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped || !currentOp) return;
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

/** Web 版不存在的能力（#24/#28 落地）在这里明确报错，不静默假装成功。 */
const unsupported = (what: string) => () => Promise.reject(new ApiError(501, "not_implemented", `Web 版暂不支持：${what}`));

export const ipc: Ipc = {
  appPaths: async () => ({ default_output_root: VIRTUAL_ROOT, app_data_dir: VIRTUAL_ROOT }),
  startupArgs: async () => [],
  readBoard: (path) => api(`/api/boards?${query(path)}`),
  writeBoard: async (path, text, options) => {
    const params = new URLSearchParams({ path: stripRoot(path) });
    if (options?.createOnly) params.set("create_only", "true");
    else if (options?.version) params.set("version", options.version);
    await api(`/api/boards?${params}`, textBody(text));
  },
  renameBoard: async (from, to, version) =>
    void (await api("/api/boards/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: stripRoot(from), to: stripRoot(to), ...(version ? { version } : {}) }) })),
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
  diagnosticsPreview: unsupported("诊断包（Web 版已移除）"),
  diagnosticsExport: unsupported("诊断包（Web 版已移除）"),
  // spec.files[].source 是 core 拼出的虚拟根绝对路径：在边界剥成相对用户数据根，服务端只收相对路径。
  boardPackExport: async (_outputRoot, target, spec) => boardPackExport({ ...spec, files: spec.files.map((f) => ({ ...f, source: stripRoot(f.source) })) }, target),
  boardPackEntries: (pack) => api(`/api/packs/uploads/${encodeURIComponent(pack)}/entries`),
  boardPackReadTexts: (pack, names) => api(`/api/packs/uploads/${encodeURIComponent(pack)}/texts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(names) }),
  boardPackImport: async (pack, _outputRoot, units) => {
    const op = requireOp();
    try {
      return await api(`/api/packs/uploads/${encodeURIComponent(pack)}/import?op=${encodeURIComponent(op)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(units) });
    } catch (e) {
      // 服务端以 409 cancelled / 文案「已取消」回取消；保持与桌面的文案约定。
      if (cancelledOps.has(op) || (e instanceof ApiError && e.message === PACK_CANCELLED)) throw new Error(PACK_CANCELLED);
      throw e;
    }
  },
  boardPackCancel: async (cancelled) => {
    if (cancelled) {
      const op = currentOp;
      if (!op) return;
      cancelledOps.add(op);
      await api(`/api/packs/ops/${encodeURIComponent(op)}/cancel`, { method: "POST", keepalive: true });
    } else {
      currentOp = newOpId();
    }
  },
  // 密钥不再进系统凭据库：留在浏览器 localStorage，供浏览器直接调用网关。
  secretGet: async () => localStorage.getItem(API_KEY_STORAGE),
  secretSet: async (key) => void localStorage.setItem(API_KEY_STORAGE, key),
  secretDelete: async () => void localStorage.removeItem(API_KEY_STORAGE),
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

const noop = async () => () => undefined;

const desktop: DesktopPort = {
  ask: async (text, options) => window.confirm(options?.title ? `${options.title}\n\n${text}` : text),
  message: async (text) => void window.alert(text),
  open: unsupported("系统文件对话框（#28 改为浏览器上传）"),
  save: unsupported("系统保存对话框（#24/#28 改为浏览器下载）"),
  setWindowSize: async () => undefined,
  onResized: noop,
  destroyWindow: async () => window.close(),
  onCloseRequested: noop,
  onSecondInstance: noop,
  onPackProgress: async (handler) => onPackProgress(handler),
  onDropPaths: noop,
  openExternal: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
  version: async () => (await webConfig()).version,
};

/** Web 版没有自动更新：流程照常构造，但发布检查恒为「没有新版本」，不发出请求。 */
function updateFlowPorts(protection: Pick<UpdateFlowPorts, "restartGuard" | "restartReleased">): UpdateFlowPorts {
  return {
    currentVersion: () => desktop.version(),
    platform: () => "web" as never,
    schedule: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    log: () => undefined,
    release: { fetchLatest: async () => null },
    updater: { check: async () => null },
    ...protection,
    restart: async () => undefined,
  };
}

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
const relay: RelayPort = {
  relayResult: ({ url, relDir, stem, signal }) =>
    api("/api/fs/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, dir: stripRoot(relDir), stem }), ...(signal ? { signal } : {}) }),
  commitRelayed: (relDir, from, stem) =>
    api("/api/fs/relay/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir: stripRoot(relDir), from, stem }) }),
  discardRelayed: async (relDir) => void (await api(`/api/fs/relay?dir=${encodeURIComponent(stripRoot(relDir))}`, { method: "DELETE", keepalive: true })),
};

const usage: UsagePort = {
  usage: () => api("/api/usage"),
  cleanupUnreferenced: (dirs) => api("/api/cleanup/unreferenced", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dirs }) }),
};

export const shell: ShellImpl = { web: true, ipc, httpFetch, fileUrl, desktop, session, relay, usage, updateFlowPorts, pack: { upload: uploadPack, discard: discardUpload } };

