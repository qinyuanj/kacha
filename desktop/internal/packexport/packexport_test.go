package packexport

import (
	"archive/zip"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 造一个有两份任务、重复图片与独立参考图的数据根；规格由测试给出，不复用被测实现。
func seedRoot(t *testing.T) (string, Spec, string) {
	t.Helper()
	root := t.TempDir()
	dir1 := filepath.Join(root, "2026-01-02", "t1")
	dir2 := filepath.Join(root, "2026-01-02", "t2")
	for _, dir := range []string{dir1, filepath.Join(dir1, "layers"), dir2, filepath.Join(root, "导入参考图")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("MkdirAll: %v", err)
		}
	}
	write := func(path string, data []byte) {
		t.Helper()
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatalf("WriteFile(%s): %v", path, err)
		}
	}
	png := []byte("fake-png-bytes")
	write(filepath.Join(dir1, "task.json"), []byte("{\"task_id\":\"t1\"}"))
	write(filepath.Join(dir1, "result.png"), png)
	write(filepath.Join(dir1, "layers.json"), []byte("{\"layers\":[]}"))
	write(filepath.Join(dir1, "layers", "01.png"), []byte("layer-one"))
	write(filepath.Join(dir2, "task.json"), []byte("{\"task_id\":\"t2\"}"))
	write(filepath.Join(dir2, "result.png"), png)
	ref := []byte("reference-bytes")
	write(filepath.Join(root, "导入参考图", "abc.png"), ref)

	board := "{\"format_version\":2,\"title\":\"往返画板\",\"viewport\":{\"zoom\":1,\"x\":0,\"y\":0},\"nodes\":[{\"id\":\"r1\",\"type\":\"result\",\"path\":\"2026-01-02/t1/result.png\"}],\"edges\":[]}"
	spec := Spec{
		Texts: []TextEntry{
			{Entry: "manifest.json", Text: "{\"pack_format_version\":2,\"app_version\":\"1.5.0\",\"boards\":[\"画板/往返.ugcboard.json\"],\"duplicates\":{\"2026-01-02/t2/result.png\":\"2026-01-02/t1/result.png\"}}"},
			{Entry: "画板/往返.ugcboard.json", Text: board},
		},
		TaskDirs: []string{"2026-01-02/t1", "2026-01-02/t2"},
		Files:    []FileEntry{{Source: filepath.Join(root, "导入参考图", "abc.png"), Entry: "导入参考图/abc.png"}},
		Omitted:  []string{"2026-01-02/t2/result.png"},
	}
	return root, spec, string(png)
}

func entriesOf(t *testing.T, pack string) map[string]string {
	t.Helper()
	zr, err := zip.OpenReader(pack)
	if err != nil {
		t.Fatalf("OpenReader: %v", err)
	}
	defer zr.Close()
	out := map[string]string{}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("Open(%s): %v", f.Name, err)
		}
		buf, err := io.ReadAll(rc)
		if err != nil {
			t.Fatalf("Read(%s): %v", f.Name, err)
		}
		_ = rc.Close()
		out[f.Name] = string(buf)
	}
	return out
}

func TestFactsExpandsTaskDirsAndReferences(t *testing.T) {
	root, spec, _ := seedRoot(t)
	facts, err := Facts(root, spec)
	if err != nil {
		t.Fatalf("Facts: %v", err)
	}
	want := map[string]int{
		"2026-01-02/t1/task.json": 0,
		"2026-01-02/t1/result.png": 0,
		"2026-01-02/t1/layers.json": 0,
		"2026-01-02/t1/layers/01.png": 0,
		"2026-01-02/t2/task.json": 0,
		"2026-01-02/t2/result.png": 0,
		"导入参考图/abc.png": 0,
	}
	if len(facts) != len(want) {
		t.Fatalf("facts = %+v, want %d entries", facts, len(want))
	}
	sum := sha256.Sum256([]byte("fake-png-bytes"))
	for _, f := range facts {
		if _, ok := want[f.Entry]; !ok {
			t.Fatalf("未预期的条目 %s", f.Entry)
		}
		delete(want, f.Entry)
		if f.Sha256 == "" || f.Size <= 0 {
			t.Fatalf("条目事实不完整：%+v", f)
		}
		if f.Entry == "2026-01-02/t1/result.png" {
			if f.Sha256 != fmt.Sprintf("%x", sum) || f.Size != int64(len("fake-png-bytes")) {
				t.Fatalf("哈希或长度不对：%+v", f)
			}
		}
	}
	if len(want) != 0 {
		t.Fatalf("缺少条目：%+v", want)
	}
}

func TestExportWritesWholePackWithoutOmittedEntries(t *testing.T) {
	root, spec, png := seedRoot(t)
	target := filepath.Join(t.TempDir(), "往返.ugcpack")
	var progress []Progress
	result, err := Export(root, target, spec, func(p Progress) { progress = append(progress, p) }, nil)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if result.TaskDirs != 2 || result.Bytes <= 0 {
		t.Fatalf("result = %+v", result)
	}
	entries := entriesOf(t, target)
	for _, name := range []string{"manifest.json", "画板/往返.ugcboard.json", "2026-01-02/t1/result.png", "2026-01-02/t1/layers/01.png", "2026-01-02/t2/task.json", "导入参考图/abc.png"} {
		if entries[name] == "" {
			t.Fatalf("包内缺少 %s：%+v", name, entries)
		}
	}
	if entries["2026-01-02/t1/result.png"] != png {
		t.Fatalf("图片字节不对")
	}
	if _, ok := entries["2026-01-02/t2/result.png"]; ok {
		t.Fatalf("被去重的条目不该写进包")
	}
	if len(progress) < 2 || progress[len(progress)-1].BytesDone <= 0 {
		t.Fatalf("进度没有推进：%+v", progress)
	}
	// 成功时才留下目标文件；临时产物不能混在目标目录里。
	left, readErr := os.ReadDir(filepath.Dir(target))
	if readErr != nil || len(left) != 1 {
		t.Fatalf("目标目录有残留：%+v %v", left, readErr)
	}
}

func TestExportCancelLeavesNoTarget(t *testing.T) {
	root, spec, _ := seedRoot(t)
	dir := t.TempDir()
	target := filepath.Join(dir, "取消.ugcpack")
	calls := 0
	_, err := Export(root, target, spec, nil, func() bool {
		calls++
		return calls > 2
	})
	if err == nil || err.Kind != KindCancelled {
		t.Fatalf("取消的结局 = %+v, want cancelled", err)
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Fatalf("取消不该留下目标文件：%v", statErr)
	}
	left, _ := os.ReadDir(dir)
	if len(left) != 0 {
		t.Fatalf("取消留下临时产物：%+v", left)
	}
}

func TestExportRejectsOutsideSourceAndUnsafeEntry(t *testing.T) {
	root, spec, _ := seedRoot(t)
	outside := filepath.Join(t.TempDir(), "外部.png")
	if err := os.WriteFile(outside, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	bad := spec
	bad.Files = []FileEntry{{Source: outside, Entry: "导入参考图/外部.png"}}
	if _, err := Facts(root, bad); err == nil || err.Kind != KindInvalid {
		t.Fatalf("越界源文件应被拒：%+v", err)
	}
	bad = spec
	bad.Files = []FileEntry{{Source: filepath.Join(root, "导入参考图", "abc.png"), Entry: "../越界.png"}}
	if _, err := Export(root, filepath.Join(t.TempDir(), "x.ugcpack"), bad, nil, nil); err == nil || err.Kind != KindInvalid {
		t.Fatalf("越界条目应被拒：%+v", err)
	}
}

func TestExportThenImportRoundTrip(t *testing.T) {
	root, spec, png := seedRoot(t)
	pack := filepath.Join(t.TempDir(), "往返.ugcpack")
	if _, err := Export(root, pack, spec, nil, nil); err != nil {
		t.Fatalf("Export: %v", err)
	}
	importRoot := t.TempDir()
	report, err := importInto(importRoot, pack)
	if err != nil {
		t.Fatalf("Import: %v", err)
	}
	if report.Imported != 2 || len(report.Boards) != 1 {
		t.Fatalf("report = %+v", report)
	}
	base := filepath.Join(importRoot, "2026-01-02")
	for _, rel := range []string{"t1/result.png", "t1/layers.json", "t1/layers/01.png", "t2/result.png", "t2/task.json"} {
		data, err := os.ReadFile(filepath.Join(base, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatalf("导入后缺文件 %s：%v", rel, err)
		}
		if rel == "t1/result.png" || rel == "t2/result.png" {
			if string(data) != png {
				t.Fatalf("%s 字节不一致", rel)
			}
		}
	}
	board, err := os.ReadFile(filepath.Join(importRoot, filepath.FromSlash(report.Boards[0])))
	if err != nil || !strings.Contains(string(board), "往返画板") {
		t.Fatalf("导入的画板读不出来：%v %s", err, board)
	}
}
