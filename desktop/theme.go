package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 原生主题（#221）：前端的主题档位 → MyGo 原生主题源，驱动 Windows 标题栏与窗口底色。
//
// 真源在前端 core/settings.ts（settings.json 的 theme 字段）。这里只做两件事：
// 把页面传来的档位转给 MyGo，以及冷启动时从 settings.json 里只读一个字段决定窗口外观。

// 三档的原文值，与前端 ThemeChoice（client/src/core/theme.ts）一一对应。
const (
	themeDark   = "dark"
	themeLight  = "light"
	themeSystem = "system"
)

// windowBackgroundColor 是冷启动窗口底色：页面首绘之前窗口用的颜色。
//
// 两色取 client/src/styles/tokens.css 的 --app-bg 亮 / 暗值：不一致时冷启动到首帧之间会闪一下
// 另一种底色。light-dark(亮, 暗) 由 MyGo 按当前外观选。
const windowBackgroundColor = "light-dark(#d5d5ad, #111318)"

// themeSourceOf 把前端档位映射成 MyGo 主题源。
//
// 三档一一对应；空值与任何非法值都兜底为产品默认的暗色——与前端「非法值回退默认暗色」同一口径。
// 「跟随系统」必须翻译成 ThemeSystem：强行下发 dark 会让 MyGo 把 WebView 的
// prefers-color-scheme 也钉成暗色，前端的系统档就永远跟随不到浅色。
func themeSourceOf(choice string) mygo.ThemeSource {
	switch choice {
	case themeLight:
		return mygo.ThemeLight
	case themeSystem:
		return mygo.ThemeSystem
	default:
		return mygo.ThemeDark
	}
}

// settingsPath 返回 settings.json 在数据根里的位置（localstore 的元数据目录）。
func settingsPath(root string) string {
	return filepath.Join(root, localstore.MetaDir, "settings.json")
}

// startupTheme 决定冷启动时的窗口外观：只读 settings.json 的 theme 字段。
//
// 只取一个字符串、不校验 format_version、不解析其它字段、只读不写——所以不涉及前端
// newer / unreadable 的覆盖保护语义（那是前端写盘时的判定）。缺失、读不出来、JSON 写坏、
// 值非法都按产品默认暗色：这里只是窗口外观的首帧缓存，真源仍在前端。
func startupTheme(root string) mygo.ThemeSource {
	body, err := os.ReadFile(settingsPath(root))
	if err != nil {
		return mygo.ThemeDark
	}
	var saved struct {
		Theme string `json:"theme"`
	}
	if err := json.Unmarshal(body, &saved); err != nil {
		return mygo.ThemeDark
	}
	return themeSourceOf(saved.Theme)
}
