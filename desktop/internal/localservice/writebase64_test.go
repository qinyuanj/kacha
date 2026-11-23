package localservice

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 字节经 base64 交给服务（页面侧把 Uint8Array 编成 base64 字符串；直接塞对象的话 Go 的 []byte
// 解不出来）：服务写文件 → ReadFile 原样读回、同名只新建拒绝、越界路径拒绝。
//
// 输入用写死的 base64 字面量与写死的字节对照，不用标准库现算，这样编码与解码两边都被钉住。
// 原来这条用例里还有一段 encoding/json 的演练（自己 marshal/unmarshal 再断言 stdlib 行为），
// 没有一行触到被测产品，已删。
func TestWriteNewFileBase64RoundTrip(t *testing.T) {
	root := t.TempDir()
	svc := New(localstore.New(root))
	const dataB64 = "iVBORw0KGgoA/4BA"
	want := []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 64}
	path := filepath.Join(root, "2026-11-17", "task-153", "result.png")

	outcome, err := svc.WriteNewFileBase64(path, dataB64)
	if err != nil || !outcome.OK {
		t.Fatalf("WriteNewFileBase64: %+v, %v", outcome, err)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != string(want) {
		t.Fatalf("落盘字节 = %v, %v；want %v", got, err, want)
	}
	if got, err := svc.ReadFile(path); err != nil || got != dataB64 {
		t.Fatalf("读回 base64 = %q, %v；want %q", got, err, dataB64)
	}

	again, err := svc.WriteNewFileBase64(path, dataB64)
	if err != nil || again.OK || again.Kind != localstore.KindAlreadyExist {
		t.Fatalf("同名第二次写入应只新建拒绝：%+v, %v", again, err)
	}

	outside := filepath.Join(filepath.Dir(root), "outside.png")
	escaped, err := svc.WriteNewFileBase64(outside, dataB64)
	if err != nil || escaped.OK {
		t.Fatalf("越界路径应拒绝：%+v, %v", escaped, err)
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("越界写入不该落盘：%v", err)
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
