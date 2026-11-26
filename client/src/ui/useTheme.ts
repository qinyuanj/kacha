// 主题接线（#265）：内存档位 → 文档根 / 首帧镜像 / 宿主壳 / 设置写回。
//
// 切换不碰画板：这里没有 BoardChange，也不经过画布的任何 change 路径（ADR 0012）。
// 首帧镜像只是窗口外观的缓存，真源始终是设置文件里的 theme（core/settings.ts）。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyTheme,
  mirrorTheme,
  readMirroredTheme,
  themeStorage,
  type EffectiveTheme,
  type ThemeChoice,
} from "../core/theme";

export interface ThemeControl {
  choice: ThemeChoice;
  effective: EffectiveTheme;
  choose(next: ThemeChoice): void;
}

export function useTheme(input: {
  saved: ThemeChoice | null;
  syncNative(choice: ThemeChoice): Promise<void>;
  persist(choice: ThemeChoice): void;
}): ThemeControl {
  const [choice, setChoice] = useState<ThemeChoice>(() => input.saved ?? readMirroredTheme(themeStorage()));
  const chosenHere = useRef(false);
  const latest = useRef(input);
  latest.current = input;
  const saved = input.saved;

  useEffect(() => {
    if (saved !== null && !chosenHere.current) setChoice(saved);
  }, [saved]);

  const effective: EffectiveTheme = choice;
  useEffect(() => {
    applyTheme(document.documentElement, effective);
  }, [effective]);

  // 首帧镜像：档位确定就写一份。没选过且设置还没到时不写：那时的值只是默认值。
  useEffect(() => {
    if (saved === null && !chosenHere.current) return;
    mirrorTheme(themeStorage(), choice);
  }, [choice, saved]);

  useEffect(() => {
    if (!chosenHere.current || saved === null || choice === saved) return;
    latest.current.persist(choice);
  }, [choice, saved]);

  useEffect(() => {
    if (saved === null) return;
    void latest.current.syncNative(choice).catch(() => undefined);
  }, [choice, saved]);

  const choose = useCallback((next: ThemeChoice) => {
    chosenHere.current = true;
    setChoice(next);
  }, []);

  return { choice, effective, choose };
}
