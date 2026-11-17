package packservice

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/packexport"
)

// 一个只含任务目录与参考图的最小导出规格。
func exportFixture(root string) packexport.Spec {
	dir := filepath.Join(root, "2026-01-02", "t1")
	_ = os.MkdirAll(filepath.Join(dir, "layers"), 0o755)
	_ = os.MkdirAll(filepath.Join(root, "导入参考图"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "task.json"), []byte("{\"task_id\":\"t1\"}"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "result.png"), []byte("png"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "layers", "01.png"), []byte("layer"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "导入参考图", "r.png"), []byte("ref"), 0o644)
	return packexport.Spec{
		Texts:    []packexport.TextEntry{{Entry: "manifest.json", Text: "{\"pack_format_version\":2,\"app_version\":\"1.5.0\",\"boards\":[\"画板/a.ugcboard.json\"]}"}, {Entry: "画板/a.ugcboard.json", Text: "{\"format_version\":2,\"title\":\"板\",\"nodes\":[],\"edges\":[]}"}},
		TaskDirs: []string{"2026-01-02/t1"},
		Files:    []packexport.FileEntry{{Source: filepath.Join(root, "导入参考图", "r.png"), Entry: "导入参考图/r.png"}},
	}
}

// 系统「另存为」对话框取消时返回空串：界面据此说「已取消」，不能开始打包。
func TestPickExportCancelAndChoice(t *testing.T) {
	old := exportSaveDialog
	t.Cleanup(func() { exportSaveDialog = old })
	exportSaveDialog = func(mygo.SaveDialogOptions) (string, error) { return "", nil }
	svc := New(t.TempDir())
	if got, err := svc.PickExport("板.ugcpack"); err != nil || got != "" {
		t.Fatalf("取消选目标 = %q, %v", got, err)
	}
	var opts mygo.SaveDialogOptions
	exportSaveDialog = func(o mygo.SaveDialogOptions) (string, error) { opts = o; return filepath.Join(t.TempDir(), "板.ugcpack"), nil }
	got, err := svc.PickExport("板.ugcpack")
	if err != nil || !strings.HasSuffix(got, "板.ugcpack") {
		t.Fatalf("选目标 = %q, %v", got, err)
	}
	if opts.DefaultPath != "板.ugcpack" {
		t.Fatalf("默认文件名没带给对话框：%+v", opts)
	}
}

func TestFactsReturnsEntriesFromGo(t *testing.T) {
	root := t.TempDir()
	svc := New(root)
	facts, err := svc.Facts(exportFixture(root))
	if err != nil || len(facts) != 4 {
		t.Fatalf("Facts = %+v, %v", facts, err)
	}
}

// 导出在后台跑：先 running，结束后给出成功结局与实际字节数。
func TestExportRunsInBackgroundAndReportsOutcome(t *testing.T) {
	root := t.TempDir()
	svc := New(root)
	target := filepath.Join(t.TempDir(), "板.ugcpack")
	started := svc.Export(target, exportFixture(root))
	if !started.OK {
		t.Fatalf("Export 启动失败：%+v", started)
	}
	deadline := time.Now().Add(10 * time.Second)
	var snap ExportSnapshot
	for time.Now().Before(deadline) {
		snap = svc.ExportSnapshot()
		if !snap.Running && snap.Outcome != nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if snap.Running || snap.Outcome == nil || !snap.Outcome.OK || snap.Outcome.Result == nil {
		t.Fatalf("导出结局 = %+v", snap)
	}
	if snap.Outcome.Result.TaskDirs != 1 || snap.Outcome.Result.Bytes <= 0 {
		t.Fatalf("导出计数 = %+v", snap.Outcome.Result)
	}
	if snap.Progress.BytesDone <= 0 {
		t.Fatalf("进度没有推进：%+v", snap.Progress)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("目标包读不出来：%v", err)
	}
}

// 取消导出：结局是 cancelled，目标不存在，也不留下临时产物。
func TestCancelExportLeavesNoTarget(t *testing.T) {
	root := t.TempDir()
	svc := New(root)
	dir := t.TempDir()
	target := filepath.Join(dir, "取消.ugcpack")
	if !svc.Export(target, exportFixture(root)).OK {
		t.Fatal("Export 启动失败")
	}
	svc.CancelExport()
	deadline := time.Now().Add(10 * time.Second)
	var snap ExportSnapshot
	for time.Now().Before(deadline) {
		snap = svc.ExportSnapshot()
		if !snap.Running && snap.Outcome != nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if snap.Outcome == nil || snap.Outcome.Kind != packexport.KindCancelled {
		t.Fatalf("取消结局 = %+v", snap)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("取消不该留下目标：%v", err)
	}
	left, _ := os.ReadDir(dir)
	if len(left) != 0 {
		t.Fatalf("取消留下临时产物：%+v", left)
	}
}
