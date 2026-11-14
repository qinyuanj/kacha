package localservice

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 字节以 base64 传进来：页面侧不必把 Uint8Array 塞进 JSON（那会变成对象，Go 的 []byte 解不出来）。
func TestWriteNewFileBase64(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	path := filepath.Join(store.Root(), "导入参考图", "图.png")

	outcome, err := svc.WriteNewFileBase64(path, base64.StdEncoding.EncodeToString([]byte{137, 80, 78, 71}))
	if err != nil {
		t.Fatalf("WriteNewFileBase64: %v", err)
	}
	if !outcome.OK {
		t.Fatalf("outcome = %+v, want ok", outcome)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != string([]byte{137, 80, 78, 71}) {
		t.Fatalf("bytes = %v", got)
	}

	// 同名的第二张不覆盖：内容相同就是同一个文件，页面侧把 alreadyExists 当成功。
	again, err := svc.WriteNewFileBase64(path, base64.StdEncoding.EncodeToString([]byte{137, 80, 78, 71}))
	if err != nil {
		t.Fatalf("WriteNewFileBase64 again: %v", err)
	}
	if again.OK || again.Kind != localstore.KindAlreadyExist {
		t.Fatalf("second write = %+v, want alreadyExists", again)
	}
}

// 不是 base64 的输入是调用方的错：报错而不是写半截文件。
func TestWriteNewFileBase64RejectsBadInput(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	if _, err := svc.WriteNewFileBase64(filepath.Join(store.Root(), "x.png"), "不是 base64"); err == nil {
		t.Fatal("坏输入应当报错")
	}
}
