package localstore

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

// 画板位由本机存储执行：满 20 位时，新建与只新建写入都拒绝；已有画板仍可写。
func TestEditableBoardsStopAtBoardSlots(t *testing.T) {
	s := New(t.TempDir())
	for i := 1; i <= BoardSlots; i++ {
		path, r := s.CreateBoard(fmt.Sprintf("画板%d", i), fmt.Sprintf("{\"n\":%d}", i))
		if !r.OK {
			t.Fatalf("CreateBoard #%d: %+v", i, r)
		}
		if !s.IsFile(path) {
			t.Fatalf("画板没落盘：%s", path)
		}
	}

	created, r := s.CreateBoard("超限", "{}")
	if r.OK || r.Kind != KindSlotsFull {
		t.Fatalf("CreateBoard 超限 = %+v, want slotsFull", r)
	}
	if created != "" && s.IsFile(created) {
		t.Fatalf("画板位满还建出了画板：%s", created)
	}
	direct := filepath.Join(s.BoardDir(), "直接新建"+BoardExt)
	if r := s.WriteBoard(direct, "{}", WriteOptions{CreateOnly: true}); r.OK || r.Kind != KindSlotsFull {
		t.Fatalf("WriteBoard(createOnly) 超限 = %+v, want slotsFull", r)
	}
	if s.IsFile(direct) {
		t.Fatalf("画板位满还直接建出了画板")
	}

	first := filepath.Join(s.BoardDir(), "画板1"+BoardExt)
	if r := s.WriteBoard(first, "{\"n\":101}", WriteOptions{}); !r.OK {
		t.Fatalf("满位后已有画板仍应可写：%+v", r)
	}
	texts, err := s.ReadBoard(first)
	if err != nil || texts.Main == nil || *texts.Main != "{\"n\":101}" {
		t.Fatalf("已有画板写入失败：%v %v", texts.Main, err)
	}
}

// 抢位：并发新建也不能超过 20 个可编辑画板位（本机存储是唯一执行点）。
func TestConcurrentCreatesNeverExceedSlots(t *testing.T) {
	s := New(t.TempDir())
	var wg sync.WaitGroup
	var succeeded atomic.Int64
	for i := 1; i <= BoardSlots*2; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			if _, r := s.CreateBoard(fmt.Sprintf("并发%d", n), "{}"); r.OK {
				succeeded.Add(1)
			}
		}(i)
	}
	wg.Wait()

	names, err := s.ListBoardNames(s.BoardDir())
	if err != nil {
		t.Fatalf("ListBoardNames: %v", err)
	}
	if len(names) != BoardSlots || succeeded.Load() != int64(BoardSlots) {
		t.Fatalf("并发新建成功 %d 次、落盘 %d 块，want %d", succeeded.Load(), len(names), BoardSlots)
	}
}

// 归档释放画板位；归档画板只读，写进去会被本机存储拒绝且内容不变。
func TestArchiveFreesSlotAndIsReadOnly(t *testing.T) {
	s := New(t.TempDir())
	text := "{\"title\":\"甲\",\"nodes\":[{\"id\":\"r\",\"task\":\"2026-01-01/t1\"}]}"
	src, r := s.CreateBoard("甲", text)
	if !r.OK {
		t.Fatalf("CreateBoard: %+v", r)
	}
	dst := filepath.Join(s.BoardDir(), ArchiveDir, filepath.Base(src))
	if got := s.ArchiveBoard(src, dst, r.Version); !got.OK {
		t.Fatalf("ArchiveBoard: %+v", got)
	}
	if s.IsFile(src) || !s.IsFile(dst) {
		t.Fatalf("归档后原处不该有画板，归档目录里应该有")
	}
	archived, err := os.ReadFile(dst)
	if err != nil || string(archived) != text {
		t.Fatalf("归档内容 = %q, %v, want %q", archived, err, text)
	}
	listing, err := s.List()
	if err != nil || listing.Slots.Used != 0 {
		t.Fatalf("归档后画板位 = %+v, %v, want 0", listing.Slots, err)
	}
	if got := s.WriteBoard(dst, "{\"title\":\"改\"}", WriteOptions{}); got.OK || got.Kind != KindArchived {
		t.Fatalf("归档画板写入 = %+v, want archived", got)
	}
	after, _ := os.ReadFile(dst)
	if string(after) != text {
		t.Fatalf("归档画板内容被改了：%q", after)
	}
}

// 归档 / 取消归档都认内容版本；过期时原地不动，不误报成功。
func TestArchiveRejectsStaleVersionAndKeepsOriginal(t *testing.T) {
	s := New(t.TempDir())
	text := "{\"title\":\"甲\"}"
	src, _ := s.CreateBoard("甲", text)
	dst := filepath.Join(s.BoardDir(), ArchiveDir, filepath.Base(src))

	if got := s.ArchiveBoard(src, dst, "deadbeef"); got.OK || got.Kind != KindConflict {
		t.Fatalf("过期归档 = %+v, want conflict", got)
	}
	if !s.IsFile(src) {
		t.Fatalf("过期归档把原画板搬走了")
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatalf("过期归档留下了目标文件：%v", err)
	}
	after, _ := os.ReadFile(src)
	if string(after) != text {
		t.Fatalf("过期归档改了原画板：%q", after)
	}
}

// 取消归档恢复内容并占一个画板位；满位时拒绝，归档原件不动。
func TestUnarchiveRestoresAndEnforcesSlots(t *testing.T) {
	s := New(t.TempDir())
	text := "{\"title\":\"甲\",\"future\":{\"x\":1}}"
	src, _ := s.CreateBoard("甲", text)
	archived := filepath.Join(s.BoardDir(), ArchiveDir, filepath.Base(src))
	if got := s.ArchiveBoard(src, archived, ""); !got.OK {
		t.Fatalf("ArchiveBoard: %+v", got)
	}
	for i := 1; i <= BoardSlots; i++ {
		if _, r := s.CreateBoard(fmt.Sprintf("占%d", i), "{}"); !r.OK {
			t.Fatalf("占满画板位 #%d: %+v", i, r)
		}
	}
	back := filepath.Join(s.BoardDir(), filepath.Base(src))
	if got := s.UnarchiveBoard(archived, back); got.OK || got.Kind != KindSlotsFull {
		t.Fatalf("满位取消归档 = %+v, want slotsFull", got)
	}
	if !s.IsFile(archived) || s.IsFile(back) {
		t.Fatalf("满位取消归档动了归档原件")
	}

	victim := filepath.Join(s.BoardDir(), "占1"+BoardExt)
	if got := s.ArchiveBoard(victim, filepath.Join(s.BoardDir(), ArchiveDir, "占1"+BoardExt), ""); !got.OK {
		t.Fatalf("腾位归档: %+v", got)
	}
	if got := s.UnarchiveBoard(archived, back); !got.OK {
		t.Fatalf("有空位取消归档: %+v", got)
	}
	if s.IsFile(archived) || !s.IsFile(back) {
		t.Fatalf("取消归档没有把画板搬回画板目录")
	}
	after, _ := os.ReadFile(back)
	if string(after) != text {
		t.Fatalf("取消归档丢了内容：%q", after)
	}
	listing, _ := s.List()
	if listing.Slots.Used != BoardSlots {
		t.Fatalf("取消归档后画板位 = %d, want %d", listing.Slots.Used, BoardSlots)
	}
}

// 归档搬移失败（目标目录建不出来）时原画板逐字节不变，也不留目标文件。
func TestArchiveFailureKeepsOriginal(t *testing.T) {
	s := New(t.TempDir())
	text := "{\"title\":\"甲\"}"
	src, _ := s.CreateBoard("甲", text)
	blocker := filepath.Join(s.BoardDir(), ArchiveDir)
	if err := os.WriteFile(blocker, []byte("block"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	dst := filepath.Join(blocker, "甲"+BoardExt)

	if got := s.ArchiveBoard(src, dst, ""); got.OK || got.Kind != KindFailed {
		t.Fatalf("归档失败 = %+v, want failed", got)
	}
	if !s.IsFile(src) {
		t.Fatalf("归档失败把原画板搬走了")
	}
	after, _ := os.ReadFile(src)
	if string(after) != text {
		t.Fatalf("归档失败改了原画板：%q", after)
	}
}

// 归档把主文件与 .bak 一起搬；取消归档原样带回来（任务引用与未知字段不被重写）。
func TestArchiveMoveKeepsBackupAndRawContent(t *testing.T) {
	s := New(t.TempDir())
	first := "{\"title\":\"甲\",\"nodes\":[{\"task\":\"2026-01-01/t1\"}]}"
	second := "{\"title\":\"甲\",\"extra\":42}"
	src, _ := s.CreateBoard("甲", first)
	if r := s.WriteBoard(src, second, WriteOptions{}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	archived := filepath.Join(s.BoardDir(), ArchiveDir, filepath.Base(src))
	if got := s.ArchiveBoard(src, archived, ""); !got.OK {
		t.Fatalf("ArchiveBoard: %+v", got)
	}
	main, _ := os.ReadFile(archived)
	bak, _ := os.ReadFile(archived + ".bak")
	if string(main) != second || string(bak) != first {
		t.Fatalf("归档内容 = %q / 备份 = %q", main, bak)
	}
	back := filepath.Join(s.BoardDir(), filepath.Base(src))
	if got := s.UnarchiveBoard(archived, back); !got.OK {
		t.Fatalf("UnarchiveBoard: %+v", got)
	}
	main, _ = os.ReadFile(back)
	bak, _ = os.ReadFile(back + ".bak")
	if string(main) != second || string(bak) != first {
		t.Fatalf("取消归档内容 = %q / 备份 = %q", main, bak)
	}
}
