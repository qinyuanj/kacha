// 多画板会话的去抖自动保存（#137）：从 ui/useBoardSessions.ts 拆出，各判定单独一个函数。
import { useCallback, useRef } from "react";
import { serializeBoard } from "../core/board";
import { sha256Hex } from "../core/sha256";
import { errorText } from "../core/errors";
import { samePath, saveErrorFlags, saveErrorText } from "./boardSessions";
import type { OkSession, Session } from "./useBoardSessions";

export const AUTOSAVE_DEBOUNCE_MS = 1000;

/** 每块画板一个计时器与一条串行写入链。 */
export interface Saver {
  timer: ReturnType<typeof setTimeout> | null;
  /** 串行化同一画板的写入，避免旧写入覆盖新写入。 */
  chain: Promise<void>;
}

/** 写一份画板：新建则只新建不覆盖；写完用同一算法回写新版本。 */
export async function writeSession(
  port: { board: { write(path: string, text: string, options?: { version?: string; createOnly?: boolean }): Promise<void> } },
  patch: (key: string, fn: (s: OkSession) => OkSession) => void,
  key: string,
  s: OkSession,
): Promise<void> {
  const text = serializeBoard(s.board);
  await port.board.write(s.path, text, s.version ? { version: s.version } : { createOnly: true });
  const version = await sha256Hex(new TextEncoder().encode(text));
  patch(key, (x) => (samePath(x.path, s.path) ? { ...x, version, saveError: null } : x));
}

/** 这一轮要不要写：会话不在、不是 ok、冲突或只读都不写。 */
export function writableNow(s: Session | undefined, isReadOnlyPath: (path: string) => boolean): s is OkSession {
  if (!s || s.status !== "ok" || s.conflicted) return false;
  return !isReadOnlyPath(s.path);
}

/** 写失败时把错误记到会话上。 */
export function noteSaveFailure(
  patch: (key: string, fn: (s: OkSession) => OkSession) => void,
  port: { ui: { log(kind: string, fields: Record<string, unknown>): void } },
  key: string,
  s: OkSession,
  e: unknown,
): void {
  port.ui.log("board_save_failed", { board_file: s.path.slice(s.path.lastIndexOf("/") + 1), reason: "autosave", message: errorText(e) });
  patch(key, (x) => ({ ...x, saveError: saveErrorText(s.path, errorText(e), isMissingError(e)), ...saveErrorFlags(e) }));
}

/** 读不到画板文件算不算「服务端已没有这块画板」。 */
function isMissingError(e: unknown): boolean {
  const kind = (e as { kind?: string } | null)?.kind;
  return kind === "missing";
}

/** 去抖自动保存：每块画板一个计时器与一条串行写入链。 */
export function useAutosave(
  patch: (key: string, fn: (s: OkSession) => OkSession) => void,
  sessionOf: (key: string) => Session | undefined,
  isReadOnlyPath: (path: string) => boolean,
  port: { board: { write(path: string, text: string, options?: { version?: string; createOnly?: boolean }): Promise<void> }; ui: { log(kind: string, fields: Record<string, unknown>): void } },
) {
  const savers = useRef(new Map<string, Saver>());
  /** 取（或建）一块画板的保存器。 */
  const saverOf = useCallback((key: string): Saver => {
    let saver = savers.current.get(key);
    if (!saver) {
      saver = { timer: null, chain: Promise.resolve() };
      savers.current.set(key, saver);
    }
    return saver;
  }, []);
  /** 立刻落盘：先清掉待写的计时器，再排队写一次。 */
  const flush = useCallback(
    (key: string): Promise<void> => {
      const saver = saverOf(key);
      if (saver.timer) clearTimeout(saver.timer);
      saver.timer = null;
      saver.chain = saver.chain.then(async () => {
        // 写入时再取最新会话：路径可能刚被重命名或另存。
        const s = sessionOf(key);
        // 归档画板只读（#90）：从不写回，服务端也会拒绝。
        if (!writableNow(s, isReadOnlyPath)) return;
        try {
          await writeSession(port, patch, key, s);
        } catch (e) {
          noteSaveFailure(patch, port, key, s, e);
        }
      });
      return saver.chain;
    },
    [patch, sessionOf, isReadOnlyPath, port, saverOf],
  );
  /** 排一次去抖保存。 */
  const scheduleSave = useCallback(
    (key: string) => {
      const saver = saverOf(key);
      if (saver.timer) clearTimeout(saver.timer);
      saver.timer = setTimeout(() => void flush(key), AUTOSAVE_DEBOUNCE_MS);
    },
    [flush, saverOf],
  );
  /** 关闭全部标签页（切换用户数据根时用）；先落盘。 */
  const flushAll = useCallback(async () => {
    const pending = [...savers.current.entries()].filter(([, s]) => s.timer !== null).map(([key]) => flush(key));
    await Promise.all([...pending, ...[...savers.current.values()].map((s) => s.chain)]);
  }, [flush]);
  /** 停掉一块画板的待写计时器（关标签页时）。 */
  const cancelTimer = useCallback((key: string) => {
    const saver = savers.current.get(key);
    if (saver?.timer) clearTimeout(saver.timer);
    savers.current.delete(key);
  }, []);
  return { flush, scheduleSave, flushAll, cancelTimer, savers, saverOf };
}
