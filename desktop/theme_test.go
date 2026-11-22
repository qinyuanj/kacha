package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 三档映射（#221）：页面档位 → MyGo 主题源。system 必须原样交给 MyGo，
// 否则 WebView 的 prefers-color-scheme 会被钉成暗色，前端的「跟随系统」永远跟不到浅色。
func TestThemeSourceOf(t *testing.T) {
	cases := []struct {
		choice string
		want   mygo.ThemeSource
		note   string
	}{
		{"dark", mygo.ThemeDark, "暗色"},
		{"light", mygo.ThemeLight, "浅色"},
		{"system", mygo.ThemeSystem, "跟随系统"},
		{"", mygo.ThemeDark, "空值兜底为默认暗色"},
		{"Dark", mygo.ThemeDark, "大小写不对也算非法"},
		{"auto", mygo.ThemeDark, "非法值兜底为默认暗色"},
		{"\u6697\u8272", mygo.ThemeDark, "非 ASCII 也不 panic"},
	}
	for _, c := range cases {
		if got := themeSourceOf(c.choice); got != c.want {
			t.Fatalf("themeSourceOf(%q) = %q，想要 %q（%s）", c.choice, got, c.want, c.note)
		}
	}
}

// applyTheme 只转一次：非法档位也走同一个兜底，不抛错、不跳过。
func TestApplyThemePassesMappedSource(t *testing.T) {
	var got []mygo.ThemeSource
	apply := func(source mygo.ThemeSource) { got = append(got, source) }
	for _, choice := range []string{"dark", "light", "system", "bogus"} {
		applyTheme(apply, choice)
	}
	want := []mygo.ThemeSource{mygo.ThemeDark, mygo.ThemeLight, mygo.ThemeSystem, mygo.ThemeDark}
	if len(got) != len(want) {
		t.Fatalf("apply 调用次数 = %d，想要 %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 次 apply = %q，想要 %q", i+1, got[i], want[i])
		}
	}
}

// 冷启动底色必须是 light-dark(亮, 暗) 形式：MyGo 按当前外观在两色之间选。
func TestWindowBackgroundColorIsLightDark(t *testing.T) {
	if !strings.HasPrefix(windowBackgroundColor, "light-dark(") || !strings.HasSuffix(windowBackgroundColor, ")") {
		t.Fatalf("窗口底色 %q 不是 light-dark(...) 形式：冷启动会按单一色闪一下", windowBackgroundColor)
	}
	inner := strings.TrimSuffix(strings.TrimPrefix(windowBackgroundColor, "light-dark("), ")")
	if parts := strings.Split(inner, ", "); len(parts) != 2 {
		t.Fatalf("窗口底色应该正好两个色值（亮, 暗），实际 %q", inner)
	}
}

// 冷启动只读 theme 字段：版本号不校验、其它字段不解析、缺/坏/非法都回默认暗色。
func TestStartupThemeReadsOnlyThemeField(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		write  bool
		isDir  bool
		want   mygo.ThemeSource
	}{
		{name: "没有 settings.json", write: false, want: mygo.ThemeDark},
		{name: "浅色", body: `{"format_version":1,"theme":"light"}`, write: true, want: mygo.ThemeLight},
		{name: "跟随系统", body: `{"format_version":1,"theme":"system"}`, write: true, want: mygo.ThemeSystem},
		{name: "暗色", body: `{"format_version":1,"theme":"dark"}`, write: true, want: mygo.ThemeDark},
		{name: "没有 theme 字段", body: `{"format_version":1}`, write: true, want: mygo.ThemeDark},
		// 版本过新只在写盘时保护（前端判定）：窗口外观照旧按 theme 走。
		{name: "版本过新", body: `{"format_version":9,"theme":"light"}`, write: true, want: mygo.ThemeLight},
		{name: "theme 非法", body: `{"theme":"auto"}`, write: true, want: mygo.ThemeDark},
		{name: "JSON 写坏", body: "{oops", write: true, want: mygo.ThemeDark},
		{name: "读不出来（settings.json 是目录）", write: false, isDir: true, want: mygo.ThemeDark},
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
			// 只读：文件原样还在，内容没被改写。
			if c.write && !c.isDir {
				after, err := os.ReadFile(path)
				if err != nil || string(after) != c.body {
					t.Fatalf("settings.json 被改动了：%q（err=%v）", string(after), err)
				}
			}
		})
	}
}
