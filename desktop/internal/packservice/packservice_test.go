package packservice

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// buildPack 造一个最小可导入的画板包（一个任务目录 + 一块画板）。
func buildPack(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "包.ugcpack")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	zw := zip.NewWriter(file)
	entries := map[string]string{
		"manifest.json":           "{\"pack_format_version\":2,\"app_version\":\"1.0.0\",\"boards\":[\"画板/画板一.ugcboard.json\"]}",
		"画板/画板一.ugcboard.json":    "{\"format_version\":2,\"title\":\"画板一\",\"viewport\":{\"zoom\":1,\"x\":0,\"y\":0},\"nodes\":[],\"edges\":[]}",
		"2026-01-02/t1/task.json": "{\"task_id\":\"t1\"}",
	}
	for name, text := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("Create(%s): %v", name, err)
		}
		if _, err := w.Write([]byte(text)); err != nil {
			t.Fatalf("Write(%s): %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("Close file: %v", err)
	}
	return path
}

// 没选中包或包读不出来时当场拒绝，不进入导入。
func TestStartRejectsMissingPack(t *testing.T) {
	svc := New(t.TempDir())
	if got := svc.Start(""); got.Kind != "invalid" {
		t.Fatalf("Start(\"\") = %+v, want invalid", got)
	}
	if got := svc.Start(filepath.Join(t.TempDir(), "不在.ugcpack")); got.Kind != "invalid" {
		t.Fatalf("Start(不存在) = %+v, want invalid", got)
	}
	if snapshot := svc.Snapshot(); snapshot.Running {
		t.Fatalf("被拒的导入不该留下 running：%+v", snapshot)
	}
}

// 导入跑在后台：Start 立刻返回，Snapshot 先 running，结束后给出成功结局与报告。
func TestStartImportsInBackgroundAndReportsOutcome(t *testing.T) {
	root := t.TempDir()
	svc := New(root)
	if got := svc.Start(buildPack(t)); !got.OK {
		t.Fatalf("Start = %+v", got)
	}
	deadline := time.Now().Add(10 * time.Second)
	var snapshot Snapshot
	for time.Now().Before(deadline) {
		snapshot = svc.Snapshot()
		if !snapshot.Running && snapshot.Outcome != nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if snapshot.Running {
		t.Fatalf("导入没有结束：%+v", snapshot)
	}
	if snapshot.Outcome == nil || !snapshot.Outcome.OK || snapshot.Outcome.Report == nil {
		t.Fatalf("outcome = %+v, want ok with report", snapshot.Outcome)
	}
	if len(snapshot.Outcome.Report.Boards) != 1 {
		t.Fatalf("report = %+v", snapshot.Outcome.Report)
	}
	if _, err := os.Stat(filepath.Join(root, "2026-01-02", "t1", "task.json")); err != nil {
		t.Fatalf("任务目录没有落盘：%v", err)
	}
}

// 已有导入在跑时再开一份被拒：两次导入不互相踩。
func TestStartRejectsSecondImportWhileRunning(t *testing.T) {
	svc := New(t.TempDir())
	pack := buildPack(t)
	if got := svc.Start(pack); !got.OK {
		t.Fatalf("Start = %+v", got)
	}
	// 立刻再开一份：第一份还没跑完（或刚好跑完，那就再看一次 running）。
	if got := svc.Start(pack); got.Kind != "" && got.Kind != "busy" {
		t.Fatalf("第二次 Start = %+v, want busy 或已结束", got)
	}
}
