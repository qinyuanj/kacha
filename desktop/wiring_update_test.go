package main

import (
	"strings"
	"sync"
	"testing"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
	"github.com/qinyuanj/kacha/desktop/internal/shellapp"
)

// bindOnce 让「绑定一次、多个测试各查各的」成为可能：
// mygo.BindAs 同名服务只能绑一次（重复即 panic），而生成类型要在绑定之后才读得到。
var bindOnce sync.Once

// generatedClient 返回绑定全部服务后的生成类型；同一进程里只真正绑定一次。
func generatedClient(t *testing.T) string {
	t.Helper()
	bindOnce.Do(func() {
		// 服务拿可切换的共享数据根（#161）：绑一次就够，迁移测试也复用它。
		shell := shellapp.NewFollowing("test", dataroot.NewRoots(t.TempDir()))
		bindServices(shell, dataroot.NewRoots(t.TempDir()))
	})
	client, err := mygo.GenerateTypeScript()
	if err != nil {
		t.Fatalf("GenerateTypeScript: %v", err)
	}
	return string(client)
}

// 反馈服务（#205）的绑定名与方法是页面调用约定：
// client/src/shell/desktopBridge.ts 按 Feedback.Send(spec) 调用；生成的客户端必须带上它。
func TestBindServicesExposeFeedbackService(t *testing.T) {
	src := generatedClient(t)
	start := strings.Index(src, "export const Feedback")
	if start < 0 {
		t.Fatalf("生成的客户端里没有 Feedback 服务：\n%s", src)
	}
	section := src[start:]
	if end := strings.Index(section, "} as const;"); end > 0 {
		section = section[:end]
	}
	if !strings.Contains(section, "Feedback.Send") {
		t.Fatalf("生成的 Feedback 服务缺少 Send：\n%s", section)
	}
}

// 更新服务（#164）的绑定名与方法是页面调用约定：
// client/src/shell/desktopBridge.ts 按 Update.Status / Check / Install 调用。
//
// 少绑一个方法，自动更新在桌面壳里就只剩一个空入口；绑定名对不上时页面调用落到
// notBound，而前端只能把它当成「不可用」，不会报错。
func TestBindServicesExposeUpdateService(t *testing.T) {
	src := generatedClient(t)
	start := strings.Index(src, "export const Update")
	if start < 0 {
		t.Fatalf("生成的客户端里没有 Update 服务：\n%s", src)
	}
	section := src[start:]
	if end := strings.Index(section, "} as const;"); end > 0 {
		section = section[:end]
	}
	// 页面按 Update.Status() / Update.Check() / Update.Install() 调用。
	for _, want := range []string{"Update.Status", "Update.Check", "Update.Install"} {
		if !strings.Contains(section, want) {
			t.Fatalf("Update 服务里没有 %q：\n%s", want, section)
		}
	}
	// 快照的线键契约由 updateservice.TestSnapshotJSONKeys 在 json.Marshal 边界守住（#232）。
}
