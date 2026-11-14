package localservice

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// TestReadFileBase64AllRemainders 标准 base64 与编码长度无关：三种余数都要与标准库一致（C2）。
func TestReadFileBase64AllRemainders(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	for _, n := range []int{0, 1, 2, 3, 4, 5} {
		data := make([]byte, n)
		for i := range data {
			data[i] = byte(i + 1)
		}
		path := filepath.Join(store.Root(), "b.bin")
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatalf("写文件: %v", err)
		}
		got, err := svc.ReadFile(path)
		if err != nil {
			t.Fatalf("ReadFile: %v", err)
		}
		if want := base64.StdEncoding.EncodeToString(data); got != want {
			t.Fatalf("n=%d base64 = %q，期望 %q", n, got, want)
		}
	}
}
