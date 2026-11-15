package packimport

import (
	"archive/zip"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// zipEntry 是测试自己造包用的一个条目：名字、字节与权限（链接用 os.ModeSymlink）。
type zipEntry struct {
	name string
	data []byte
	mode os.FileMode
}

// buildPack 把条目打成 .ugcpack（zip）：测试自己造包，不复用被测实现。
func buildPack(t *testing.T, entries ...zipEntry) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "包.ugcpack")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	zw := zip.NewWriter(file)
	for _, e := range entries {
		header := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		mode := e.mode
		if mode == 0 {
			mode = 0o644
		}
		header.SetMode(mode)
		w, err := zw.CreateHeader(header)
		if err != nil {
			t.Fatalf("CreateHeader(%s): %v", e.name, err)
		}
		if _, err := w.Write(e.data); err != nil {
			t.Fatalf("Write(%s): %v", e.name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("Close zip: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("Close file: %v", err)
	}
	return path
}

// manifestV2 是包格式 v2 的清单文本（键顺序固定，便于逐字节比对）。
func manifestV2(appVersion string, boards []string, duplicates map[string]string) []byte {
	text := "{\"pack_format_version\":2,\"app_version\":\"" + appVersion + "\",\"boards\":[" + quoteAll(boards) + "]"
	if duplicates != nil {
		text += ",\"duplicates\":{" + quotePairs(duplicates) + "}"
	}
	text += "}\n"
	return []byte(text)
}

func quoteAll(items []string) string {
	quoted := make([]string, len(items))
	for i, item := range items {
		quoted[i] = "\"" + item + "\""
	}
	return strings.Join(quoted, ",")
}

func quotePairs(pairs map[string]string) string {
	keys := make([]string, 0, len(pairs))
	for key := range pairs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	quoted := make([]string, len(keys))
	for i, key := range keys {
		quoted[i] = "\"" + key + "\":\"" + pairs[key] + "\""
	}
	return strings.Join(quoted, ",")
}

const boardText = "{\"format_version\":2,\"title\":\"画板一\",\"viewport\":{\"zoom\":1,\"x\":0,\"y\":0},\"nodes\":[{\"id\":\"n1\",\"type\":\"reference\",\"path\":\"导入参考图/abc.png\",\"sha256\":\"abc\"}],\"edges\":[]}"

// 导入一个真实的包之后：画板、任务目录、图片与图层文件都落在用户数据根里，内容逐字节一致。
func TestImportWritesBoardTaskDirsImagesAndLayers(t *testing.T) {
	root := t.TempDir()
	pack := buildPack(t,
		zipEntry{name: "manifest.json", data: manifestV2("1.0.0", []string{"画板/画板一.ugcboard.json"}, nil)},
		zipEntry{name: "画板/画板一.ugcboard.json", data: []byte(boardText)},
		zipEntry{name: "2026-01-02/t1/task.json", data: []byte("{\"task_id\":\"t1\"}")},
		zipEntry{name: "2026-01-02/t1/result.png", data: []byte("RESULT-PNG")},
		zipEntry{name: "2026-01-02/t1/layers.json", data: []byte("[{\"file\":\"layers/01.png\"}]")},
		zipEntry{name: "2026-01-02/t1/layers/01.png", data: []byte("LAYER-01")},
		zipEntry{name: "导入参考图/abc.png", data: []byte("REF-PNG")},
	)

	report, err := New(root).Import(pack)
	if err != nil {
		t.Fatalf("Import: %v", err)
	}

	want := map[string]string{
		"画板/画板一.ugcboard.json":        boardText,
		"2026-01-02/t1/task.json":     "{\"task_id\":\"t1\"}",
		"2026-01-02/t1/result.png":    "RESULT-PNG",
		"2026-01-02/t1/layers.json":   "[{\"file\":\"layers/01.png\"}]",
		"2026-01-02/t1/layers/01.png": "LAYER-01",
		"导入参考图/abc.png":               "REF-PNG",
	}
	for rel, text := range want {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatalf("读 %s：%v", rel, err)
		}
		if string(data) != text {
			t.Fatalf("%s = %q, want %q", rel, string(data), text)
		}
	}
	if report.Imported != 1 || report.Skipped != 0 || len(report.Conflicts) != 0 {
		t.Fatalf("report = %+v, want 1 imported", report)
	}
	if len(report.Boards) != 1 || report.Boards[0] != "画板/画板一.ugcboard.json" {
		t.Fatalf("boards = %v", report.Boards)
	}
	if leftovers := tempDirs(t, root); len(leftovers) != 0 {
		t.Fatalf("临时目录留下了：%v", leftovers)
	}
}

// tempDirs 列出用户数据根下残留的导入临时目录。
func tempDirs(t *testing.T, root string) []string {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	out := []string{}
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), TempPrefix) {
			out = append(out, e.Name())
		}
	}
	return out
}

// snapshot 记下用户数据根里的全部文件与内容：用来断言「拒绝后本地数据保持不变」。
func snapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		if d.IsDir() {
			out[filepath.ToSlash(rel)+"/"] = ""
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		out[filepath.ToSlash(rel)] = string(data)
		return nil
	})
	if err != nil {
		t.Fatalf("WalkDir: %v", err)
	}
	return out
}

// seededRoot 是拒绝类用例共用的前置：用户数据根里已经有一块画板与一个任务目录。
func seededRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "画板"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "画板", "已有.ugcboard.json"), []byte("{\"format_version\":2,\"title\":\"已有\"}"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "2026-01-01", "old"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "2026-01-01", "old", "task.json"), []byte("{\"task_id\":\"old\"}"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	return root
}

// 包内路径越界（..）：拒绝，且本地数据逐字节不变、没有残留临时目录。
func TestRejectsTraversalPath(t *testing.T) {
	root := seededRoot(t)
	before := snapshot(t, root)
	pack := buildPack(t,
		zipEntry{name: "manifest.json", data: manifestV2("1.0.0", []string{"画板/画板一.ugcboard.json"}, nil)},
		zipEntry{name: "画板/画板一.ugcboard.json", data: []byte(boardText)},
		zipEntry{name: "2026-01-02/t1/../../逃出去.txt", data: []byte("x")},
		zipEntry{name: "2026-01-02/t1/task.json", data: []byte("{}")},
	)

	_, err := New(root).Import(pack)
	if err == nil {
		t.Fatal("越界路径的包被接受了")
	}
	var failure *Error
	if !errors.As(err, &failure) || failure.Kind != KindCorrupt {
		t.Fatalf("err = %v, want corrupt", err)
	}
	if got := snapshot(t, root); !sameSnapshot(before, got) {
		t.Fatalf("拒绝后本地数据变了：%v", diffKeys(before, got))
	}
	if leftovers := tempDirs(t, root); len(leftovers) != 0 {
		t.Fatalf("临时目录留下了：%v", leftovers)
	}
}

// 包内符号链接：拒绝（链接可以指向用户数据根之外），本地数据不变。
func TestRejectsSymlinkEntry(t *testing.T) {
	root := seededRoot(t)
	before := snapshot(t, root)
	pack := buildPack(t,
		zipEntry{name: "manifest.json", data: manifestV2("1.0.0", []string{"画板/画板一.ugcboard.json"}, nil)},
		zipEntry{name: "画板/画板一.ugcboard.json", data: []byte(boardText)},
		zipEntry{name: "2026-01-02/t1/task.json", data: []byte("{}")},
		zipEntry{name: "2026-01-02/t1/link.png", data: []byte("C:/Windows/System32/config/SAM"), mode: os.ModeSymlink | 0o777},
	)

	_, err := New(root).Import(pack)
	if err == nil {
		t.Fatal("含符号链接的包被接受了")
	}
	var failure *Error
	if !errors.As(err, &failure) || failure.Kind != KindCorrupt {
		t.Fatalf("err = %v, want corrupt", err)
	}
	if !strings.Contains(failure.Message, "符号链接") {
		t.Fatalf("message = %q, want 提到符号链接", failure.Message)
	}
	if got := snapshot(t, root); !sameSnapshot(before, got) {
		t.Fatalf("拒绝后本地数据变了：%v", diffKeys(before, got))
	}
}

// 清单被截断：拒绝，本地数据不变。
func TestRejectsTruncatedManifest(t *testing.T) {
	root := seededRoot(t)
	before := snapshot(t, root)
	pack := buildPack(t,
		zipEntry{name: "manifest.json", data: []byte("{\"pack_format_version\":2,\"app_ver")},
		zipEntry{name: "画板/画板一.ugcboard.json", data: []byte(boardText)},
	)

	_, err := New(root).Import(pack)
	if err == nil {
		t.Fatal("截断清单的包被接受了")
	}
	var failure *Error
	if !errors.As(err, &failure) || failure.Kind != KindCorrupt || failure.Step != StepCheck {
		t.Fatalf("err = %v, want corrupt at check", err)
	}
	if got := snapshot(t, root); !sameSnapshot(before, got) {
		t.Fatalf("拒绝后本地数据变了：%v", diffKeys(before, got))
	}
}

// 任务目录缺 task.json：拒绝，本地数据不变。
func TestRejectsIncompleteTaskDir(t *testing.T) {
	root := seededRoot(t)
	before := snapshot(t, root)
	pack := buildPack(t,
		zipEntry{name: "manifest.json", data: manifestV2("1.0.0", []string{"画板/画板一.ugcboard.json"}, nil)},
		zipEntry{name: "画板/画板一.ugcboard.json", data: []byte(boardText)},
		zipEntry{name: "2026-01-02/t1/result.png", data: []byte("PNG")},
	)

	_, err := New(root).Import(pack)
	if err == nil {
		t.Fatal("缺 task.json 的包被接受了")
	}
	var failure *Error
	if !errors.As(err, &failure) || failure.Kind != KindCorrupt {
		t.Fatalf("err = %v, want corrupt", err)
	}
	if got := snapshot(t, root); !sameSnapshot(before, got) {
		t.Fatalf("拒绝后本地数据变了：%v", diffKeys(before, got))
	}
}

// sameSnapshot 比对两份快照。
func sameSnapshot(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for key, value := range a {
		if b[key] != value {
			return false
		}
	}
	return true
}

// diffKeys 给出两份快照的差异键（失败时好排查）。
func diffKeys(a, b map[string]string) []string {
	keys := []string{}
	for key := range a {
		if _, ok := b[key]; !ok {
			keys = append(keys, "-"+key)
		}
	}
	for key := range b {
		if _, ok := a[key]; !ok {
			keys = append(keys, "+"+key)
		}
	}
	sort.Strings(keys)
	return keys
}

// v2 包省略了内容相同的条目：导入后这些路径要在，内容与代表条目一致。
func TestImportRestoresOmittedDuplicates(t *testing.T) {
	root := t.TempDir()
	pack := buildPack(t,
		zipEntry{name: "manifest.json", data: manifestV2("1.0.0", []string{"画板/画板一.ugcboard.json"}, map[string]string{
			"2026-01-03/t2/task.json": "2026-01-02/t1/task.json",
		})},
		zipEntry{name: "画板/画板一.ugcboard.json", data: []byte(boardText)},
		zipEntry{name: "2026-01-02/t1/task.json", data: []byte("{\"task_id\":\"t1\"}")},
		zipEntry{name: "2026-01-02/t1/result.png", data: []byte("RESULT")},
		zipEntry{name: "2026-01-03/t2/result.png", data: []byte("RESULT")},
	)

	if _, err := New(root).Import(pack); err != nil {
		t.Fatalf("Import: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(root, "2026-01-03", "t2", "task.json"))
	if err != nil {
		t.Fatalf("被省略的 task.json 没有还原：%v", err)
	}
	if string(data) != "{\"task_id\":\"t1\"}" {
		t.Fatalf("还原内容 = %q", string(data))
	}
	if _, err := os.Stat(filepath.Join(root, "2026-01-03", "t2", "result.png")); err != nil {
		t.Fatalf("任务目录里的其余文件没有移入：%v", err)
	}
}

// 同一个包导入两次：得到一块新的本地画板（名字加序号），任务目录按内容判定为一致、跳过。
func TestImportTwiceCreatesAnotherBoardAndSkipsIdentical(t *testing.T) {
	root := t.TempDir()
	pack := buildPack(t,
		zipEntry{name: "manifest.json", data: manifestV2("1.0.0", []string{"画板/画板一.ugcboard.json"}, nil)},
		zipEntry{name: "画板/画板一.ugcboard.json", data: []byte(boardText)},
		zipEntry{name: "2026-01-02/t1/task.json", data: []byte("{\"task_id\":\"t1\"}")},
	)

	first, err := New(root).Import(pack)
	if err != nil {
		t.Fatalf("第一次导入：%v", err)
	}
	second, err := New(root).Import(pack)
	if err != nil {
		t.Fatalf("第二次导入：%v", err)
	}

	if len(first.Boards) != 1 || len(second.Boards) != 1 {
		t.Fatalf("boards = %v / %v", first.Boards, second.Boards)
	}
	if first.Boards[0] == second.Boards[0] {
		t.Fatalf("第二次导入覆盖了同一块画板：%v", second.Boards)
	}
	for _, rel := range []string{first.Boards[0], second.Boards[0]} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("画板 %s 不在：%v", rel, err)
		}
	}
	if second.Skipped != 1 || second.Imported != 0 {
		t.Fatalf("第二次 report = %+v, want 1 skipped", second)
	}
	if len(second.Conflicts) != 0 {
		t.Fatalf("内容一致不该报冲突：%v", second.Conflicts)
	}
}

// 任务目录内容与本机不同：报冲突、不覆盖，本机那一份逐字节不变。
func TestImportConflictsDoNotOverwriteLocalTaskDir(t *testing.T) {
	root := t.TempDir()
	local := filepath.Join(root, "2026-01-02", "t1")
	if err := os.MkdirAll(local, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(local, "task.json"), []byte("{\"task_id\":\"本机的\"}"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	pack := buildPack(t,
		zipEntry{name: "manifest.json", data: manifestV2("1.0.0", []string{"画板/画板一.ugcboard.json"}, nil)},
		zipEntry{name: "画板/画板一.ugcboard.json", data: []byte(boardText)},
		zipEntry{name: "2026-01-02/t1/task.json", data: []byte("{\"task_id\":\"包里的\"}")},
	)

	report, err := New(root).Import(pack)
	if err != nil {
		t.Fatalf("Import: %v", err)
	}
	if len(report.Conflicts) != 1 || report.Conflicts[0] != "2026-01-02/t1" {
		t.Fatalf("conflicts = %v", report.Conflicts)
	}
	data, err := os.ReadFile(filepath.Join(local, "task.json"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != "{\"task_id\":\"本机的\"}" {
		t.Fatalf("本机内容被覆盖了：%q", string(data))
	}
}

// failingStore 在写第 failAt 块画板时失败：用来验「后一块写失败时前面写好的撤掉」。
type failingStore struct {
	inner  *localstore.Store
	calls  int
	failAt int
}

func (s *failingStore) Root() string { return s.inner.Root() }

func (s *failingStore) CreateBoard(title, text string) (string, localstore.Result) {
	s.calls++
	if s.calls == s.failAt {
		return "", localstore.Result{OK: false, Kind: localstore.KindFailed, Message: "磁盘写满"}
	}
	return s.inner.CreateBoard(title, text)
}

// 画板写到一半失败：一块画板都不留，也没有残留临时目录。
func TestFailedBoardCommitLeavesNoHalfBoard(t *testing.T) {
	root := t.TempDir()
	pack := buildPack(t,
		zipEntry{name: "manifest.json", data: manifestV2("1.0.0", []string{"画板/一.ugcboard.json", "画板/二.ugcboard.json"}, nil)},
		zipEntry{name: "画板/一.ugcboard.json", data: []byte(boardText)},
		zipEntry{name: "画板/二.ugcboard.json", data: []byte(boardText)},
		zipEntry{name: "2026-01-02/t1/task.json", data: []byte("{}")},
	)
	store := &failingStore{inner: localstore.New(root), failAt: 2}

	_, err := NewWithStore(store).Import(pack)
	if err == nil {
		t.Fatal("写画板失败却报成功了")
	}
	var failure *Error
	if !errors.As(err, &failure) || failure.Step != StepBoards {
		t.Fatalf("err = %v, want failure at boards", err)
	}
	if !strings.Contains(failure.Message, "磁盘写满") {
		t.Fatalf("message = %q, want 带上原因", failure.Message)
	}
	entries, err := os.ReadDir(filepath.Join(root, "画板"))
	if err == nil {
		for _, e := range entries {
			t.Fatalf("留下了半成品画板：%s", e.Name())
		}
	}
	if leftovers := tempDirs(t, root); len(leftovers) != 0 {
		t.Fatalf("临时目录留下了：%v", leftovers)
	}
}

// 画板引用的图片在包里没有：节点保留（不丢节点），报告里列出缺图。
func TestMissingImageKeepsNodeWithPlaceholder(t *testing.T) {
	root := t.TempDir()
	missingBoard := "{\"format_version\":2,\"title\":\"缺图画板\",\"viewport\":{\"zoom\":1,\"x\":0,\"y\":0},\"nodes\":[{\"id\":\"n1\",\"type\":\"reference\",\"path\":\"导入参考图/不在.png\",\"sha256\":\"x\"}],\"edges\":[]}"
	pack := buildPack(t,
		zipEntry{name: "manifest.json", data: manifestV2("1.0.0", []string{"画板/缺图画板.ugcboard.json"}, nil)},
		zipEntry{name: "画板/缺图画板.ugcboard.json", data: []byte(missingBoard)},
	)

	report, err := New(root).Import(pack)
	if err != nil {
		t.Fatalf("Import: %v", err)
	}
	if len(report.Missing) != 1 || report.Missing[0] != "导入参考图/不在.png" {
		t.Fatalf("missing = %v", report.Missing)
	}
	data, err := os.ReadFile(filepath.Join(root, "画板", "缺图画板.ugcboard.json"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != missingBoard {
		t.Fatalf("画板被改写了（节点丢了占位）：%q", string(data))
	}
	if !strings.Contains(report.Message, "缺失") {
		t.Fatalf("message = %q, want 提到缺图", report.Message)
	}
}

// 大包不是一口气干完：进度回调按步骤推进，最后的 Done 等于总数。
func TestImportReportsProgress(t *testing.T) {
	root := t.TempDir()
	entries := []zipEntry{
		{name: "manifest.json", data: manifestV2("1.0.0", []string{"画板/画板一.ugcboard.json"}, nil)},
		{name: "画板/画板一.ugcboard.json", data: []byte(boardText)},
	}
	for i := 0; i < 40; i++ {
		dir := fmt.Sprintf("2026-01-02/t%02d", i)
		entries = append(entries,
			zipEntry{name: dir + "/task.json", data: []byte("{}")},
			zipEntry{name: dir + "/result.png", data: []byte("PNG")},
		)
	}
	pack := buildPack(t, entries...)

	steps := []string{}
	lastDone, lastTotal := 0, 0
	im := New(root)
	im.OnProgress(func(p Progress) {
		if p.Step != "" && (len(steps) == 0 || steps[len(steps)-1] != p.Step) {
			steps = append(steps, p.Step)
		}
		if p.Total > 0 {
			lastDone, lastTotal = p.Done, p.Total
		}
	})
	if _, err := im.Import(pack); err != nil {
		t.Fatalf("Import: %v", err)
	}
	for _, want := range []string{StepCheck, StepExtract, StepMerge, StepBoards} {
		found := false
		for _, step := range steps {
			if step == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("进度里没有 %s 这一步：%v", want, steps)
		}
	}
	if lastDone != lastTotal || lastTotal == 0 {
		t.Fatalf("最后的进度 = %d/%d, want 全部做完", lastDone, lastTotal)
	}
}
