package main

import (
	"strings"
	"testing"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
	"github.com/qinyuanj/kacha/desktop/internal/shellapp"
)

// 绑定的服务与页面调用名是前端与 Go 的约定（#129）：少绑一个，页面调用会落到 notBound，
// 前端只能静默退回 paste 事件——原生粘贴那条路就白做了，而且没有任何报错。
//
// 用 GenerateTypeScript 验：它列出的就是页面能调到的全部服务与方法，不起窗口、不读真剪贴板。
func TestBindServicesExposeClipboardRead(t *testing.T) {
	src := generatedClient(t)
	for _, want := range []string{"Shell", "Local", "Usage", "Clipboard", "Pack", "Gateway", "Diagnostics"} {
		if !strings.Contains(src, want) {
			t.Fatalf("生成的客户端里没有 %s 服务：\n%s", want, src)
		}
	}
	// 用量服务（#159）：页面按 Usage.Usage / Cleanup / SetLimit / Recycle / Restore / PurgeExpired 调用。
	for _, want := range []string{"usage", "cleanup", "setLimit", "recycle", "restore", "purgeExpired"} {
		if !strings.Contains(src, want) {
			t.Fatalf("生成的客户端里没有 %q：Usage 服务没绑上或方法名对不上：\n%s", want, src)
		}
	}
	for _, key := range []string{"total_bytes", "unreferenced", "unreadable_board", "limit_level", "cleaned_at", "expired"} {
		if !strings.Contains(src, key) {
			t.Fatalf("生成的客户端类型里没有 %q：\n%s", key, src)
		}
	}
	// 方法名与 client/src/shell/desktopBridge.ts 的调用名一致：Clipboard.Read。
	if !strings.Contains(src, "read") {
		t.Fatalf("Clipboard 上没有 read 方法：\n%s", src)
	}
	// 复制图片（#130）：页面按 Clipboard.CopyImage(path, format) 调用。
	// 少这个方法时复制图片在桌面壳里只会静默失败。
	if !strings.Contains(src, "copyImage") {
		t.Fatalf("Clipboard 上没有 copyImage 方法：\n%s", src)
	}
	// 网关与密钥服务（#152）：少绑一个，设置面板的测试连接与密钥管理会落到 notBound。
	for _, want := range []string{"Gateway", "request", "readApiKey", "writeApiKey", "deleteApiKey"} {
		if !strings.Contains(src, want) {
			t.Fatalf("生成的客户端里没有 %q（网关服务没绑上）：\n%s", want, src)
		}
	}
	// 画板包导出与结果保存的方法名是页面调用约定，缺一个都会在 WebView 里静默失败。
	for _, want := range []string{"facts", "export", "exportSnapshot", "cancelExport", "pickExport", "saveResult", "saveBoardResults"} {
		if !strings.Contains(src, want) {
			t.Fatalf("生成的客户端里没有导出/保存方法 %q：\n%s", want, src)
		}
	}
	// 结局的键名来自 Go 的 json tag：页面按 ok / kind / message / bytes 读。
	for _, key := range []string{"ok", "kind", "message", "container", "bytes"} {
		if !strings.Contains(src, key) {
			t.Fatalf("复制结局的类型里没有 %q 字段：\n%s", key, src)
		}
	}
	// 诊断服务（#162）：页面按 Diagnostics.Log / Diagnostics.Export 调用；
	// 少绑一个，脱敏采集与诊断包导出在桌面壳里就无从谈起，前端入口只能是空的。
	for _, want := range []string{"log", "export"} {
		if !strings.Contains(src, want) {
			t.Fatalf("生成的客户端里没有诊断方法 %q：\n%s", want, src)
		}
	}
	// Diagnostics 的方法名与形状是页面的约定（client/src/shell/desktopBridge.ts）：
	// 页面按 Diagnostics.Log(kind, fields) 与 Diagnostics.Export() 调用，少一个方法就静默失灵。
	start := strings.Index(src, "export const Diagnostics")
	if start < 0 {
		t.Fatalf("生成的客户端里没有 Diagnostics 服务：\n%s", src)
	}
	section := src[start:]
	if end := strings.Index(section, "} as const;"); end > 0 {
		section = section[:end]
	}
	for _, want := range []string{"Diagnostics.Log", "Diagnostics.Export", "Promise<DiagnosticsOutcome>"} {
		if !strings.Contains(section, want) {
			t.Fatalf("Diagnostics 服务里没有 %q：\n%s", want, section)
		}
	}
	// 本机选图（#154）：页面按 Local.PickImages(multiple) 调用，拿 name + base64 的 data 还原成 File。
	// 少这个方法，参考图编辑就只能粘贴，选本机图片的入口在桌面壳里静默失灵。
	if !strings.Contains(src, "pickImages") {
		t.Fatalf("Local 上没有 pickImages 方法：\n%s", src)
	}
	for _, key := range []string{"name", "data"} {
		if !strings.Contains(src, key) {
			t.Fatalf("选图结果的类型里没有 %q 字段：\n%s", key, src)
		}
	}
	// 结果图的二进制响应字段（#153）：页面按 body_base64 还原字节，少了这个键就会静默损坏图片。
	if !strings.Contains(src, "body_base64") {
		t.Fatalf("生成的客户端里没有 body_base64（网关二进制响应没绑上）：\n%s", src)
	}
	// 整理模式的度量（#158）：页面按 Local.MeasureBoard(画板原文) 调用，读 nodes / dirs 两个键。
	// 少绑这个方法，整理模式在桌面壳里只能显示「正在计算体量…」，体量永远是未知。
	if !strings.Contains(src, "measureBoard") {
		t.Fatalf("生成的客户端里没有 measureBoard（整理模式的度量没绑上）：\n%s", src)
	}
	for _, key := range []string{"nodes", "dirs"} {
		if !strings.Contains(src, key) {
			t.Fatalf("度量的类型里没有 %q 字段：\n%s", key, src)
		}
	}

	// 数据位置迁移（#161）：页面按 Storage.Status / Pick / Move 调用；少绑一个，
	// 设置里的入口只能标「尚不可用」，本机数据就永远搬不了家。
	start = strings.Index(src, "export const Storage")
	if start < 0 {
		t.Fatalf("生成的客户端里没有 Storage 服务：\n%s", src)
	}
	section = src[start:]
	if end := strings.Index(section, "} as const;"); end > 0 {
		section = section[:end]
	}
	for _, want := range []string{"Storage.Status", "Storage.Pick", "Storage.Move", "Promise<StorageOutcome>"} {
		if !strings.Contains(section, want) {
			t.Fatalf("Storage 服务里没有 %q：\n%s", want, section)
		}
	}
	// 结局与状态的键名是页面约定（client/src/shell/desktop.ts）：改了前端就静默读不到。
	for _, key := range []string{"moving", "done", "total", "files"} {
		if !strings.Contains(src, key) {
			t.Fatalf("Storage 的类型里没有 %q 字段：\n%s", key, src)
		}
	}
}

// 剪贴板服务的快照字段是页面的约定（client/src/shell/desktop.ts 的 DesktopClipboardSnapshot）：
// 键名变了前端就静默读不到 kind，只会按「读不到」退回 paste 事件。
func TestClipboardSnapshotJSONKeys(t *testing.T) {
	client, err := mygo.GenerateTypeScript()
	if err != nil {
		t.Fatalf("GenerateTypeScript: %v", err)
	}
	// 生成文件里 Clipboard 服务的 read 返回 Snapshot；字段名来自 Go 的 json tag。
	src := string(client)
	for _, key := range []string{"kind", "text", "images", "reason"} {
		if !strings.Contains(src, key) {
			t.Fatalf("Clipboard 快照的类型里没有 %q 字段：\n%s", key, src)
		}
	}
}

// 本机图片协议（#132 真机验收发现）：页面来自 http://mygo.localhost，不能加载 file://，
// 必须把数据根注册成自定义协议，否则画板里的图片一律显示「图片缺失」。
func TestRegisterAssetProtocol(t *testing.T) {
	if err := registerAssetProtocol(dataroot.NewRoots(t.TempDir())); err != nil {
		t.Fatalf("registerAssetProtocol: %v", err)
	}
	if !mygo.Protocol.IsHandled(assetScheme) {
		t.Fatalf("协议 %q 没注册上：页面读不到数据根里的图片", assetScheme)
	}
}

// 桌面壳的能力开关：画板包导出（#160）、本机用量（#159）、单份生成（#153）与整理（#158）都已接通。
func TestDesktopFeaturesEnableUsagePackExportAndGeneration(t *testing.T) {
	features := shellapp.DesktopFeatures(true)
	if !features.Usage || !features.PackExport || !features.Generation || !features.Tidy {
		t.Fatalf("本机用量、画板包导出、单份生成与整理都已实现，能力开关必须打开：%+v", features)
	}
}
