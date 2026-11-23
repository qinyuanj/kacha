package localservice

import (
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// MeasureBoard 的两种结局：读得懂就返回引用的条目与节点（同一任务目录在板内只算一次），
// 读不懂就明确失败——空度量会被当成 0 字节。
//
// 具体字节数（任务目录 1000 + 参考图 60）由 boardmeasure 的 owner 用例手算钉住
// （boardmeasure_test.go TestMeasureBoardCountsUniqueEntries），这里不重复算一遍。
// 请求体是画板原文，所以还没写进画板文件的改动也能量到，这一点正是上面 owner 用例的输入形态。
func TestMeasureBoardOutcomes(t *testing.T) {
	svc := New(localstore.New(t.TempDir()))

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
	// 结果节点与任务节点指向同一目录时只算一项：这里是两条不同条目。
	if len(m.Dirs) != 2 {
		t.Fatalf("dirs = %v, want 任务目录与参考图各一项", m.Dirs)
	}
	if _, ok := m.Dirs["2026-01-01/20260101T000000Z-aaaaaaaa"]; !ok {
		t.Fatalf("dirs 缺任务目录：%v", m.Dirs)
	}
	if got := m.Nodes["i"]; len(got) != 1 || got[0] != "导入参考图/bbbb.png" {
		t.Fatalf("nodes[i] = %v", got)
	}

	// 读不懂的画板明确失败，不返回空度量（空度量会被当成 0 字节）。
	for _, bad := range []string{"{ 坏了", "[]", `{"format_version": 9, "nodes": []}`, `{"format_version": 2}`} {
		if _, err := svc.MeasureBoard(bad); err == nil {
			t.Fatalf("读不懂的画板被当成了读得懂：%q", bad)
		}
	}
}
