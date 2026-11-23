// 顶栏主题切换入口（#221）：常驻紧凑三档分段控件，点击即时生效，不开弹窗、不进设置面板。
import { THEME_CHOICES, type ThemeChoice } from "../core/theme";
import { THEME_GROUP_LABEL, THEME_LABELS, themeOptionTitle } from "./themeText";

export function ThemeSwitch({ choice, onChoose }: { choice: ThemeChoice; onChoose(choice: ThemeChoice): void }) {
  return (
    <div className="theme-switch" role="group" aria-label={THEME_GROUP_LABEL}>
      {THEME_CHOICES.map((option) => (
        <button
          key={option}
          type="button"
          className="theme-switch-option"
          aria-label={THEME_LABELS[option]}
          aria-pressed={option === choice}
          title={themeOptionTitle(option)}
          onClick={() => onChoose(option)}
        >
          {THEME_LABELS[option]}
        </button>
      ))}
    </div>
  );
}
