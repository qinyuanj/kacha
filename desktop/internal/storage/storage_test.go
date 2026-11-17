package storage

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// write 在数据根里造一个文件（含父目录）。
func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("建目录 %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("写 %s: %v", path, err)
	}
}

// 迁移成功后服务报告新位置，重启解析也回到新位置；旧位置的内容仍在。
func TestMoveRootSwitchesAndKeepsOldData(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "appdata", "shell-state.json")
	source := filepath.Join(base, "data")
	target := filepath.Join(base, "新位置")
	write(t, filepath.Join(source, "画板", "a.ugcboard.json"), "A")
	write(t, filepath.Join(source, ".kacha", "settings.json"), "S")
	if _, err := dataroot.Resolve(statePath, source); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	roots := dataroot.NewRoots(source)
	svc := New(roots, statePath)
	svc.pick = func() (string, error) { return target, nil }

	// 目标由页面传进来（页面经系统对话框选过），服务不再弹窗。
	out := svc.Move(target)
	if !out.OK {
		t.Fatalf("Move 失败：%+v", out)
	}
	if out.Root != target {
		t.Fatalf("结局里的数据根 = %q, want %q", out.Root, target)
	}
	if roots.Current() != target {
		t.Fatalf("共享数据根 = %q, want %q", roots.Current(), target)
	}
	if body, err := os.ReadFile(filepath.Join(target, "画板", "a.ugcboard.json")); err != nil || string(body) != "A" {
		t.Fatalf("新位置的画板 = %q, %v", body, err)
	}
	if body, err := os.ReadFile(filepath.Join(source, "画板", "a.ugcboard.json")); err != nil || string(body) != "A" {
		t.Fatalf("旧位置的画板 = %q, %v", body, err)
	}
	// 重启：状态记录已指向新位置。
	got, err := dataroot.Resolve(statePath, filepath.Join(base, "默认"))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != target {
		t.Fatalf("重启后数据根 = %q, want %q", got, target)
	}
}

// 失败时共享数据根不动：旧位置仍是唯一数据来源，页面拿得到失败类别。
func TestMoveRootFailureKeepsCurrentRoot(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "appdata", "shell-state.json")
	source := filepath.Join(base, "data")
	target := filepath.Join(base, "别人的目录")
	write(t, filepath.Join(source, "画板", "a.ugcboard.json"), "A")
	write(t, filepath.Join(target, "别人的文件.txt"), "X")
	if _, err := dataroot.Resolve(statePath, source); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	roots := dataroot.NewRoots(source)
	svc := New(roots, statePath)

	out := svc.Move(target)
	if out.OK {
		t.Fatal("目标非空时应当失败")
	}
	if out.Kind != "notEmpty" {
		t.Fatalf("失败类别 = %q, want notEmpty", out.Kind)
	}
	if out.Message == "" {
		t.Fatal("失败应带可显示的原因")
	}
	if roots.Current() != source {
		t.Fatalf("失败后共享数据根 = %q, want %q", roots.Current(), source)
	}
}

// Pick 让用户选目标目录；取消时返回空串（页面据此不发起迁移）。
func TestPickReturnsChosenDirectory(t *testing.T) {
	base := t.TempDir()
	roots := dataroot.NewRoots(filepath.Join(base, "data"))
	svc := New(roots, filepath.Join(base, "state.json"))
	svc.pick = func() (string, error) { return filepath.Join(base, "选的"), nil }
	got, err := svc.Pick()
	if err != nil || got != filepath.Join(base, "选的") {
		t.Fatalf("Pick = %q, %v", got, err)
	}
	svc.pick = func() (string, error) { return "", nil }
	if got, err := svc.Pick(); err != nil || got != "" {
		t.Fatalf("取消时 Pick = %q, %v；应为空串", got, err)
	}
}

// 迁移前先问一遍能不能开始：有在途生成任务或导入时页面据此拦下，服务不替它决定。
func TestStatusReportsCurrentRootAndBusy(t *testing.T) {
	base := t.TempDir()
	roots := dataroot.NewRoots(filepath.Join(base, "data"))
	svc := New(roots, filepath.Join(base, "state.json"))
	st := svc.Status()
	if st.Root != roots.Current() {
		t.Fatalf("Status.Root = %q, want %q", st.Root, roots.Current())
	}
	if st.Moving {
		t.Fatal("没在迁移时 Moving 应为 false")
	}
}

// 有在途的打包 / 导入时，迁移必须先被挡下：两边都在搬同一份文件，边搬边切会留下半份。
func TestMoveRefusedWhileOtherWorkInFlight(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "appdata", "shell-state.json")
	source := filepath.Join(base, "data")
	target := filepath.Join(base, "新位置")
	write(t, filepath.Join(source, "画板", "a.ugcboard.json"), "A")
	if _, err := dataroot.Resolve(statePath, source); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	roots := dataroot.NewRoots(source)
	svc := NewWithBusy(roots, statePath, func() string { return "正在导出画板包" })

	out := svc.Move(target)
	if out.OK {
		t.Fatal("有在途操作时迁移应当被拒绝")
	}
	if out.Kind != "busy" {
		t.Fatalf("失败类别 = %q, want busy", out.Kind)
	}
	if out.Message != "正在导出画板包" {
		t.Fatalf("原因 = %q, 应带上在途操作", out.Message)
	}
	if roots.Current() != source {
		t.Fatalf("被拒绝后数据根 = %q, want %q", roots.Current(), source)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("被拒绝时不该碰目标位置：%v", err)
	}
}

// 在途操作结束后照常能迁：拒绝是暂时的，不是永久禁用。
func TestMoveAllowedOnceBusyCheckClears(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "appdata", "shell-state.json")
	source := filepath.Join(base, "data")
	target := filepath.Join(base, "新位置")
	write(t, filepath.Join(source, "画板", "a.ugcboard.json"), "A")
	if _, err := dataroot.Resolve(statePath, source); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	roots := dataroot.NewRoots(source)
	reason := "正在保存画板"
	svc := NewWithBusy(roots, statePath, func() string { return reason })
	if out := svc.Move(target); out.OK {
		t.Fatal("应当先被拒绝")
	}
	reason = ""
	if out := svc.Move(target); !out.OK {
		t.Fatalf("在途操作结束后应当能迁：%+v", out)
	}
	if roots.Current() != target {
		t.Fatalf("数据根 = %q, want %q", roots.Current(), target)
	}
}

// 同一时刻只有一个迁移：并发发起时第二个拿到 busy，不会两路各写一半。
func TestMoveRefusedWhileMoving(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "appdata", "shell-state.json")
	source := filepath.Join(base, "data")
	write(t, filepath.Join(source, "画板", "a.ugcboard.json"), "A")
	if _, err := dataroot.Resolve(statePath, source); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	roots := dataroot.NewRoots(source)
	started := make(chan struct{})
	release := make(chan struct{})
	svc := NewWithBusy(roots, statePath, func() string {
		select {
		case <-started:
		default:
			close(started)
		}
		<-release
		return ""
	})
	done := make(chan Outcome, 1)
	go func() { done <- svc.Move(filepath.Join(base, "第一次")) }()
	<-started
	if out := svc.Move(filepath.Join(base, "第二次")); out.Kind != "busy" {
		t.Fatalf("并发第二次 = %+v, want busy", out)
	}
	close(release)
	if out := <-done; !out.OK {
		t.Fatalf("第一次迁移应当成功：%+v", out)
	}
}
// 包文档名必须等于真实包名：写成别的服务名（storageservice）时 go doc 找不到这个包，
// 读代码的人也会以为包名是 storageservice。
func TestPackageDocUsesTheRealPackageName(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("Glob: %v", err)
	}
	found := false
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		fset := token.NewFileSet()
		parsed, err := parser.ParseFile(fset, name, nil, parser.ParseComments|parser.PackageClauseOnly)
		if err != nil {
			t.Fatalf("ParseFile(%s): %v", name, err)
		}
		if parsed.Doc == nil {
			continue
		}
		found = true
		doc := parsed.Doc.Text()
		if !strings.HasPrefix(doc, "Package storage ") {
			t.Fatalf("%s 的包文档没有以「Package storage」开头：%q", name, firstLine(doc))
		}
	}
	if !found {
		t.Fatal("没有找到包文档：doc.go 或任一源文件开头应有 Package 说明")
	}
}

// firstLine 取文档的第一行，失败消息里只显示它。
func firstLine(text string) string {
	if i := strings.IndexByte(text, '\n'); i >= 0 {
		return text[:i]
	}
	return text
}
// 迁移复制期间写数据根被拦下（不复现「切换重载后丢写」）：busy 回调在复制开始前跑，
// 此刻写入必须已经拦下；迁移结束后写入恢复。
func TestMoveRootBlocksDataWritesWhileCopying(t *testing.T) {
	base := t.TempDir()
	oldRoot := filepath.Join(base, "旧")
	write(t, filepath.Join(oldRoot, "画板", "板.ugcboard.json"), "{\"format_version\":2,\"nodes\":[]}")
	statePath := filepath.Join(base, "appdata", "shell-state.json")
	roots := dataroot.NewRoots(oldRoot)
	store := localstore.NewFollowing(roots)

	checked := false
	service := NewWithBusy(roots, statePath, func() string {
		checked = true
		if !roots.Moving() {
			t.Error("复制开始前没有标记迁移中：写入不会被拦下")
		}
		if out := store.WriteMeta("settings.json", "{}"); out.OK || out.Kind != localstore.KindMoving {
			t.Errorf("迁移期间的保存设置结局 = %+v, want kind %q", out, localstore.KindMoving)
		}
		if out := store.WriteBoard(filepath.Join(store.BoardDir(), "板.ugcboard.json"), "{\"format_version\":2,\"nodes\":[]}", localstore.WriteOptions{}); out.OK {
			t.Errorf("迁移期间的保存画板被放行: %+v", out)
		}
		return ""
	})

	out := service.Move(filepath.Join(base, "新"))
	if !checked {
		t.Fatal("没走到在途检查：这条测试没覆盖迁移中的写入")
	}
	if !out.OK {
		t.Fatalf("迁移失败: %+v", out)
	}
	if roots.Moving() {
		t.Fatal("迁移结束后仍标记为迁移中：写入会一直被拦下")
	}
	if got := service.Status().Moving; got {
		t.Fatalf("迁移结束后 Status().Moving = %v, want false", got)
	}
	if res := store.WriteMeta("settings.json", "{}"); !res.OK {
		t.Fatalf("迁移结束后写入没有恢复: %+v", res)
	}
}

// 迁移失败（目标不空）也要撤掉迁移标记：否则用户之后连设置都存不下去。
func TestMoveRootFailureClearsMovingFlag(t *testing.T) {
	base := t.TempDir()
	oldRoot := filepath.Join(base, "旧")
	write(t, filepath.Join(oldRoot, "画板", "板.ugcboard.json"), "{\"format_version\":2,\"nodes\":[]}")
	target := filepath.Join(base, "新")
	write(t, filepath.Join(target, "已有.txt"), "占位")
	statePath := filepath.Join(base, "appdata", "shell-state.json")
	roots := dataroot.NewRoots(oldRoot)
	service := New(roots, statePath)

	out := service.Move(target)
	if out.OK {
		t.Fatalf("目标已有内容时迁移应当失败: %+v", out)
	}
	if roots.Moving() {
		t.Fatal("迁移失败后仍标记为迁移中：写入会一直被拦下")
	}
	if err := dataroot.Remember(statePath, oldRoot, ""); err != nil {
		t.Fatalf("Remember: %v", err)
	}
}
