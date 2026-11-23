package localservice

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 探测图片：格式、尺寸、字节数与 sha256 都在。
func TestInspectImage(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)

	img := image.NewRGBA(image.Rect(0, 0, 3, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 3; x++ {
			img.Set(x, y, color.RGBA{R: 10, G: 20, B: 30, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	path := filepath.Join(store.Root(), "图.png")
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	info, err := svc.InspectImage(path)
	if err != nil {
		t.Fatalf("InspectImage: %v", err)
	}
	if info.Format != "png" {
		t.Fatalf("format = %q, want png", info.Format)
	}
	if info.Width != 3 || info.Height != 2 {
		t.Fatalf("size = %dx%d, want 3x2", info.Width, info.Height)
	}
	if info.Bytes != int64(buf.Len()) {
		t.Fatalf("bytes = %d, want %d", info.Bytes, buf.Len())
	}
	if len(info.SHA256) != 64 {
		t.Fatalf("sha256 = %q", info.SHA256)
	}
	if info.HasAlpha {
		t.Fatalf("不透明图不该报 alpha")
	}
}

// 读文件返回标准 base64，页面侧能还原字节；三种余数的补齐也要对。
// 期望值都是手写的标准 base64 字面量，不由被测代码现算（否则库错了也跟着错）。
func TestReadFileReturnsBase64(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	cases := []struct {
		name string
		data []byte
		want string
	}{
		{"4 字节", []byte{0, 1, 2, 3}, "AAECAw=="},
		{"1 字节", []byte{1}, "AQ=="},
		{"2 字节", []byte{1, 2}, "AQI="},
		{"3 字节", []byte{1, 2, 3}, "AQID"},
	}
	for _, c := range cases {
		path := filepath.Join(store.Root(), c.name+".bin")
		if err := os.WriteFile(path, c.data, 0o644); err != nil {
			t.Fatalf("WriteFile(%s): %v", c.name, err)
		}
		got, err := svc.ReadFile(path)
		if err != nil {
			t.Fatalf("ReadFile(%s): %v", c.name, err)
		}
		if got != c.want {
			t.Fatalf("%s base64 = %q, want %q", c.name, got, c.want)
		}
	}
}

// 越出数据根的路径被拒绝，不会读到别的文件。
func TestReadFileRejectsOutsideRoot(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(base, "outside.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	store := localstore.New(filepath.Join(base, "root"))
	svc := New(store)
	if _, err := svc.ReadFile(outside); err == nil {
		t.Fatalf("越界读应被拒绝")
	}
}

// 灰色 alpha 图要报 alpha。
func TestInspectImageDetectsAlpha(t *testing.T) {
	store := localstore.New(t.TempDir())
	svc := New(store)
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.NRGBA{R: 255, A: 0})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	path := filepath.Join(store.Root(), "透明.png")
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	info, err := svc.InspectImage(path)
	if err != nil {
		t.Fatalf("InspectImage: %v", err)
	}
	if !info.HasAlpha {
		t.Fatalf("alpha 图应报 has_alpha")
	}
}
