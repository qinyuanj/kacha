package localstore

import (
	"os"
	"path/filepath"
	"testing"
)

// 新建画板再读回来：内容与版本都在。
func TestWriteAndReadBoard(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "测试"+BoardExt)

	if got := s.WriteBoard(path, "{\"a\":1}", WriteOptions{CreateOnly: true}); !got.OK {
		t.Fatalf("WriteBoard: %+v", got)
	}
	texts, err := s.ReadBoard(path)
	if err != nil {
		t.Fatalf("ReadBoard: %v", err)
	}
	if texts.Main == nil || *texts.Main != "{\"a\":1}" {
		t.Fatalf("main = %v", texts.Main)
	}
	if texts.Version == nil || len(*texts.Version) != 64 {
		t.Fatalf("version = %v", texts.Version)
	}
}

// 只新建：目标已存在就拒绝，原内容不变。
func TestWriteCreateOnlyRefusesExisting(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "画板"+BoardExt)
	s.WriteBoard(path, "old", WriteOptions{CreateOnly: true})

	got := s.WriteBoard(path, "new", WriteOptions{CreateOnly: true})
	if got.OK || got.Kind != KindAlreadyExist {
		t.Fatalf("result = %+v, want alreadyExists", got)
	}
	texts, _ := s.ReadBoard(path)
	if texts.Main == nil || *texts.Main != "old" {
		t.Fatalf("main = %v, want old", texts.Main)
	}
}

// 带版本：内容已变就报冲突，旧内容仍在。
func TestWriteVersionConflict(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "画板"+BoardExt)
	s.WriteBoard(path, "{\"a\":1}", WriteOptions{CreateOnly: true})
	texts, _ := s.ReadBoard(path)

	got := s.WriteBoard(path, "{\"a\":2}", WriteOptions{Version: "deadbeef"})
	if got.OK || got.Kind != KindConflict {
		t.Fatalf("result = %+v, want conflict", got)
	}
	after, _ := s.ReadBoard(path)
	if after.Main == nil || *after.Main != "{\"a\":1}" {
		t.Fatalf("main = %v, want the old content kept", after.Main)
	}
	_ = texts
}

// 覆盖时把旧主文件留成 .bak（只留读得出 JSON 的那份）。
func TestWriteKeepsBackup(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "画板"+BoardExt)
	s.WriteBoard(path, "{\"a\":1}", WriteOptions{CreateOnly: true})
	s.WriteBoard(path, "{\"a\":2}", WriteOptions{Version: ""})

	texts, _ := s.ReadBoard(path)
	if texts.Bak == nil || *texts.Bak != "{\"a\":1}" {
		t.Fatalf("bak = %v, want the previous content", texts.Bak)
	}
}

// 写失败不留半截文件：目标目录建不出来时失败，原有文件不变，目录里没有临时文件。
func TestWriteFailureKeepsOldContentAndLeavesNoTemp(t *testing.T) {
	root := t.TempDir()
	s := New(root)

	// blocker 是个文件而不是目录：往它下面建目录会失败，写入因此失败。
	blocker := filepath.Join(root, "blocker")
	if err := os.WriteFile(blocker, []byte("keep"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	got := s.WriteBoard(filepath.Join(blocker, "画板"+BoardExt), "{\"a\":1}", WriteOptions{CreateOnly: true})
	if got.OK {
		t.Fatalf("写到文件下面应该失败：%+v", got)
	}
	data, err := os.ReadFile(blocker)
	if err != nil || string(data) != "keep" {
		t.Fatalf("blocker = %q, %v", data, err)
	}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Fatalf("临时文件留下了：%s", e.Name())
		}
	}
}

// 写成功也不留临时文件：只有完整的画板文件。
func TestWriteLeavesNoTempFiles(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "画板"+BoardExt)
	if r := s.WriteBoard(path, "{\"a\":1}", WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	entries, _ := os.ReadDir(s.BoardDir())
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Fatalf("临时文件留下了：%s", e.Name())
		}
	}
}

// 删除画板：主文件与 .bak 移进回收区，画板目录里不再有它。
func TestRemoveBoardMovesToRecycle(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "画板"+BoardExt)
	s.WriteBoard(path, "{\"a\":1}", WriteOptions{CreateOnly: true})

	if got := s.RemoveBoard(path, ""); !got.OK {
		t.Fatalf("RemoveBoard: %+v", got)
	}
	if s.IsFile(path) {
		t.Fatalf("画板仍在原处")
	}
	recycle := filepath.Join(s.Root(), RecycleDir)
	entries, err := os.ReadDir(recycle)
	if err != nil || len(entries) == 0 {
		t.Fatalf("回收区是空的：%v", err)
	}
}

// 越出数据根的路径一律拒绝。
func TestResolveRejectsOutsideRoot(t *testing.T) {
	s := New(t.TempDir())
	if _, err := s.Resolve(filepath.Join("..", "outside.txt")); err == nil {
		t.Fatalf("越界路径应被拒绝")
	}
	if _, err := s.Resolve(filepath.Join(s.Root(), "inside.txt")); err != nil {
		t.Fatalf("根内路径应被接受：%v", err)
	}
}

// 画板列表：主画板与归档画板分开，画板位只数主画板。
func TestListSeparatesArchived(t *testing.T) {
	s := New(t.TempDir())
	first, r1 := s.CreateBoard("一", "{}")
	if !r1.OK {
		t.Fatalf("CreateBoard: %+v", r1)
	}
	second, r2 := s.CreateBoard("二", "{}")
	if !r2.OK {
		t.Fatalf("CreateBoard: %+v", r2)
	}
	if got := s.ArchiveBoard(second, filepath.Join(s.BoardDir(), ArchiveDir, filepath.Base(second)), ""); !got.OK {
		t.Fatalf("ArchiveBoard: %+v", got)
	}
	_ = first

	listing, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listing.Boards) != 2 {
		t.Fatalf("boards = %+v, want 2", listing.Boards)
	}
	if listing.Slots.Used != 1 {
		t.Fatalf("slots = %+v, want 1", listing.Slots)
	}
	archived := 0
	for _, b := range listing.Boards {
		if b.Archived {
			archived++
		}
	}
	if archived != 1 {
		t.Fatalf("archived = %d, want 1", archived)
	}
}

// 改名：主文件与 .bak 一起搬，目标已存在时拒绝。
func TestRenameBoard(t *testing.T) {
	s := New(t.TempDir())
	from := filepath.Join(s.BoardDir(), "一"+BoardExt)
	to := filepath.Join(s.BoardDir(), "二"+BoardExt)
	s.WriteBoard(from, "{\"a\":1}", WriteOptions{CreateOnly: true})
	s.WriteBoard(from, "{\"a\":2}", WriteOptions{})

	if got := s.RenameBoard(from, to, ""); !got.OK {
		t.Fatalf("RenameBoard: %+v", got)
	}
	if s.IsFile(from) {
		t.Fatalf("原画板还在")
	}
	texts, _ := s.ReadBoard(to)
	if texts.Main == nil || *texts.Main != "{\"a\":2}" {
		t.Fatalf("main = %v", texts.Main)
	}
	if texts.Bak == nil {
		t.Fatalf("备份没跟着搬")
	}
}

// 元数据：settings.json 读写；不存在时读出空串。
func TestMetaReadWrite(t *testing.T) {
	s := New(t.TempDir())
	got, err := s.ReadMeta("settings.json")
	if err != nil || got != "" {
		t.Fatalf("ReadMeta = %q, %v", got, err)
	}
	if r := s.WriteMeta("settings.json", "{\"x\":1}"); !r.OK {
		t.Fatalf("WriteMeta: %+v", r)
	}
	got, _ = s.ReadMeta("settings.json")
	if got != "{\"x\":1}" {
		t.Fatalf("settings = %q", got)
	}
}
