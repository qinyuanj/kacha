// 进入界面的会话流程判定（#137）：从 ui/Root.tsx 拆出的纯逻辑，便于单测。
// 组件只留接线与 DOM 摆放。
import { errorText } from "../core/errors";

/** 进入界面的阶段。 */
export type Phase = "loading" | "enter" | "ready";

/** 壳的会话能力（端口的 session 分组）。 */
export interface SessionProbe {
  /** 是否需要登录界面：桌面壳没有服务端会话，恒为 false（#127）。 */
  readonly requiresLogin?: boolean;
  /** 读壳信息：拿版本号。 */
  config(): Promise<{ version: string; gateway_url: string }>;
  /** 读本地留着的密钥。 */
  readStoredKey(): string | null;
  /** 校验当前会话（本地有密钥时才问）。 */
  current(): Promise<{ fingerprint: string }>;
  /** 提交密钥给服务端校验。 */
  login(key: string): Promise<{ fingerprint: string }>;
  /** 把密钥存进浏览器本地存储。 */
  storeKey(key: string): void;
}

/** 启动流程的结果。 */
export type BootResult =
  /** 进工作台。 */
  | { kind: "ready"; version: string }
  /** 要用户粘贴密钥。 */
  | { kind: "enter"; version: string }
  /** 连不上服务端：工作台起不来。 */
  | { kind: "fatal"; message: string };

/**
 * 启动流程：读壳信息 → 桌面壳直接进工作台 → 本地有密钥且会话有效就进工作台 → 否则要粘贴密钥。
 * 401 或网络失败都回到粘贴界面（由用户重新提交）。
 */
export async function bootSession(session: SessionProbe): Promise<BootResult> {
  let version: string;
  try {
    version = (await session.config()).version;
  } catch (e) {
    return { kind: "fatal", message: `无法连接 Kacha 服务端：${errorText(e)}` };
  }
  // 桌面壳没有登录（#127）：不需要粘贴密钥，直接进工作台。
  if (session.requiresLogin === false) return { kind: "ready", version };
  // 已有会话 cookie（HttpOnly，JS 读不到）且本地还留着密钥：直接进工作台。
  if (session.readStoredKey()) {
    try {
      await session.current();
      return { kind: "ready", version };
    } catch {
      // 401 或网络失败都回到粘贴界面，由用户重新提交。
    }
  }
  return { kind: "enter", version };
}

/** 提交密钥的结果。 */
export type LoginResult = { kind: "ready" } | { kind: "error"; message: string };

/** 提交密钥：服务端校验失败给错误，成功进工作台。 */
export async function submitKey(session: SessionProbe, key: string): Promise<LoginResult> {
  try {
    await session.login(key);
    session.storeKey(key);
    return { kind: "ready" };
  } catch (e) {
    // invalid_key（密钥问题）与 gateway_unavailable / network（服务故障）分开显示。
    return { kind: "error", message: e instanceof Error ? e.message : `验证失败：${String(e)}` };
  }
}
/** 此刻该显示哪一屏：启动失败 → 加载中 → 粘贴密钥 → 工作台。 */
export function screenOf(fatal: string | null, phase: Phase): "fatal" | "loading" | "enter" | "ready" {
  if (fatal) return "fatal";
  if (phase === "loading") return "loading";
  if (phase === "enter") return "enter";
  return "ready";
}
