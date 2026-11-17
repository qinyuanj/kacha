package resultsave

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 造一个有两种结果的数据根：一份带图层，一份普通，另有一个缺失节点。
func seedRoot(t *testing.T) (string, string, string) {
	t.Helper()
	root := t.TempDir()
	task := filepath.Join(root, "2026-01-02", "t1")
	plain := filepath.Join(root, "2026-01-03", "t2")
	for _, dir := range []string{task, filepath.Join(task, "layers"), plain, filepath.Join(root, "画板")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path string, text string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(task, "result.png"), "base-png")
	write(filepath.Join(task, "layers.json"), "{\"layers\":[]}")
	write(filepath.Join(task, "layers", "01.png"), "layer-one")
	write(filepath.Join(task, "layers", "02.png"), "layer-two")
	write(filepath.Join(plain, "result.jpg"), "plain-jpg")
	board := "{\"format_version\":2,\"title\":\"结果板\",\"nodes\":[{\"type\":\"result\",\"path\":\"2026-01-02/t1/result.png\"},{\"type\":\"result\",\"path\":\"2026-01-03/t2/result.jpg\"},{\"type\":\"result\",\"path\":\"2026-01-03/t3/result.png\"},{\"type\":\"result\",\"path\":\"2026-01-02/t1/result.png\"}],\"edges\":[]}"
	boardPath := filepath.Join(root, "画板", "结果板.ugcboard.json")
	write(boardPath, board)
	return root, filepath.Join(task, "result.png"), boardPath
}

func zipNames(t *testing.T, path string) map[string]string {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("OpenReader(%s): %v", path, err)
	}
	defer zr.Close()
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		out[f.Name] = string(data)
	}
	return out
}

func TestSaveResultWithLayersWritesReadableZip(t *testing.T) {
	root, src, _ := seedRoot(t)
	target := filepath.Join(t.TempDir(), "t1.zip")
	if err := SaveResult(root, src, target); err != nil {
		t.Fatalf("SaveResult: %v", err)
	}
	entries := zipNames(t, target)
	for _, name := range []string{"result.png", "layers.json", "layers/01.png", "layers/02.png"} {
		if entries[name] == "" {
			t.Fatalf("结果包缺 %s：%+v", name, entries)
		}
	}
	if entries["result.png"] != "base-png" || entries["layers/02.png"] != "layer-two" {
		t.Fatalf("结果字节不对：%+v", entries)
	}
}

func TestSavePlainResultCopiesOriginalBytes(t *testing.T) {
	root, _, _ := seedRoot(t)
	src := filepath.Join(root, "2026-01-03", "t2", "result.jpg")
	target := filepath.Join(t.TempDir(), "result.jpg")
	if err := SaveResult(root, src, target); err != nil {
		t.Fatalf("SaveResult: %v", err)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "plain-jpg" {
		t.Fatalf("另存的文件不可读：%q %v", data, err)
	}
}

func TestSaveResultMissingOrOutsideIsExplicit(t *testing.T) {
	root, _, _ := seedRoot(t)
	err := SaveResult(root, filepath.Join(root, "2026-01-02", "t1", "不在.png"), filepath.Join(t.TempDir(), "x.png"))
	if err == nil || err.Kind != KindMissing {
		t.Fatalf("缺图结局 = %+v, want missing", err)
	}
	err = SaveResult(root, filepath.Join(root, "..", "外部.png"), filepath.Join(t.TempDir(), "x.png"))
	if err == nil || err.Kind != KindForbidden {
		t.Fatalf("越界结局 = %+v, want forbidden", err)
	}
}

func TestSaveBoardResultsIncludesLayersAndMissingList(t *testing.T) {
	root, _, board := seedRoot(t)
	target := filepath.Join(t.TempDir(), "结果板-结果.zip")
	if err := SaveBoardResults(root, board, target); err != nil {
		t.Fatalf("SaveBoardResults: %v", err)
	}
	entries := zipNames(t, target)
	for _, name := range []string{"2026-01-02/t1/result.png", "2026-01-02/t1/layers.json", "2026-01-02/t1/layers/01.png", "2026-01-03/t2/result.jpg", "缺失文件.txt"} {
		if entries[name] == "" {
			t.Fatalf("整板结果包缺 %s：%+v", name, entries)
		}
	}
	if !strings.Contains(entries["缺失文件.txt"], "2026-01-03/t3/result.png") {
		t.Fatalf("缺失清单没有列出缺图：%q", entries["缺失文件.txt"])
	}
}

// 包内说明是用户可见文案：只用词表的「数据根」，不用词表禁用的「用户数据根」等说法。
func TestMissingNoteUsesGlossaryWord(t *testing.T) {
	root, _, board := seedRoot(t)
	target := filepath.Join(t.TempDir(), "结果板-结果.zip")
	if err := SaveBoardResults(root, board, target); err != nil {
		t.Fatalf("SaveBoardResults: %v", err)
	}
	note := zipNames(t, target)["缺失文件.txt"]
	if !strings.Contains(note, "数据根") {
		t.Fatalf("缺失说明没有用「数据根」：%q", note)
	}
	for _, banned := range []string{"用户数据根", "用户根目录", "输出目录", "数据目录", "工作区"} {
		if strings.Contains(note, banned) {
			t.Fatalf("缺失说明用了词表禁用的说法 %q：%q", banned, note)
		}
	}
}

func TestSaveBoardResultsCorruptBoardIsExplicit(t *testing.T) {
	root, _, _ := seedRoot(t)
	board := filepath.Join(root, "画板", "坏.ugcboard.json")
	if err := os.WriteFile(board, []byte("{ 不是 json"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := SaveBoardResults(root, board, filepath.Join(t.TempDir(), "x.zip"))
	if err == nil || err.Kind != KindCorrupt {
		t.Fatalf("坏画板结局 = %+v, want corrupt", err)
	}
}

func TestSuggestedNameFollowsLayers(t *testing.T) {
	root, src, _ := seedRoot(t)
	if got := SuggestedName(root, src); got != "t1.zip" {
		t.Fatalf("带图层建议名 = %s", got)
	}
	plain := filepath.Join(root, "2026-01-03", "t2", "result.jpg")
	if got := SuggestedName(root, plain); got != "result.jpg" {
		t.Fatalf("普通结果建议名 = %s", got)
	}
}
