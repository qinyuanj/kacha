package updateservice

import (
	"os"
	"path/filepath"
	"testing"
)

// 只有验签通过、且是用户点击才安装：装之前必须有 ready 且已验签。
func TestInstallRunsTheRealInstallerSilentlyAndQuits(t *testing.T) {
	pub := newPublisher(t)
	f := buildFixture(t, pub, releaseSpec{Version: "1.6.0"})
	svc, rec := newService(t, f, pub, "1.5.0")
	svc.Check()
	if snap := waitPhase(t, svc, PhaseReady); snap.Phase != PhaseReady {
		t.Fatalf("phase = %q (error %q), want ready", snap.Phase, snap.Error)
	}
	if err := svc.Install(); err != nil {
		t.Fatalf("Install: %v", err)
	}
	if len(rec.launched) != 1 {
		t.Fatalf("installer launched %d times, want 1", len(rec.launched))
	}
	if want := InstallerName("1.6.0"); filepath.Base(rec.launched[0]) != want {
		t.Fatalf("launched %q, want %q", filepath.Base(rec.launched[0]), want)
	}
	// 参数是跟安装器的约定：/S 静默安装，--relaunch 让安装器装完重新打开 Kacha
	// （installer/installer.nsh 的 customInit 读这个字面量）。
	// 这里手写期望值而不引用 relaunchFlag：要钉住的是安装器脚本认的线格式，
	// 引用常量会让两端一起改、测试仍然绿。
	if got := rec.args[0]; len(got) != 2 || got[0] != "/S" || got[1] != "--relaunch" {
		t.Fatalf("args = %v, want [/S --relaunch]（静默安装 + 装完重新打开）", got)
	}
	// 装完要退出本应用，让安装器替换正在运行的 exe。
	if rec.quits != 1 {
		t.Fatalf("quit called %d times, want 1", rec.quits)
	}
	if snap := svc.Status(); snap.Phase != PhaseInstalling {
		t.Fatalf("phase = %q, want installing", snap.Phase)
	}
}

// 还没检查过就点安装：拒绝，不起安装器。
func TestInstallRefusesBeforeAnyVerifiedPackage(t *testing.T) {
	pub := newPublisher(t)
	f := buildFixture(t, pub, releaseSpec{Version: "1.6.0"})
	svc, rec := newService(t, f, pub, "1.5.0")
	if err := svc.Install(); err == nil {
		t.Fatalf("Install must refuse before a verified package exists")
	}
	if len(rec.launched) != 0 {
		t.Fatalf("installer launched %d times, want 0", len(rec.launched))
	}
	if rec.quits != 0 {
		t.Fatalf("app quit %d times, want 0", rec.quits)
	}
}

// 启动安装器失败：回到可安装状态并给出原因，不退出应用（旧版本还能用）。
func TestInstallFailureKeepsAppRunnable(t *testing.T) {
	pub := newPublisher(t)
	f := buildFixture(t, pub, releaseSpec{Version: "1.6.0"})
	svc, rec := newService(t, f, pub, "1.5.0")
	svc.Check()
	if snap := waitPhase(t, svc, PhaseReady); snap.Phase != PhaseReady {
		t.Fatalf("phase = %q, want ready", snap.Phase)
	}
	svc.mu.Lock()
	svc.launch = func(string, []string) error { return os.ErrPermission }
	svc.mu.Unlock()
	if err := svc.Install(); err == nil {
		t.Fatalf("Install must report the launch failure")
	}
	if rec.quits != 0 {
		t.Fatalf("app quit %d times, want 0: the old version must stay usable", rec.quits)
	}
	snap := svc.Status()
	if snap.Phase != PhaseReady || !snap.Installable {
		t.Fatalf("phase = %q installable = %v, want ready and installable", snap.Phase, snap.Installable)
	}
	if snap.Error == "" {
		t.Fatalf("a launch failure must carry a reason")
	}
}

// 发布者公钥不可用：更新明确不可用，检查也不发请求。
func TestUnusablePublisherKeyUpdatesAreUnavailable(t *testing.T) {
	pub := newPublisher(t)
	f := buildFixture(t, pub, releaseSpec{Version: "1.6.0"})
	svc := New(Options{Current: "1.5.0", Root: t.TempDir(), BaseURL: f.base, Client: f.server.Client(), PublicKey: "not-a-valid-base64-key"})
	if svc.Enabled() {
		t.Fatalf("a build without a publisher key must not be enabled")
	}
	snap := svc.Status()
	if snap.Phase != PhaseDisabled {
		t.Fatalf("phase = %q, want disabled", snap.Phase)
	}
	svc.Check()
	if snap := svc.Status(); snap.Phase != PhaseDisabled {
		t.Fatalf("phase after Check = %q, want disabled", snap.Phase)
	}
}

// 并发检查合并成一次：不重复下载、不重复请求。
func TestConcurrentChecksAreMerged(t *testing.T) {
	pub := newPublisher(t)
	f := buildFixture(t, pub, releaseSpec{Version: "1.6.0"})
	svc, _ := newService(t, f, pub, "1.5.0")
	for i := 0; i < 5; i++ {
		svc.Check()
	}
	if snap := waitPhase(t, svc, PhaseReady); snap.Phase != PhaseReady {
		t.Fatalf("phase = %q (error %q), want ready", snap.Phase, snap.Error)
	}
	f.mu.Lock()
	requests := len(f.requests)
	f.mu.Unlock()
	if requests != 1 {
		t.Fatalf("listed releases %d times, want 1", requests)
	}
}

// 已是最新时不下载：不浪费流量，也不提示安装。
func TestUpToDateDoesNotDownload(t *testing.T) {
	pub := newPublisher(t)
	f := buildFixture(t, pub, releaseSpec{Version: "1.5.0"})
	svc, _ := newService(t, f, pub, "1.5.0")
	svc.Check()
	if snap := waitPhase(t, svc, PhaseUpToDate); snap.Phase != PhaseUpToDate {
		t.Fatalf("phase = %q, want up_to_date", snap.Phase)
	}
	entries, err := os.ReadDir(filepath.Join(svc.root, "更新"))
	if err == nil && len(entries) != 0 {
		t.Fatalf("up to date downloaded %d files, want 0", len(entries))
	}
}
