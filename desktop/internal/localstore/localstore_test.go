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

// 首次改写前留一份 .bak：.bak 与改写前的主文件逐字节相同；之后再改写不覆盖它；新建画板不留 .bak。
func TestWriteBacksUpOriginalOnlyOnce(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "画板"+BoardExt)
	const first = "{\"v\":1}"

	if r := s.WriteBoard(path, first, WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	if _, err := os.Stat(path + ".bak"); !os.IsNotExist(err) {
		t.Fatalf("新建画板不该留 .bak：%v", err)
	}

	if r := s.WriteBoard(path, "{\"v\":2}", WriteOptions{}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	backup, err := os.ReadFile(path + ".bak")
	if err != nil || string(backup) != first {
		t.Fatalf("bak = %q, %v, want %q", backup, err, first)
	}

	if r := s.WriteBoard(path, "{\"v\":3}", WriteOptions{}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	backup, err = os.ReadFile(path + ".bak")
	if err != nil || string(backup) != first {
		t.Fatalf("第二次改写覆盖了 .bak：%q, %v, want %q", backup, err, first)
	}
	main, err := os.ReadFile(path)
	if err != nil || string(main) != "{\"v\":3}" {
		t.Fatalf("main = %q, %v", main, err)
	}
}

// 目标目录建不出来时写入失败，挡路的那个文件不被改动。
//
// 这里不查临时文件：失败发生在 MkdirAll，writeAtomic 根本没跑，目录里不可能出现临时文件
// （那条循环永远抓不到回归）。写进只读文件、临时文件确实被建出来又清掉的证明在
// boards_test.go 的 TestWriteFailureKeepsOldContentByteForByteAndCleansTemp。
func TestWriteFailureKeepsOldContentWhenDirUnreachable(t *testing.T) {
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
	if got.Kind != KindFailed || got.Message == "" {
		t.Fatalf("失败结局 = %+v, want kind %q 且带原因", got, KindFailed)
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

// 删除画板：主文件与 .bak 一起移进回收区（可恢复），画板目录里不再有它。
func TestRemoveBoardMovesToRecycle(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "画板"+BoardExt)
	s.WriteBoard(path, "{\"a\":1}", WriteOptions{CreateOnly: true})
	// 写第二次留下 .bak：删画板时它必须跟着进回收区，否则只搬走一半。
	s.WriteBoard(path, "{\"a\":2}", WriteOptions{})

	if got := s.RemoveBoard(path, ""); !got.OK {
		t.Fatalf("RemoveBoard: %+v", got)
	}
	if s.IsFile(path) {
		t.Fatalf("画板仍在原处")
	}
	if s.IsFile(path + ".bak") {
		t.Fatalf(".bak 仍留在画板目录")
	}
	recycle := filepath.Join(s.Root(), RecycleDir)
	base := filepath.Base(path)
	for want, content := range map[string]string{base: "{\"a\":2}", base + ".bak": "{\"a\":1}"} {
		data, err := os.ReadFile(filepath.Join(recycle, want))
		if err != nil {
			t.Fatalf("回收区缺 %s：%v", want, err)
		}
		if string(data) != content {
			t.Fatalf("回收区 %s = %q, want %q", want, data, content)
		}
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
