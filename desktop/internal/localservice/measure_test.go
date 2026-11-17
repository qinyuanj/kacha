package localservice

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 整理模式的度量（#158）：请求体是画板原文（可以是还没保存的内容），返回节点引用的条目与各条目字节数。
// 同一任务目录在板内只算一次；独立图片（导入参考图）按文件本身计。
func TestMeasureBoardCountsUniqueEntries(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	write := func(rel string, size int) {
		t.Helper()
		abs := filepath.Join(store.Root(), filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatalf("MkdirAll: %v", err)
		}
		if err := os.WriteFile(abs, make([]byte, size), 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}
	write("2026-01-01/20260101T000000Z-aaaaaaaa/task.json", 600)
	write("2026-01-01/20260101T000000Z-aaaaaaaa/result.png", 400)
	write("导入参考图/bbbb.png", 60)

	// 未保存的改动也能量：这里给的是还没写进画板文件的原文（多了一个指向同一目录的结果节点）。
	text := `{"format_version": 2, "title": "体量", "viewport": {"zoom": 1, "x": 0, "y": 0}, "nodes": [
	  {"id": "r", "type": "result", "pos": [0,0], "size": [1,1], "task_id": "20260101T000000Z-aaaaaaaa", "file": "result.png",
	   "path": "2026-01-01/20260101T000000Z-aaaaaaaa/result.png", "layer_count": 0,
	   "record": {"model": "m", "prompt": "", "negative_prompt": "", "submitted_at": ""}},
	  {"id": "i", "type": "reference", "pos": [0,0], "size": [1,1], "path": "导入参考图/bbbb.png", "sha256": "bbbb", "display_name": "参考.png"}
	], "edges": []}`

	m, err := svc.MeasureBoard(text)
	if err != nil {
		t.Fatalf("MeasureBoard: %v", err)
	}
	if got := m.Dirs["2026-01-01/20260101T000000Z-aaaaaaaa"]; got != 1000 {
		t.Fatalf("任务目录字节 = %d, want 1000", got)
	}
	if got := m.Dirs["导入参考图/bbbb.png"]; got != 60 {
		t.Fatalf("独立图片字节 = %d, want 60", got)
	}
	if len(m.Dirs) != 2 {
		t.Fatalf("dirs = %v, want 两个条目", m.Dirs)
	}
	if got := m.Nodes["i"]; len(got) != 1 || got[0] != "导入参考图/bbbb.png" {
		t.Fatalf("nodes[i] = %v", got)
	}
}

// 读不懂的画板：明确失败，不返回空度量（空度量会被当成 0 字节）。
func TestMeasureBoardRejectsUnreadableBoard(t *testing.T) {
	svc := New(localstore.New(t.TempDir()))
	for _, text := range []string{"{ 坏了", "[]", `{"format_version": 9, "nodes": []}`, `{"format_version": 2}`} {
		if _, err := svc.MeasureBoard(text); err == nil {
			t.Fatalf("读不懂的画板被当成了读得懂：%q", text)
		}
	}
}
