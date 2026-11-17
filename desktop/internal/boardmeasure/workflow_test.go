package boardmeasure_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/boardmeasure"
	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 完整整理流程在真实文件上的样子（#158）：写一块带阶段与定稿的画板，重开读回；
// 收掉未定稿后体量真的变小；移出为新画板时先写新板再改原板；画板位满时原板一字不动。
// 这里不跑界面，验的是存储层：画板文件、任务目录与体量三者的关系。

func writeSized(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

// 一块画板：两个结果（各占一个任务目录）与一个阶段，其中一个结果定稿。
func tidyBoard() string {
	return `{
  "format_version": 2,
  "title": "整理",
  "viewport": {"zoom": 1, "x": 0, "y": 0},
  "nodes": [
    {"id": "keep", "type": "result", "pos": [0, 0], "size": [1, 1], "task_id": "20260101T000000Z-aaaaaaaa",
     "file": "result.png", "path": "2026-01-01/20260101T000000Z-aaaaaaaa/result.png", "layer_count": 0, "final": true,
     "record": {"model": "m", "prompt": "", "negative_prompt": "", "submitted_at": ""}},
    {"id": "drop", "type": "result", "pos": [0, 0], "size": [1, 1], "task_id": "20260101T000000Z-bbbbbbbb",
     "file": "result.png", "path": "2026-01-01/20260101T000000Z-bbbbbbbb/result.png", "layer_count": 0,
     "record": {"model": "m", "prompt": "", "negative_prompt": "", "submitted_at": ""}}
  ],
  "edges": [],
  "stages": [{"id": "s1", "name": "第一轮", "nodes": ["keep", "drop"], "collapsed": true}]
}`
}

// 阶段与定稿写进画板文件后重开还在：收起状态、定稿标记都不丢。
func TestStagesAndFinalSurviveReopen(t *testing.T) {
	store := localstore.New(t.TempDir())
	path := filepath.Join(store.BoardDir(), "整理"+localstore.BoardExt)
	if r := store.WriteBoard(path, tidyBoard(), localstore.WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}

	texts, err := store.ReadBoard(path)
	if err != nil || texts.Main == nil {
		t.Fatalf("ReadBoard: %v %v", texts, err)
	}
	var raw struct {
		Stages []struct {
			ID        string   `json:"id"`
			Name      string   `json:"name"`
			Nodes     []string `json:"nodes"`
			Collapsed bool     `json:"collapsed"`
		} `json:"stages"`
		Nodes []struct {
			ID    string `json:"id"`
			Final bool   `json:"final"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal([]byte(*texts.Main), &raw); err != nil {
		t.Fatalf("重开的画板读不成 JSON：%v", err)
	}
	if len(raw.Stages) != 1 || raw.Stages[0].Name != "第一轮" || !raw.Stages[0].Collapsed || len(raw.Stages[0].Nodes) != 2 {
		t.Fatalf("阶段没保住：%+v", raw.Stages)
	}
	finals := map[string]bool{}
	for _, node := range raw.Nodes {
		finals[node.ID] = node.Final
	}
	if !finals["keep"] || finals["drop"] {
		t.Fatalf("定稿没保住：%+v", finals)
	}
}

// 收掉未定稿：画板体量按删掉的那个任务目录变小，定稿的目录仍计。
func TestPruneShrinksBodySize(t *testing.T) {
	root := t.TempDir()
	writeSized(t, filepath.Join(root, "2026-01-01", "20260101T000000Z-aaaaaaaa", "result.png"), 300)
	writeSized(t, filepath.Join(root, "2026-01-01", "20260101T000000Z-bbbbbbbb", "result.png"), 700)

	before, ok := boardmeasure.MeasureBoard(root, tidyBoard())
	if !ok || before.Total() != 1000 {
		t.Fatalf("整理前体量 = %v, %v", before.Total(), ok)
	}
	// 收掉未定稿后的画板原文：只剩定稿的那个结果节点。
	pruned := `{"format_version": 2, "title": "整理", "viewport": {"zoom": 1, "x": 0, "y": 0},
	  "nodes": [{"id": "keep", "type": "result", "pos": [0, 0], "size": [1, 1], "task_id": "20260101T000000Z-aaaaaaaa",
	    "file": "result.png", "path": "2026-01-01/20260101T000000Z-aaaaaaaa/result.png", "layer_count": 0, "final": true,
	    "record": {"model": "m", "prompt": "", "negative_prompt": "", "submitted_at": ""}}],
	  "edges": [], "stages": [{"id": "s1", "name": "第一轮", "nodes": ["keep"], "collapsed": true}]}`
	after, ok := boardmeasure.MeasureBoard(root, pruned)
	if !ok || after.Total() != 300 {
		t.Fatalf("整理后体量 = %v, %v, want 300", after.Total(), ok)
	}
	// 只移除画板节点：任务目录还在盘上，能凭原路径找回。
	if _, err := os.Stat(filepath.Join(root, "2026-01-01", "20260101T000000Z-bbbbbbbb", "result.png")); err != nil {
		t.Fatalf("收掉未定稿不该动任务目录：%v", err)
	}
}

// 移出为新画板：先成功写出新画板，再从原画板删去这些节点；原画板的旧内容进 .bak，可以撤销。
func TestMoveOutWritesNewBoardBeforeTouchingOriginal(t *testing.T) {
	store := localstore.New(t.TempDir())
	original := filepath.Join(store.BoardDir(), "原画板"+localstore.BoardExt)
	if r := store.WriteBoard(original, tidyBoard(), localstore.WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}

	moved := filepath.Join(store.BoardDir(), "新画板"+localstore.BoardExt)
	if r := store.WriteBoard(moved, tidyBoard(), localstore.WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("写新画板：%+v", r)
	}
	// 新画板写好之后才改原画板（带上内容版本，期间没别人改过才动）。
	texts, err := store.ReadBoard(original)
	if err != nil || texts.Version == nil {
		t.Fatalf("ReadBoard: %v", err)
	}
	trimmed := `{"format_version": 2, "title": "原画板", "viewport": {"zoom": 1, "x": 0, "y": 0}, "nodes": [], "edges": []}`
	if r := store.WriteBoard(original, trimmed, localstore.WriteOptions{Version: *texts.Version}); !r.OK {
		t.Fatalf("改原画板：%+v", r)
	}

	// 新画板还在（撤销只恢复原画板）；原画板的旧内容留在 .bak 里。
	if !store.IsFile(moved) {
		t.Fatalf("新画板不该被撤销带走")
	}
	bak, err := os.ReadFile(original + ".bak")
	if err != nil || string(bak) != tidyBoard() {
		t.Fatalf("原画板的旧内容没留成备份：%v", err)
	}
}

// 画板位满：新建（移出的第一步）被拒，原画板一字不动。
func TestMoveOutRefusedWhenSlotsFullKeepsOriginal(t *testing.T) {
	store := localstore.New(t.TempDir())
	original := filepath.Join(store.BoardDir(), "原画板"+localstore.BoardExt)
	if r := store.WriteBoard(original, tidyBoard(), localstore.WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	for i := 1; i < localstore.BoardSlots; i++ {
		path := filepath.Join(store.BoardDir(), "占位"+string(rune('a'+i))+localstore.BoardExt)
		if r := store.WriteBoard(path, `{"format_version": 2, "nodes": []}`, localstore.WriteOptions{CreateOnly: true}); !r.OK {
			t.Fatalf("WriteBoard: %+v", r)
		}
	}

	got := store.WriteBoard(filepath.Join(store.BoardDir(), "新画板"+localstore.BoardExt), tidyBoard(), localstore.WriteOptions{CreateOnly: true})
	if got.OK || got.Kind != localstore.KindSlotsFull {
		t.Fatalf("画板位满时的结局 = %+v, want slotsFull", got)
	}
	texts, err := store.ReadBoard(original)
	if err != nil || texts.Main == nil || *texts.Main != tidyBoard() {
		t.Fatalf("原画板被动过了：%v %v", texts.Main, err)
	}
}

// 整理模式的度量量的是画板原文：还没保存的节点改动也计入体量。
func TestMeasureIncludesUnsavedNodes(t *testing.T) {
	root := t.TempDir()
	writeSized(t, filepath.Join(root, "2026-01-01", "20260101T000000Z-bbbbbbbb", "result.png"), 700)

	saved, ok := boardmeasure.MeasureBoard(root, tidyBoard())
	if !ok || saved.Total() != 700 {
		t.Fatalf("保存的版本 = %d, %v", saved.Total(), ok)
	}
	// 还没保存的改动：画板上多了一张指向新目录的参考图。
	unsaved := `{"format_version": 2, "nodes": [
	  {"id": "r", "type": "result", "pos": [0,0], "size": [1,1], "task_id": "20260101T000000Z-bbbbbbbb", "file": "result.png",
	   "path": "2026-01-01/20260101T000000Z-bbbbbbbb/result.png", "layer_count": 0,
	   "record": {"model": "m", "prompt": "", "negative_prompt": "", "submitted_at": ""}},
	  {"id": "i", "type": "reference", "pos": [0,0], "size": [1,1], "path": "导入参考图/新.png", "sha256": "x", "display_name": "新.png"}
	], "edges": []}`
	writeSized(t, filepath.Join(root, "导入参考图", "新.png"), 40)
	withUnsaved, ok := boardmeasure.MeasureBoard(root, unsaved)
	if !ok || withUnsaved.Total() != 740 {
		t.Fatalf("含未保存改动的体量 = %d, %v, want 740", withUnsaved.Total(), ok)
	}
}
