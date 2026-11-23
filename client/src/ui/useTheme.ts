// 主题接线（#221）：内存档位 → 有效主题 → 文档根 / 首帧镜像 / 宿主壳 / 设置写回。
//
// 切换不碰画板：这里没有 BoardChange，也不经过画布的任何 change 路径（ADR 0012）。
// 首帧镜像只是窗口外观的缓存，真源始终是设置文件里的 theme（core/settings.ts）。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyTheme,
  colorSchemeQuery,
  mirrorTheme,
  readMirroredTheme,
  resolveEffectiveTheme,
  themeStorage,
  watchColorScheme,
  type EffectiveTheme,
  type ThemeChoice,
} from "../core/theme";

/** 界面拿到的主题控制：当前档位、当前有效主题与切换动作。 */
export interface ThemeControl {
  choice: ThemeChoice;
  effective: EffectiveTheme;
  choose(next: ThemeChoice): void;
}

export function useTheme(input: {
  /** 设置真源里的档位；设置还没读到时为 null（先用首帧镜像显示）。 */
  saved: ThemeChoice | null;
  /** 通知宿主壳当前档位；失败在这里吞掉，不阻塞切换。 */
  syncNative(choice: ThemeChoice): Promise<void>;
  /** 写回设置文件；newer / unreadable 时由调用方决定不写盘。 */
  persist(choice: ThemeChoice): void;
}): ThemeControl {
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => colorSchemeQuery()?.matches ?? false);
  const [choice, setChoice] = useState<ThemeChoice>(() => input.saved ?? readMirroredTheme(themeStorage()));
  // 本次会话里亲手切过的：既不被随后读到的旧设置盖回去，也只有它才是值得写回设置的值。
  const chosenHere = useRef(false);
  // 回调放在 ref 里：调用方内联箭头函数不会让下面的副作用每次都重跑。
  const latest = useRef(input);
  latest.current = input;
  const saved = input.saved;

  useEffect(() => {
    if (saved !== null && !chosenHere.current) setChoice(saved);
  }, [saved]);

  // 系统偏好只在「跟随系统」档参与解析：其它档改了 effective 也不会变。
  useEffect(() => watchColorScheme(colorSchemeQuery(), setSystemPrefersDark), []);

  const effective = resolveEffectiveTheme(choice, systemPrefersDark);

  useEffect(() => {
    applyTheme(document.documentElement, effective);
  }, [effective]);

  // 首帧镜像：当前档位一确定就写一份。用户点选与「设置载入后应用」都走这一处，格式天然一致。
  // 用户没选过、设置也还没到时什么都不写：那时的档位只是默认值，写下去会在迁移场景里
  // 留下与设置冲突的猜测（首帧反而按猜错的那一档画）。
  useEffect(() => {
    if (saved === null && !chosenHere.current) return;
    mirrorTheme(themeStorage(), choice);
  }, [choice, saved]);

  // 持久化只有这一条路径：只写本次会话亲手选过、且与设置真源不一致的档位。
  // 没选过时 saved 是载入的真相（或还没载入）：把内存里的值抄回去毫无意义，还会和上面那条
  // 「载入后以设置为准」的同步互相打架。能不能真正落盘再由 setThemeState 的「已载入 / 不覆盖受保护文件」判定。
  useEffect(() => {
    if (!chosenHere.current || saved === null || choice === saved) return;
    latest.current.persist(choice);
  }, [choice, saved]);

  // 拿到设置后（以及每次切换）通知宿主壳一次：覆盖「设置读到前只按镜像显示」的那一段。
  useEffect(() => {
    if (saved === null) return;
    void latest.current.syncNative(choice).catch(() => undefined);
  }, [choice, saved]);

  const choose = useCallback((next: ThemeChoice) => {
    // 只改内存：镜像、宿主壳与写盘都由上面三个「档位变了」的副作用统一处理。
    chosenHere.current = true;
    setChoice(next);
  }, []);

  return { choice, effective, choose };
}
