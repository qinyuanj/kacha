// 顶栏主题切换入口（#221）：一个三态图标按钮，点一下按「暗色 → 浅色 → 跟随系统」循环。
// 图标是当前档位，不是目标：太阳=浅色，月亮=暗色，显示器=跟随系统（尺寸自适应）。
import type { ReactElement } from "react";
import { THEME_CHOICES, type ThemeChoice } from "../core/theme";
import { THEME_LABELS } from "./themeText";

function ThemeIcon({ choice }: { choice: ThemeChoice }): ReactElement {
  if (choice === "light") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="4" fill="currentColor" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      </svg>
    );
  }
  if (choice === "dark") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="4" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <path d="M9 20h6M12 17v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function ThemeSwitch({ choice, onChoose }: { choice: ThemeChoice; onChoose(choice: ThemeChoice): void }) {
  const index = THEME_CHOICES.indexOf(choice);
  const next = THEME_CHOICES[(index + 1) % THEME_CHOICES.length];
  return (
    <button
      type="button"
      className="theme-switch"
      aria-label={THEME_LABELS[choice]}
      title={"当前" + THEME_LABELS[choice] + "，点击切到" + THEME_LABELS[next]}
      data-theme-choice={choice}
      onClick={() => onChoose(next)}
    >
      <ThemeIcon choice={choice} />
    </button>
  );
}
