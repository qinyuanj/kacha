package main

import (
	"strings"
	"testing"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
)

// 绑定的服务与页面调用名是前端与 Go 的约定（#129）：少绑一个，页面调用会落到 notBound，
// 前端只能静默退回 paste 事件——原生粘贴那条路就白做了，而且没有任何报错。
//
// 用 GenerateTypeScript 验：它列出的就是页面能调到的全部服务与方法，不起窗口、不读真剪贴板。
// generatedSection 返回某个服务在生成客户端里的声明段；方法断言必须落在段内，
// 全文件 grep 会被其它服务的同名 token 满足（#232）。
func generatedSection(src, service string) string {
	start := strings.Index(src, "export const "+service+" = {")
	if start < 0 {
		return ""
	}
	section := src[start:]
	if end := strings.Index(section, "} as const;"); end > 0 {
		section = section[:end]
	}
	return section
}

// 绑定的服务与页面调用名是前端与 Go 的约定（#129）：少绑一个，页面调用会落到 notBound，
// 前端只能静默退回 paste 事件——原生粘贴那条路就白做了，而且没有任何报错。
//
// 用 GenerateTypeScript 验：它列出的就是页面能调到的全部服务与方法，不起窗口、不读真剪贴板。
func TestBindServicesExposePageMethods(t *testing.T) {
	src := generatedClient(t)
	for _, want := range []string{"Shell", "Local", "Feedback", "Usage", "Clipboard", "Pack", "Gateway", "Update", "Diagnostics", "Storage"} {
		if !strings.Contains(src, want) {
			t.Fatalf("生成的客户端里没有 %s 服务：\n%s", want, src)
		}
	}
	for _, tc := range []struct {
		service string
		methods []string
	}{
		{"Feedback", []string{"Feedback.AuthReset", "Feedback.AuthStart", "Feedback.AuthStatus", "Feedback.Send"}},
		{"Usage", []string{"Usage.Cleanup", "Usage.PurgeExpired", "Usage.Recycle", "Usage.Restore", "Usage.SetLimit", "Usage.Usage"}},
		{"Clipboard", []string{"Clipboard.CopyImage", "Clipboard.Read", "Clipboard.WriteText"}},
		{"Pack", []string{"Pack.Cancel", "Pack.CancelExport", "Pack.Export", "Pack.ExportSnapshot", "Pack.Facts", "Pack.Pick", "Pack.PickExport", "Pack.Root", "Pack.Snapshot", "Pack.Start"}},
		{"Gateway", []string{"Gateway.DeleteApiKey", "Gateway.ReadApiKey", "Gateway.Request", "Gateway.WriteApiKey"}},
		{"Diagnostics", []string{"Diagnostics.Bundle", "Diagnostics.Export", "Diagnostics.Log", "Diagnostics.Root"}},
		{"Local", []string{"Local.PickImages", "Local.SaveResult"}},
		{"Storage", []string{"Storage.Status", "Storage.Pick", "Storage.Move"}},
		{"Update", []string{"Update.Status", "Update.Check", "Update.Install"}},
	} {
		section := generatedSection(src, tc.service)
		if section == "" {
			t.Fatalf("生成的客户端里没有 %s 服务：\n%s", tc.service, src)
		}
		for _, m := range tc.methods {
			if !strings.Contains(section, m) {
				t.Fatalf("%s 服务里没有 %q：\n%s", tc.service, m, section)
			}
		}
	}
	// #262：整板结果下载的专属绑定已退役，生成的客户端不能再暴露它；单结果仍在。
	if strings.Contains(src, "SaveBoardResults") {
		t.Fatalf("生成的客户端仍暴露整板结果保存：\n%s", src)
	}

	// 结局键名只在 unique 键上断言；ok/kind/message/data/text 等全文件 grep 会被其它服务满足（#232）。
	for _, key := range []string{"body_base64", "container", "images", "reason", "moving"} {
		if !strings.Contains(src, key) {
			t.Fatalf("生成的客户端类型里没有 %q：\n%s", key, src)
		}
	}
}

// 本机图片协议（#132 真机验收发现）：页面来自 http://mygo.localhost，不能加载 file://，
// 必须把数据根注册成自定义协议，否则画板里的图片一律显示「图片缺失」。
func TestRegisterAssetProtocol(t *testing.T) {
	// 字面量是跨语言约定：client/src/shell/desktopStores.ts 的 ASSET_ORIGIN 钉死 kacha.localhost。
	// 不能拿 assetScheme 做自比较：常量与 Handle 一起改名时本测试会绿而客户端全裂（#232）。
	if assetScheme != "kacha" {
		t.Fatalf("asset scheme = %q, want kacha", assetScheme)
	}
	if err := registerAssetProtocol(dataroot.NewRoots(t.TempDir())); err != nil {
		t.Fatalf("registerAssetProtocol: %v", err)
	}
	defer mygo.Protocol.Unhandle(assetScheme)
	if !mygo.Protocol.IsHandled("kacha") {
		t.Fatal("协议 kacha 没注册上：页面读不到数据根里的图片")
	}
}
