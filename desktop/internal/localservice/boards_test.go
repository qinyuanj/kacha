package localservice

import (
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

// 服务层画板列表：行里带画板文件名（带扩展名）与相对用户数据根的路径。
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
