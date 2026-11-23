package boardmeasure

import (
	"os"
	"path/filepath"
	"testing"
)

// 画板体量按唯一任务目录与独立图片算：同一目录在板内只计一次，独立图片按文件大小计一次。
// 夹具里的字节数都是写文件时给定的，期望值由这里手算，不从被测代码推。

func writeFile(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

// 一块板：任务节点带一次提交（task_id 与份数编号指向同一目录），结果节点指向该目录里的图，
// 另有一张导入参考图。目录 1000 字节（含 400 的图），参考图 60 字节。
const refBoard = `{
  "format_version": 2,
  "title": "体量",
  "viewport": {"zoom": 1, "x": 0, "y": 0},
  "nodes": [
    {"id": "p", "type": "prompt", "pos": [0, 0], "size": [1, 1], "text": "猫"},
    {"id": "t", "type": "task", "pos": [0, 0], "size": [1, 1], "model": "m",
     "size_spec": {"tier": null, "ratio": null, "width": null, "height": null},
     "image_ports": 0, "layer_decomposition": false, "transparent_background": false,
     "last_submitted": {"task_id": "20260101T000000Z-aaaaaaaa", "copy_task_ids": ["20260101T000000Z-aaaaaaaa"]}},
    {"id": "r", "type": "result", "pos": [0, 0], "size": [1, 1], "task_id": "20260101T000000Z-aaaaaaaa",
     "file": "result.png", "path": "2026-01-01/20260101T000000Z-aaaaaaaa/result.png", "layer_count": 0,
     "record": {"model": "m", "prompt": "", "negative_prompt": "", "submitted_at": ""}},
    {"id": "i", "type": "reference", "pos": [0, 0], "size": [1, 1],
     "path": "导入参考图/bbbb.png", "sha256": "bbbb", "display_name": "参考.png"}
  ],
  "edges": [],
  "stages": [{"id": "s", "name": "阶段 1", "nodes": ["t", "r"], "collapsed": false}]
}`

func fixtureRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "2026-01-01", "20260101T000000Z-aaaaaaaa", "task.json"), 600)
	writeFile(t, filepath.Join(root, "2026-01-01", "20260101T000000Z-aaaaaaaa", "result.png"), 400)
	writeFile(t, filepath.Join(root, "导入参考图", "bbbb.png"), 60)
	return root
}

// 每个节点引用了哪些任务目录 / 独立图片：不引用任务目录的节点不列，同一目录只列一次。
func TestNodeRefsPerNode(t *testing.T) {
	refs, ok := NodeRefs(refBoard)
	if !ok {
		t.Fatalf("NodeRefs: 读不懂这块画板")
	}
	byID := map[string][]string{}
	for _, r := range refs {
		if len(r.Items) > 0 {
			byID[r.ID] = r.Items
		}
	}
	if got := byID["t"]; len(got) != 1 || got[0] != "2026-01-01/20260101T000000Z-aaaaaaaa" {
		t.Fatalf("任务节点引用 = %v", got)
	}
	if got := byID["r"]; len(got) != 1 || got[0] != "2026-01-01/20260101T000000Z-aaaaaaaa" {
		t.Fatalf("结果节点引用 = %v（路径与 task_id 指向同一目录，只算一次）", got)
	}
	if got := byID["i"]; len(got) != 1 || got[0] != "导入参考图/bbbb.png" {
		t.Fatalf("参考图引用 = %v", got)
	}
	if _, ok := byID["p"]; ok {
		t.Fatalf("提示词节点不该有引用：%v", byID["p"])
	}
}

// 画板体量 = 引用的各条目字节之和：任务目录 1000 + 独立图片 60，任务节点与结果节点共用目录不重复计。
func TestMeasureBoardCountsUniqueEntries(t *testing.T) {
	root := fixtureRoot(t)
	m, ok := MeasureBoard(root, refBoard)
	if !ok {
		t.Fatalf("MeasureBoard: 读不懂这块画板")
	}
	if m.Dirs["2026-01-01/20260101T000000Z-aaaaaaaa"] != 1000 {
		t.Fatalf("任务目录字节 = %d, want 1000", m.Dirs["2026-01-01/20260101T000000Z-aaaaaaaa"])
	}
	if m.Dirs["导入参考图/bbbb.png"] != 60 {
		t.Fatalf("独立图片字节 = %d, want 60", m.Dirs["导入参考图/bbbb.png"])
	}
	if len(m.Dirs) != 2 {
		t.Fatalf("dirs = %v, want 只有两个条目（同一目录只算一次）", m.Dirs)
	}
	if total := totalOf(m); total != 1060 {
		t.Fatalf("画板体量 = %d, want 1060", total)
	}
	if got := m.Nodes["i"]; len(got) != 1 || got[0] != "导入参考图/bbbb.png" {
		t.Fatalf("nodes[i] = %v", got)
	}

	// 量的是请求体（画板原文），不是盘上的画板文件：画板还没保存时新加的节点照样计入。
	writeFile(t, filepath.Join(root, "导入参考图", "cccc.png"), 40)
	unsaved := `{"format_version": 2, "nodes": [
	  {"id": "a", "type": "result", "path": "2026-01-01/20260101T000000Z-aaaaaaaa/result.png"},
	  {"id": "b", "type": "reference", "path": "导入参考图/cccc.png"}
	]}`
	grown, ok := MeasureBoard(root, unsaved)
	if !ok {
		t.Fatalf("MeasureBoard: 读不懂没保存过的画板原文")
	}
	if total := totalOf(grown); total != 1040 {
		t.Fatalf("含未保存改动的体量 = %d, want 1040（任务目录 1000 + 这张新参考图 40）", total)
	}
}

// 引用不存在的条目按 0 计：画板体量仍算得出来，不因为缺图变成未知。
func TestMeasureMissingEntryCountsZero(t *testing.T) {
	m, ok := MeasureBoard(t.TempDir(), refBoard)
	if !ok {
		t.Fatalf("MeasureBoard: 读不懂这块画板")
	}
	if total := totalOf(m); total != 0 {
		t.Fatalf("画板体量 = %d, want 0", total)
	}
	if len(m.Dirs) != 2 {
		t.Fatalf("dirs = %v, want 两个条目都在（各 0 字节）", m.Dirs)
	}
}

// 读不懂的画板（坏 JSON、版本更高、缺 nodes）不能当成没有引用：返回 false，体量为未知。
func TestUnreadableBoardIsUnknown(t *testing.T) {
	for _, text := range []string{"{ 不是 JSON", "[]", `{"format_version": 9, "nodes": []}`, `{"format_version": 2}`} {
		if _, ok := NodeRefs(text); ok {
			t.Fatalf("读不懂的画板被当成了读得懂：%q", text)
		}
		if _, ok := MeasureBoard(t.TempDir(), text); ok {
			t.Fatalf("读不懂的画板量出了体量：%q", text)
		}
	}
}

// 主文件读不懂时按 .bak 算（与打开画板时的回退一致）；都读不懂才是未知（null），不当成 0。
func TestBoardBytesFallsBackToBackup(t *testing.T) {
	root := fixtureRoot(t)
	main := "{ 坏了"
	if got := BoardBytes(root, &main, nil); got != nil {
		t.Fatalf("坏主文件且无备份 = %d, want 未知", *got)
	}
	good := refBoard
	if got := BoardBytes(root, &main, &good); got == nil || *got != 1060 {
		t.Fatalf("坏主文件按备份算 = %v, want 1060", got)
	}
	if got := BoardBytes(root, &good, nil); got == nil || *got != 1060 {
		t.Fatalf("好主文件 = %v, want 1060", got)
	}
	if got := BoardBytes(root, nil, nil); got != nil {
		t.Fatalf("主文件与备份都没有 = %d, want 未知", *got)
	}
}

// 越出数据根的引用不读也不计：路径来自画板文件，不能顺着它读盘。
func TestRefsOutsideRootAreSkipped(t *testing.T) {
	board := `{"format_version": 2, "nodes": [
	  {"id": "i", "type": "reference", "pos": [0,0], "size": [1,1], "path": "../../secret.png", "sha256": "x", "display_name": "x"},
	  {"id": "j", "type": "reference", "pos": [0,0], "size": [1,1], "path": "C:/Windows/win.ini", "sha256": "x", "display_name": "x"}
	], "edges": []}`
	m, ok := MeasureBoard(t.TempDir(), board)
	if !ok {
		t.Fatalf("MeasureBoard: 读不懂这块画板")
	}
	if len(m.Dirs) != 0 {
		t.Fatalf("dirs = %v, want 空（根外引用不读）", m.Dirs)
	}
}

// 读不懂的节点按保守扫描：其中像任务目录 / 任务编号的字符串都算引用（漏认会误删任务目录）。
func TestUnknownNodeScansConservatively(t *testing.T) {
	board := `{"format_version": 2, "nodes": [
	  {"id": "u", "type": "未来的节点", "pos": [0,0], "size": [1,1], "src": "2026-01-01/20260101T000000Z-aaaaaaaa/x.png"}
	], "edges": []}`
	refs, ok := NodeRefs(board)
	if !ok || len(refs) != 1 {
		t.Fatalf("NodeRefs = %v, %v", refs, ok)
	}
	if got := refs[0].Items; len(got) != 1 || got[0] != "2026-01-01/20260101T000000Z-aaaaaaaa" {
		t.Fatalf("读不懂节点的引用 = %v", got)
	}
}

func totalOf(m Measure) int64 {
	total := int64(0)
	for _, n := range m.Dirs {
		total += n
	}
	return total
}
