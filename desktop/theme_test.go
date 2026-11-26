package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 固定两态映射（#265）：显式深色保持，旧 system 与缺失/非法值都迁到浅色。
func TestThemeSourceOf(t *testing.T) {
	cases := []struct {
		choice string
		want   mygo.ThemeSource
		note   string
	}{
		{"dark", mygo.ThemeDark, "显式深色"},
		{"light", mygo.ThemeLight, "显式浅色"},
		{"system", mygo.ThemeLight, "旧 system 迁浅色"},
		{"", mygo.ThemeLight, "空值默认浅色"},
		{"Dark", mygo.ThemeLight, "大小写不对算非法"},
		{"auto", mygo.ThemeLight, "非法值默认浅色"},
		{"\u6697\u8272", mygo.ThemeLight, "非 ASCII 也不 panic"},
	}
	for _, c := range cases {
		if got := themeSourceOf(c.choice); got != c.want {
			t.Fatalf("themeSourceOf(%q) = %q，想要 %q（%s）", c.choice, got, c.want, c.note)
		}
	}
}

// 冷启动底色必须匹配当前固定主题，不再按系统外观自动切换。
func TestWindowBackgroundColorIsLightDark(t *testing.T) {
	if !strings.HasPrefix(windowBackgroundColor, "light-dark(") || !strings.HasSuffix(windowBackgroundColor, ")") {
		t.Fatalf("窗口底色 %q 不是 light-dark(亮, 暗) 形式：冷启动会按单一色闪一下", windowBackgroundColor)
	}
	inner := strings.TrimSuffix(strings.TrimPrefix(windowBackgroundColor, "light-dark("), ")")
	if parts := strings.Split(inner, ", "); len(parts) != 2 {
		t.Fatalf("窗口底色应该正好两个色值（亮, 暗），实际 %q", inner)
	}
}

// 冷启动只读 theme 字段：system、缺失、坏值都浅色，显式深色保持。
func TestStartupThemeReadsOnlyThemeField(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		write  bool
		isDir  bool
		want   mygo.ThemeSource
	}{
		{name: "没有 settings.json", write: false, want: mygo.ThemeLight},
		{name: "浅色", body: `{"format_version":1,"theme":"light"}`, write: true, want: mygo.ThemeLight},
		{name: "旧 system", body: `{"format_version":1,"theme":"system"}`, write: true, want: mygo.ThemeLight},
		{name: "暗色", body: `{"format_version":1,"theme":"dark"}`, write: true, want: mygo.ThemeDark},
		{name: "没有 theme 字段", body: `{"format_version":1}`, write: true, want: mygo.ThemeLight},
		// 版本过新只在写盘时保护（前端判定）：窗口外观照旧按 theme 走。
		{name: "版本过新", body: `{"format_version":9,"theme":"dark"}`, write: true, want: mygo.ThemeDark},
		{name: "theme 非法", body: `{"theme":"auto"}`, write: true, want: mygo.ThemeLight},
		{name: "JSON 写坏", body: "{oops", write: true, want: mygo.ThemeLight},
		{name: "读不出来（settings.json 是目录）", write: false, isDir: true, want: mygo.ThemeLight},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, localstore.MetaDir)
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatalf("建元数据目录: %v", err)
			}
			path := settingsPath(root)
			if c.isDir {
				if err := os.MkdirAll(path, 0o755); err != nil {
					t.Fatalf("建目录: %v", err)
				}
			} else if c.write {
				if err := os.WriteFile(path, []byte(c.body), 0o600); err != nil {
					t.Fatalf("写 settings.json: %v", err)
				}
			}
			if got := startupTheme(root); got != c.want {
				t.Fatalf("startupTheme = %q，想要 %q", got, c.want)
			}
			if c.write && !c.isDir {
				after, err := os.ReadFile(path)
				if err != nil || string(after) != c.body {
					t.Fatalf("settings.json 被改动了：%q（err=%v）", string(after), err)
				}
			}
		})
	}
}

// tokensAppBg 取 client/src/styles/tokens.css 里某个主题块的 --app-bg 值。
//
// 同一份 tokens.css 里 :root[data-theme="light"] 出现多次（还有只覆盖个别变量的补充小节），
// 所以按块扫，取第一个真的定义了 --app-bg 的那块。
func tokensAppBg(t *testing.T, css, theme string) string {
	t.Helper()
	selector := ":root[data-theme=\"" + theme + "\"]"
	const marker = "--app-bg:"
	rest := css
	for {
		i := strings.Index(rest, selector)
		if i < 0 {
			t.Fatalf("client/src/styles/tokens.css 的 %s 块里找不到 --app-bg", selector)
		}
		rest = rest[i+len(selector):]
		open := strings.Index(rest, "{")
		end := strings.Index(rest, "}")
		if open < 0 || end < open {
			continue
		}
		block := rest[open+1 : end]
		rest = rest[end+1:]
		j := strings.Index(block, marker)
		if j < 0 {
			continue
		}
		value := block[j+len(marker):]
		if k := strings.Index(value, ";"); k >= 0 {
			value = value[:k]
		}
		return strings.TrimSpace(value)
	}
}

// 窗口底色与前端 --app-bg 是同一契约的两处写法（#221）：tokens.css 改了而这里没跟上，
// 冷启动到首帧之间就会闪一下另一种底色。值仍由 tokens.css 决定，这里只拦住漂移。
func TestWindowBackgroundColorMatchesTokens(t *testing.T) {
	body, err := os.ReadFile("../client/src/styles/tokens.css")
	if err != nil {
		t.Fatalf("读 client/src/styles/tokens.css: %v", err)
	}
	css := string(body)
	light, dark := tokensAppBg(t, css, "light"), tokensAppBg(t, css, "dark")
	want := "light-dark(" + light + ", " + dark + ")"
	if windowBackgroundColor != want {
		t.Fatalf("windowBackgroundColor = %q，tokens.css 的 --app-bg 拼出来是 %q：\n改了 client/src/styles/tokens.css 的 --app-bg 就要同步 desktop/theme.go 的 windowBackgroundColor（两处是同一契约）。", windowBackgroundColor, want)
	}
}

// 冷启动的浅色底色必须是米色家族（#266）：页面首绘前不能闪回旧冷灰。
// 两色同步与暗色分量仍由 TestWindowBackgroundColorMatchesTokens 守，这里只钉住亮色分量的色族。
func TestLightColdStartBackgroundIsBeige(t *testing.T) {
	if !strings.HasPrefix(windowBackgroundColor, "light-dark(") || !strings.HasSuffix(windowBackgroundColor, ")") {
		t.Fatalf("窗口底色 %q 不是 light-dark(...) 形式", windowBackgroundColor)
	}
	inside := strings.TrimSuffix(strings.TrimPrefix(windowBackgroundColor, "light-dark("), ")")
	parts := strings.Split(inside, ",")
	if len(parts) != 2 {
		t.Fatalf("窗口底色 %q 没有亮 / 暗两个分量", windowBackgroundColor)
	}
	light := strings.TrimSpace(parts[0])
	if len(light) != 7 || light[0] != '#' {
		t.Fatalf("浅色底色 %q 不是 #rrggbb", light)
	}
	channel := func(at int) int {
		value, err := strconv.ParseUint(light[at:at+2], 16, 8)
		if err != nil {
			t.Fatalf("浅色底色 %q 的通道无法解析：%v", light, err)
		}
		return int(value)
	}
	r, g, b := channel(1), channel(3), channel(5)
	difference := r - g
	if difference < 0 {
		difference = -difference
	}
	if r < 200 || g < 195 || b < 150 || g-b < 18 || difference > 10 {
		t.Fatalf("浅色冷启动底色 %q 不在米色家族（红绿近似相等且明显高于蓝）", light)
	}
}
