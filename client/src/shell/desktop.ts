// 桌面壳适配器（#127）：把 MyGo 绑定折成界面认的壳端口。
//
// 桥（DesktopBridge）是 MyGo 生成的 client/src/mygo.ts 里 Shell.Info 的形状；测试用假桥，
// 不必真的起窗口。本切片只实现「壳信息 + 本地身份」，画板、文件、剪贴板、画板包留给后续切片：
// 那些能力在 features 里关掉，调用时返回 kind: "unavailable"（界面据此标「尚不可用」），
// 不抛裸错误、也不假装成功。

/** 桌面壳的可选能力开关，与 Go 侧 shellapp.Features 的 JSON 同形。 */
export interface DesktopFeatures {
  /** 生成（网关调用）。 */
  generation: boolean;
  /** 用量统计与未引用清理。 */
  usage: boolean;
  /** 画板包导出。 */
  pack_export: boolean;
}

/** Shell.Info 的返回值，与 Go 侧 shellapp.Info 的 JSON 同形。 */
export interface DesktopInfo {
  /** 应用版本。 */
  version: string;
  /** 本机唯一一份用户数据根的绝对路径。 */
  user_data_root: string;
  /** 画板目录的绝对路径（用户数据根下的 画板）。 */
  board_root: string;
  /** 可选能力开关。 */
  features: DesktopFeatures;
}

/** 桌面壳桥：MyGo 绑定与测试替身都满足它。 */
export interface DesktopBridge {
  info(): Promise<DesktopInfo>;
}

/** 端口失败的类别，与壳端口（#126）的 PortFailureKind 一致。 */
export type DesktopFailureKind = "unavailable" | "failed";

/** 本切片还没有的能力。 */
export type DesktopFeatureId = "generation" | "usage" | "packExport" | "archive" | "tidy" | "relay";

/** 端口失败：与壳端口的 PortError 同形（kind / code / feature），界面只按类别分支。 */
export class DesktopPortError extends Error {
  readonly kind: DesktopFailureKind;
  readonly code: string;
  /** kind = unavailable 时是哪个能力。 */
  readonly feature?: DesktopFeatureId;

  constructor(kind: DesktopFailureKind, code: string, message: string, feature?: DesktopFeatureId) {
    super(message);
    this.name = "DesktopPortError";
    this.kind = kind;
    this.code = code;
    if (feature) this.feature = feature;
  }
}

/** 能力的中文名，用来写「尚不可用」的提示。 */
const FEATURE_LABEL: Record<DesktopFeatureId, string> = {
  generation: "生成",
  usage: "用量统计",
  packExport: "画板包导出",
  archive: "归档",
  tidy: "整理",
  relay: "结果中转",
};

/** 界面用的能力开关：Go 侧的开关直接映射，本切片没有的能力一律 false。 */
export interface DesktopShellFeatures {
  generation: boolean;
  usage: boolean;
  packExport: boolean;
}

/** 本地身份：桌面客户端没有登录，也没有服务端会话。 */
export interface LocalIdentity {
  /** 固定的本机标识；不来自密钥，也不随密钥变化。 */
  fingerprint: string;
  /** 桌面壳永远不需要登录。 */
  requiresLogin: false;
}

/** 桌面壳：界面唯一依赖的那层。 */
export interface DesktopShell {
  /** 用户数据根的绝对路径。 */
  readonly userRoot: string;
  /** 画板目录的绝对路径。 */
  readonly boardRoot: string;
  /** 应用版本。 */
  readonly version: string;
  /** 可选能力开关；关掉的能力在界面上隐藏入口。 */
  readonly features: DesktopShellFeatures;
  /** 本地身份；不请求服务端。 */
  readonly session: {
    current(): Promise<LocalIdentity>;
    /** 桌面壳没有会话过期；返回的取消函数什么也不做。 */
    onExpired(listener: () => void): () => void;
  };
  /**
   * 取一项本切片还没有的能力：抛 kind: "unavailable" 的 DesktopPortError，
   * 消息里带能力名，界面可直接显示「尚不可用」。
   */
  unavailable(feature: DesktopFeatureId): never;
}

/** 本机标识：固定值，不含密钥，也不随密钥变化。 */
export const LOCAL_FINGERPRINT = "local";

/** 一次端口调用：桥的失败折成 DesktopPortError，消息保持原文。 */
function failed(e: unknown): DesktopPortError {
  const message = e instanceof Error ? e.message : String(e);
  return new DesktopPortError("failed", "bridge", message);
}

/** 打开桌面壳：读一次壳信息，之后都从这份快照回答。 */
export async function openDesktopShell(bridge: DesktopBridge): Promise<DesktopShell> {
  let info: DesktopInfo;
  try {
    info = await bridge.info();
  } catch (e) {
    throw failed(e);
  }
  const features: DesktopShellFeatures = {
    generation: info.features.generation,
    usage: info.features.usage,
    packExport: info.features.pack_export,
  };
  return {
    userRoot: info.user_data_root,
    boardRoot: info.board_root,
    version: info.version,
    features,
    session: {
      current: () => Promise.resolve({ fingerprint: LOCAL_FINGERPRINT, requiresLogin: false }),
      onExpired: () => () => {},
    },
    unavailable(feature: DesktopFeatureId): never {
      throw new DesktopPortError("unavailable", "unavailable", "桌面客户端：" + FEATURE_LABEL[feature] + "尚不可用", feature);
    },
  };
}
