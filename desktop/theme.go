package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 原生主题（#265）：前端的固定两态档位 → MyGo 原生主题源，驱动 Windows 标题栏与窗口底色。
//
// 真源在前端 core/settings.ts（settings.json 的 theme 字段）。这里只做两件事：
// 把页面传来的档位转给 MyGo，以及冷启动时从 settings.json 里只读一个字段决定窗口外观。

// 两态的原文值，与前端 ThemeChoice（client/src/core/theme.ts）一一对应。
const (
	themeDark  = "dark"
	themeLight = "light"
)

// windowBackgroundColor 是冷启动窗口底色：页面首绘之前窗口用的颜色。
//
// 两色取 client/src/styles/tokens.css 的 --app-bg 亮 / 暗值：不一致时冷启动到首帧之间会闪一下
// 另一种底色。light-dark(亮, 暗) 由 MyGo 按当前外观选。
const windowBackgroundColor = "light-dark(#d5d5ad, #111318)"

// themeSourceOf 把前端档位映射成 MyGo 主题源。
//
// 两态一一对应；旧 system、空值与任何非法值都兜底为产品默认的浅色——与前端
// 「非法值与旧 system 回退默认浅色」同一口径。原生窗口不再跟随系统配色。
func themeSourceOf(choice string) mygo.ThemeSource {
	if choice == themeDark {
		return mygo.ThemeDark
	}
	return mygo.ThemeLight
}

// settingsPath 返回 settings.json 在数据根里的位置（localstore 的元数据目录）。
func settingsPath(root string) string {
	return filepath.Join(root, localstore.MetaDir, "settings.json")
}

// startupTheme 决定冷启动时的窗口外观：只读 settings.json 的 theme 字段。
//
// 只取一个字符串、不校验 format_version、不解析其它字段、只读不写——所以不涉及前端
// newer / unreadable 的覆盖保护语义（那是前端写盘时的判定）。缺失、旧 system、读不出来、
// JSON 写坏、值非法都按产品默认浅色；显式 dark 保持深色。
func startupTheme(root string) mygo.ThemeSource {
	body, err := os.ReadFile(settingsPath(root))
	if err != nil {
		return themeSourceOf("")
	}
	var saved struct {
		Theme string `json:"theme"`
	}
	if err := json.Unmarshal(body, &saved); err != nil {
		return themeSourceOf("")
	}
	return themeSourceOf(saved.Theme)
}
