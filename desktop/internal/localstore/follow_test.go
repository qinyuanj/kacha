package localstore

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
)

// 迁移切换数据根之后，同一个 Store 读写的是新位置：不必重建服务，也不必重启。
func TestStoreFollowsSwitchedRoot(t *testing.T) {
	base := t.TempDir()
	first := filepath.Join(base, "旧")
	second := filepath.Join(base, "新")
	for _, dir := range []string{first, second} {
		if err := os.MkdirAll(filepath.Join(dir, BoardsDir), 0o755); err != nil {
			t.Fatalf("建目录: %v", err)
		}
	}
	roots := dataroot.NewRoots(first)
	store := NewFollowing(roots)

	if store.Root() != first {
		t.Fatalf("Root = %q, want %q", store.Root(), first)
	}
	if out := store.WriteMeta("settings.json", `{"format_version":1}`); !out.OK {
		t.Fatalf("WriteMeta: %+v", out)
	}
	if _, err := os.Stat(filepath.Join(first, MetaDir, "settings.json")); err != nil {
		t.Fatalf("元数据没写进旧位置: %v", err)
	}

	roots.Switch(second)
	if store.Root() != second {
		t.Fatalf("切换后 Root = %q, want %q", store.Root(), second)
	}
	if store.BoardDir() != filepath.Join(second, BoardsDir) {
		t.Fatalf("BoardDir = %q, want %q", store.BoardDir(), filepath.Join(second, BoardsDir))
	}
	if out := store.WriteMeta("settings.json", `{"format_version":2}`); !out.OK {
		t.Fatalf("WriteMeta: %+v", out)
	}
	if _, err := os.Stat(filepath.Join(second, MetaDir, "settings.json")); err != nil {
		t.Fatalf("切换后元数据没写进新位置: %v", err)
	}
	// 越界判定也跟着新位置：旧位置现在是数据根之外。
	if _, err := store.Resolve(filepath.Join(first, "画板", "a.ugcboard.json")); err == nil {
		t.Fatal("切换后旧位置的路径应当越界")
	}
}
// 迁移复制期间不写数据根：状态记录还没切，写进旧位置的内容在切换重载后就丢了。
// 拦下时给明确结局（kind = moving），不是静默丢写；迁移结束后写入恢复。
func TestWritesAreRejectedWhileMovingRoot(t *testing.T) {
	base := t.TempDir()
	oldRoot := filepath.Join(base, "旧")
	if err := os.MkdirAll(filepath.Join(oldRoot, BoardsDir), 0o755); err != nil {
		t.Fatalf("建目录: %v", err)
	}
	roots := dataroot.NewRoots(oldRoot)
	store := NewFollowing(roots)
	board := filepath.Join(store.BoardDir(), "改名前" + BoardExt)
	if out := store.WriteBoard(board, "{\"format_version\":2,\"nodes\":[]}", WriteOptions{CreateOnly: true}); !out.OK {
		t.Fatalf("迁移前的写入应当成功: %+v", out)
	}

	if !roots.BeginMove() {
		t.Fatal("第一次开始迁移应当成功")
	}
	if roots.BeginMove() {
		t.Fatal("已经在迁移中时不能再次开始")
	}
	writes := map[string]func() Result{
		"保存画板":   func() Result { return store.WriteBoard(board, "{\"format_version\":2,\"nodes\":[]}", WriteOptions{Version: ""}) },
		"新建画板":   func() Result { _, out := store.CreateBoard("新的", "{\"format_version\":2,\"nodes\":[]}"); return out },
		"保存设置":   func() Result { return store.WriteMeta("settings.json", "{}") },
		"写新文件":   func() Result { return store.WriteNewFile("导入参考图/x.png", []byte("x")) },
		"改画板名":   func() Result { return store.RenameBoard(board, filepath.Join(store.BoardDir(), "改名后"+BoardExt), "") },
		"删画板":    func() Result { return store.RemoveBoard(board, "") },
		"归档画板":   func() Result { return store.ArchiveBoard(board, filepath.Join(store.BoardDir(), ArchiveDir, "改名前"+BoardExt), "") },
		"取消归档画板": func() Result {
			return store.UnarchiveBoard(filepath.Join(store.BoardDir(), ArchiveDir, "改名前"+BoardExt), filepath.Join(store.BoardDir(), "回来"+BoardExt))
		},
	}
	for name, write := range writes {
		out := write()
		if out.OK || out.Kind != KindMoving {
			t.Fatalf("%s 在迁移期间被放行了: %+v", name, out)
		}
		if out.Message == "" {
			t.Fatalf("%s 被拦下但没有说明原因", name)
		}
	}
	if _, err := os.Stat(filepath.Join(oldRoot, MetaDir, "settings.json")); !os.IsNotExist(err) {
		t.Fatalf("迁移期间仍然写出了设置文件: %v", err)
	}

	roots.EndMove()
	if out := store.WriteMeta("settings.json", "{}"); !out.OK {
		t.Fatalf("迁移结束后写入应当恢复: %+v", out)
	}
	if out := store.WriteBoard(board, "{\"format_version\":2,\"nodes\":[]}", WriteOptions{Version: ""}); !out.OK {
		t.Fatalf("迁移结束后保存画板应当恢复: %+v", out)
	}
}
