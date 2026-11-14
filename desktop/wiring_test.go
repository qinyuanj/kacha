package main

import (
	"strings"
	"testing"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/shellapp"
)

// 绑定的服务与页面调用名是前端与 Go 的约定（#129）：少绑一个，页面调用会落到 notBound，
// 前端只能静默退回 paste 事件——原生粘贴那条路就白做了，而且没有任何报错。
//
// 用 GenerateTypeScript 验：它列出的就是页面能调到的全部服务与方法，不起窗口、不读真剪贴板。
func TestBindServicesExposeClipboardRead(t *testing.T) {
	shell := shellapp.New("test", t.TempDir())
	bindServices(shell, t.TempDir())

	client, err := mygo.GenerateTypeScript()
	if err != nil {
		t.Fatalf("GenerateTypeScript: %v", err)
	}
	src := string(client)
	for _, want := range []string{"Shell", "Local", "Clipboard", "Pack"} {
		if !strings.Contains(src, want) {
			t.Fatalf("生成的客户端里没有 %s 服务：\n%s", want, src)
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
	// 结局的键名来自 Go 的 json tag：页面按 ok / kind / message / bytes 读。
	for _, key := range []string{"ok", "kind", "message", "container", "bytes"} {
		if !strings.Contains(src, key) {
			t.Fatalf("复制结局的类型里没有 %q 字段：\n%s", key, src)
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
