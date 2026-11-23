package localservice

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 服务层新建画板：只新建撞上同名时结局是 alreadyExists，并带原因。
func TestWriteBoardCreateOnlyConflict(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	path := filepath.Join(store.BoardDir(), "本地画板"+localstore.BoardExt)

	if got := svc.WriteBoard(path, "{}", BoardWriteOptions{CreateOnly: true}); !got.OK {
		t.Fatalf("first write: %+v", got)
	}
	got := svc.WriteBoard(path, "{}", BoardWriteOptions{CreateOnly: true})
	if got.OK || got.Kind != "alreadyExists" {
		t.Fatalf("outcome = %+v, want alreadyExists", got)
	}
	if got.Message == "" {
		t.Fatalf("失败要带原因，界面据此告诉用户")
	}
}

// 服务层画板列表：把本机存储的列表整行映射成页面形状——文件名、相对路径、归档标记、体量，
// 以及画板位与体量提醒线。漏掉 size_lines 时前端容量提醒会恒为 0，所以这里逐字段钉住。
func TestListBoardsMapsStoreListingToPortShape(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	// 任务目录里 5 个字节：可编辑行的体量应当正好是 5（独立字面量，不由被测代码算出来）。
	ref := "2026-01-01/20260101T000000Z-aaaaaaaa"
	if err := os.MkdirAll(filepath.Join(store.Root(), filepath.FromSlash(ref)), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(store.Root(), filepath.FromSlash(ref), "result.png"), []byte("PNGB1"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	mainText := `{"format_version": 2, "title": "一", "nodes": [{"id": "r", "type": "result", "path": "2026-01-01/20260101T000000Z-aaaaaaaa/result.png"}], "edges": []}`
	if got := svc.WriteBoard(filepath.Join(store.BoardDir(), "一"+localstore.BoardExt), mainText, BoardWriteOptions{CreateOnly: true}); !got.OK {
		t.Fatalf("WriteBoard: %+v", got)
	}
	archived := svc.CreateBoard("二", `{"format_version": 2, "title": "二", "nodes": [], "edges": []}`)
	if !archived.OK {
		t.Fatalf("CreateBoard: %+v", archived)
	}
	dst := filepath.Join(store.BoardDir(), localstore.ArchiveDir, filepath.Base(archived.Path))
	if got := svc.ArchiveBoard(archived.Path, dst, ""); !got.OK {
		t.Fatalf("ArchiveBoard: %+v", got)
	}

	listing, err := svc.ListBoards()
	if err != nil {
		t.Fatalf("ListBoards: %v", err)
	}
	if len(listing.Boards) != 2 {
		t.Fatalf("boards = %+v, want 2", listing.Boards)
	}
	if want := (SizeLines{Warn: 500 << 20, Alert: 1024 << 20}); listing.SizeLines != want {
		t.Fatalf("size_lines = %+v, want %+v", listing.SizeLines, want)
	}
	// 归档不占画板位。
	if listing.Slots != (Slots{Used: 1, Total: localstore.BoardSlots}) {
		t.Fatalf("slots = %+v", listing.Slots)
	}

	rows := map[string]BoardEntry{}
	for _, b := range listing.Boards {
		rows[b.Name] = b
	}
	main, ok := rows["一"+localstore.BoardExt]
	if !ok {
		t.Fatalf("列表缺可编辑画板：%+v", listing.Boards)
	}
	if main.Path != "画板/一"+localstore.BoardExt || main.Archived {
		t.Fatalf("可编辑行 = %+v, want path 画板/一 且不在归档", main)
	}
	if main.Bytes == nil || *main.Bytes != 5 {
		t.Fatalf("可编辑行体量 = %v, want 5（未知不能当 0，0 也不能当成未知）", main.Bytes)
	}
	archRow, ok := rows["二"+localstore.BoardExt]
	if !ok {
		t.Fatalf("列表缺归档画板：%+v", listing.Boards)
	}
	if !archRow.Archived || archRow.Path != "画板/归档/二"+localstore.BoardExt {
		t.Fatalf("归档行 = %+v, want archived 且 path 在归档目录", archRow)
	}
	if archRow.Bytes == nil || *archRow.Bytes != 0 {
		t.Fatalf("归档行体量 = %v, want 0（没有引用条目，不是未知 null）", archRow.Bytes)
	}
}

// 服务层新建画板：落在画板目录里，返回路径与内容版本；同名再来一块文件名加 (2)；
// 满 20 位后结局是 slotsFull 且带原因，不能靠界面预检兜底（画板位由本机存储执行，ADR 0019）。
func TestCreateBoardReturnsPathAndVersionAndStopsAtSlots(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	text := "{\"format_version\":2,\"title\":\"本地画板\"}"

	created := svc.CreateBoard("本地画板", text)
	if !created.OK {
		t.Fatalf("CreateBoard: %+v", created)
	}
	if filepath.Base(created.Path) != "本地画板"+localstore.BoardExt {
		t.Fatalf("path = %q", created.Path)
	}
	if len(created.Version) != 64 {
		t.Fatalf("version = %q", created.Version)
	}
	texts, err := svc.ReadBoard(created.Path)
	if err != nil {
		t.Fatalf("ReadBoard: %v", err)
	}
	if texts.Main == nil || *texts.Main != text {
		t.Fatalf("main = %v", texts.Main)
	}

	second := svc.CreateBoard("本地画板", text)
	if !second.OK {
		t.Fatalf("CreateBoard: %+v", second)
	}
	if filepath.Base(second.Path) != "本地画板 (2)"+localstore.BoardExt {
		t.Fatalf("second path = %q", second.Path)
	}

	// 已经用了 2 位：再建到满位，下一块必须被拒。
	for i := 2; i < localstore.BoardSlots; i++ {
		if got := svc.CreateBoard(fmt.Sprintf("画板%d", i), "{}"); !got.OK {
			t.Fatalf("CreateBoard #%d: %+v", i, got)
		}
	}
	full := svc.CreateBoard("超限", "{}")
	if full.OK || full.Kind != "slotsFull" || full.Message == "" {
		t.Fatalf("满位新建 = %+v, want slotsFull 且带原因", full)
	}
}
