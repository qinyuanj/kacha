// 图片信息的缓存（#137）：从 ui/context.ts 拆出的纯逻辑，便于单测缓存的命中、失败与清除。
// 读到过的图片只检查一次；null = 读取失败（缺图），不缓存，下次再查（文件可能被放回原处）。
import type { ImageInfo } from "../shell/port";

/** 已读到的图片信息：路径 → 读取中的 Promise。 */
export interface ImageInfoCache {
  /** 读图片信息：命中缓存就不再问端口。 */
  read(inspect: (absPath: string) => Promise<ImageInfo>, absPath: string): Promise<ImageInfo | null>;
  /** 记下一份已读到的信息（画板变更后当场重算自动宽高比时用）。 */
  prime(absPath: string, info: ImageInfo): void;
  /** 已经读到过的图片信息；还没读到或读取失败为 undefined。 */
  known(absPath: string): ImageInfo | undefined;
}

export function createImageInfoCache(): ImageInfoCache {
  // 读到过的图片只检查一次；null = 读取失败（缺图），不缓存，下次再查（文件可能被放回原处）。
  const pending = new Map<string, Promise<ImageInfo | null>>();
  // 已读到的图片信息的同步视图：画板变更当场重算自动宽高比时用，等不了 Promise。
  const resolved = new Map<string, ImageInfo>();

  const read = (inspect: (absPath: string) => Promise<ImageInfo>, absPath: string): Promise<ImageInfo | null> => {
    let inFlight = pending.get(absPath);
    if (!inFlight) {
      inFlight = inspect(absPath).then(
        (info) => {
          resolved.set(absPath, info);
          return info;
        },
        () => {
          // 读取失败不缓存：文件可能被放回原处，下次要能重查。
          pending.delete(absPath);
          resolved.delete(absPath);
          return null;
        },
      );
      pending.set(absPath, inFlight);
    }
    return inFlight;
  };

  return {
    read,
    prime: (absPath, info) => {
      pending.set(absPath, Promise.resolve(info));
      resolved.set(absPath, info);
    },
    known: (absPath) => resolved.get(absPath),
  };
}
