// 顶栏主题切换入口（#265）：单个按钮在当前档位与另一档之间直接切换。
import type { ReactElement } from "react";
import type { ThemeChoice } from "../core/theme";
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
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" fill="currentColor" />
    </svg>
  );
}

export function ThemeSwitch({ choice, onChoose }: { choice: ThemeChoice; onChoose(choice: ThemeChoice): void }) {
  const next: ThemeChoice = choice === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      className="theme-switch"
      aria-label={"切到" + THEME_LABELS[next]}
      title={"当前" + THEME_LABELS[choice] + "，点击切到" + THEME_LABELS[next]}
      data-theme-choice={choice}
      onClick={() => onChoose(next)}
    >
      <ThemeIcon choice={choice} />
    </button>
  );
}
