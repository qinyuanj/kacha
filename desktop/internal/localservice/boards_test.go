package localservice

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

// 服务层保存：带版本而画板已不在时是 missing，不凭空建出画板。
func TestWriteBoardWithVersionOnMissingBoard(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	path := filepath.Join(store.BoardDir(), "本地画板"+localstore.BoardExt)

	got := svc.WriteBoard(path, "{}", BoardWriteOptions{Version: "deadbeef"})
	if got.OK || got.Kind != "missing" {
		t.Fatalf("outcome = %+v, want missing", got)
	}
	if store.IsFile(path) {
		t.Fatalf("不该凭空建出画板文件")
	}
}

// 服务层保存失败：旧内容逐字节不变，没有临时文件，结局带类别与原因。
func TestWriteBoardFailureKeepsOldContent(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	path := filepath.Join(store.BoardDir(), "本地画板"+localstore.BoardExt)
	old := "{\"format_version\":2,\"title\":\"旧\"}"

	if got := svc.WriteBoard(path, old, BoardWriteOptions{CreateOnly: true}); !got.OK {
		t.Fatalf("first write: %+v", got)
	}
	if err := os.Chmod(path, 0o444); err != nil {
		t.Fatalf("Chmod: %v", err)
	}
	defer os.Chmod(path, 0o644)

	got := svc.WriteBoard(path, "{\"title\":\"新\"}", BoardWriteOptions{})
	if got.OK || got.Kind != "failed" {
		t.Fatalf("outcome = %+v, want failed", got)
	}
	if got.Message == "" {
		t.Fatalf("失败要带原因")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != old {
		t.Fatalf("main = %q, want the old content kept", string(data))
	}
	entries, err := os.ReadDir(store.BoardDir())
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("临时文件留下了：%s", e.Name())
		}
	}
}

// 服务层读写往返：写进去的画板原文与版本原样读回来。
func TestReadBoardRoundTrip(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	path := filepath.Join(store.BoardDir(), "本地画板"+localstore.BoardExt)
	text := "{\"format_version\":2,\"title\":\"本地\"}"

	if got := svc.WriteBoard(path, text, BoardWriteOptions{CreateOnly: true}); !got.OK {
		t.Fatalf("WriteBoard: %+v", got)
	}
	texts, err := svc.ReadBoard(path)
	if err != nil {
		t.Fatalf("ReadBoard: %v", err)
	}
	if texts.Main == nil || *texts.Main != text {
		t.Fatalf("main = %v", texts.Main)
	}
	if texts.Version == nil || len(*texts.Version) != 64 {
		t.Fatalf("version = %v", texts.Version)
	}
}

// 服务层画板列表：行里带画板文件名（带扩展名）与相对数据根的路径。
func TestListBoardsReportsNameAndPath(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	if got := svc.WriteBoard(filepath.Join(store.BoardDir(), "一"+localstore.BoardExt), "{}", BoardWriteOptions{CreateOnly: true}); !got.OK {
		t.Fatalf("WriteBoard: %+v", got)
	}

	listing, err := svc.ListBoards()
	if err != nil {
		t.Fatalf("ListBoards: %v", err)
	}
	if len(listing.Boards) != 1 {
		t.Fatalf("boards = %+v, want 1", listing.Boards)
	}
	if listing.Boards[0].Name != "一"+localstore.BoardExt {
		t.Fatalf("name = %q", listing.Boards[0].Name)
	}
	if listing.Boards[0].Path != "画板/一"+localstore.BoardExt {
		t.Fatalf("path = %q", listing.Boards[0].Path)
	}
	if listing.Slots.Used != 1 {
		t.Fatalf("slots = %+v", listing.Slots)
	}
}

// 服务层列画板文件名：带扩展名，供界面派生不重名的文件名。
func TestListBoardNamesReturnsFileNames(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	dir := store.BoardDir()
	if got := svc.WriteBoard(filepath.Join(dir, "本地画板"+localstore.BoardExt), "{}", BoardWriteOptions{CreateOnly: true}); !got.OK {
		t.Fatalf("WriteBoard: %+v", got)
	}

	names, err := svc.ListBoardNames(dir)
	if err != nil {
		t.Fatalf("ListBoardNames: %v", err)
	}
	if len(names) != 1 || names[0] != "本地画板"+localstore.BoardExt {
		t.Fatalf("names = %v", names)
	}
}

// 服务层归档：带版本归档、归档只读、取消归档恢复，失败类别原样给界面。
func TestArchiveAndUnarchiveThroughService(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	text := "{\"format_version\":2,\"title\":\"甲\",\"nodes\":[{\"task\":\"2026-01-01/t1\"}]}"
	created := svc.CreateBoard("甲", text)
	if !created.OK {
		t.Fatalf("CreateBoard: %+v", created)
	}
	dst := filepath.Join(store.BoardDir(), localstore.ArchiveDir, filepath.Base(created.Path))

	archived := svc.ArchiveBoard(created.Path, dst, created.Version)
	if !archived.OK {
		t.Fatalf("ArchiveBoard: %+v", archived)
	}
	listing, err := svc.ListBoards()
	if err != nil || len(listing.Boards) != 1 || !listing.Boards[0].Archived || listing.Slots.Used != 0 {
		t.Fatalf("归档后列表 = %+v, %v", listing, err)
	}
	if got := svc.WriteBoard(dst, "{\"title\":\"改\"}", BoardWriteOptions{}); got.OK || got.Kind != "archived" {
		t.Fatalf("归档画板写入 = %+v, want archived", got)
	}

	back := filepath.Join(store.BoardDir(), filepath.Base(created.Path))
	if got := svc.UnarchiveBoard(dst, back); !got.OK {
		t.Fatalf("UnarchiveBoard: %+v", got)
	}
	texts, err := svc.ReadBoard(back)
	if err != nil || texts.Main == nil || *texts.Main != text {
		t.Fatalf("取消归档内容 = %v, %v", texts.Main, err)
	}
	listing, _ = svc.ListBoards()
	if listing.Slots.Used != 1 {
		t.Fatalf("取消归档后画板位 = %+v, want 1", listing.Slots)
	}
}

// 服务层归档：过期版本拒绝，原画板不动（严格保存后的版本核对）。
func TestArchiveThroughServiceRejectsStaleVersion(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	created := svc.CreateBoard("甲", "{\"title\":\"甲\"}")
	if !created.OK {
		t.Fatalf("CreateBoard: %+v", created)
	}
	dst := filepath.Join(store.BoardDir(), localstore.ArchiveDir, filepath.Base(created.Path))

	got := svc.ArchiveBoard(created.Path, dst, "deadbeef")
	if got.OK || got.Kind != "conflict" {
		t.Fatalf("过期归档 = %+v, want conflict", got)
	}
	if !store.IsFile(created.Path) || store.IsFile(dst) {
		t.Fatalf("过期归档动了画板")
	}
}

// 服务层新建：满 20 位时结局是 slotsFull，不能靠界面预检兜底。
func TestCreateBoardThroughServiceStopsAtSlots(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	for i := 1; i <= localstore.BoardSlots; i++ {
		got := svc.CreateBoard(fmt.Sprintf("画板%d", i), "{}")
		if !got.OK {
			t.Fatalf("CreateBoard #%d: %+v", i, got)
		}
	}
	got := svc.CreateBoard("超限", "{}")
	if got.OK || got.Kind != "slotsFull" {
		t.Fatalf("超限新建 = %+v, want slotsFull", got)
	}
}

// 服务层新建画板：落在画板目录里，返回路径与内容版本；同名再来一块文件名加 (2)。
func TestCreateBoardReturnsPathAndVersion(t *testing.T) {
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
}
