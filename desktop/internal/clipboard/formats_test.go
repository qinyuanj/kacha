package clipboard

import (
	"bytes"
	"errors"
	"image"
	"image/png"
	"os"
	"testing"
)

// fixture 读 testdata 下的图片字节（由 PIL 生成，见 desktop/internal/clipboard/testdata）。
func fixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("读 fixture %s: %v", name, err)
	}
	return data
}

// decodePNG 解一段 PNG 字节：复制侧的输出必须是系统能直接用的 PNG。
func decodePNG(t *testing.T, data []byte) image.Image {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("输出不是 PNG：%v", err)
	}
	return img
}

// near 判断两个通道值是否接近（RGBA() 给 16 位，这里折成 8 位比）：
// JPEG / WebP 有损，取色只能取近似。
func near(got, want uint32) bool {
	diff := int(got>>8) - int(want)
	return diff >= -12 && diff <= 12
}

// TestNormalizeKeepsPNG 已经是 PNG 的图原样写进剪贴板：不重编码，透明通道不受损失。
func TestNormalizeKeepsPNG(t *testing.T) {
	source := fixture(t, "alpha.png")
	out, err := Normalize(source, FormatPNG)
	if err != nil {
		t.Fatalf("PNG 归一化失败：%v", err)
	}
	if !bytes.Equal(out, source) {
		t.Fatal("PNG 不该被重编码：重编码会改变字节，也可能丢透明信息")
	}
}

// TestNormalizeKeepsAlpha 透明 PNG 复制后仍然透明：左半不透明红，右半完全透明。
func TestNormalizeKeepsAlpha(t *testing.T) {
	out, err := Normalize(fixture(t, "alpha.png"), FormatPNG)
	if err != nil {
		t.Fatalf("PNG 归一化失败：%v", err)
	}
	img := decodePNG(t, out)
	if img.Bounds().Dx() != 64 || img.Bounds().Dy() != 48 {
		t.Fatalf("尺寸 = %v，期望 64x48", img.Bounds())
	}
	if _, _, _, a := img.At(2, 2).RGBA(); a != 0xffff {
		t.Fatalf("不透明区域的 alpha = %d，期望不透明", a)
	}
	if _, _, _, a := img.At(60, 2).RGBA(); a != 0 {
		t.Fatalf("透明区域的 alpha = %d，期望完全透明", a)
	}
}

// TestNormalizeJPEG JPEG 没有透明通道：折成 PNG 后可见内容不变（尺寸与颜色）。
func TestNormalizeJPEG(t *testing.T) {
	out, err := Normalize(fixture(t, "photo.jpg"), FormatJPEG)
	if err != nil {
		t.Fatalf("JPEG 归一化失败：%v", err)
	}
	img := decodePNG(t, out)
	if img.Bounds().Dx() != 40 || img.Bounds().Dy() != 30 {
		t.Fatalf("尺寸 = %v，期望 40x30", img.Bounds())
	}
	r, g, b, a := img.At(20, 15).RGBA()
	if !near(r, 0) || !near(g, 128) || !near(b, 64) || a != 0xffff {
		t.Fatalf("取色 = (%d,%d,%d,%d)，期望接近 (0,128,64) 且不透明", r, g, b, a)
	}
}

// TestNormalizeWebP WebP 同样只保证可见内容：折成 PNG 后尺寸与颜色不变。
func TestNormalizeWebP(t *testing.T) {
	out, err := Normalize(fixture(t, "photo.webp"), FormatWebP)
	if err != nil {
		t.Fatalf("WebP 归一化失败：%v", err)
	}
	img := decodePNG(t, out)
	if img.Bounds().Dx() != 40 || img.Bounds().Dy() != 30 {
		t.Fatalf("尺寸 = %v，期望 40x30", img.Bounds())
	}
	r, g, b, _ := img.At(20, 15).RGBA()
	if !near(r, 250) || !near(g, 200) || !near(b, 20) {
		t.Fatalf("取色 = (%d,%d,%d)，期望接近 (250,200,20)", r, g, b)
	}
}

// TestNormalizeUnsupportedContainers HEIC、TIFF 这类容器明确失败，不假装写成功。
func TestNormalizeUnsupportedContainers(t *testing.T) {
	heic := append([]byte{0x00, 0x00, 0x00, 0x18}, []byte("ftypheic")...)
	cases := []struct {
		name   string
		data   []byte
		format Format
	}{
		{"TIFF 按字节认出来", fixture(t, "photo.tiff"), "tiff"},
		{"TIFF 即便提示说是 PNG 也按字节拒绝", fixture(t, "photo.tiff"), FormatPNG},
		{"HEIC 文件头", heic, "heic"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Normalize(c.data, c.format)
			if !errors.Is(err, ErrUnsupportedContainer) {
				t.Fatalf("错误 = %v，期望 ErrUnsupportedContainer", err)
			}
		})
	}
}

// TestNormalizeInvalid 认不出或解不开的字节是 invalid，不是 unsupported：
// 前者是内容坏了，后者是容器本来就不支持，界面给的话不一样。
func TestNormalizeInvalid(t *testing.T) {
	cases := []struct {
		name string
		data []byte
	}{
		{"空字节", nil},
		{"随机字节", []byte("not an image at all")},
		{"PNG 文件头但内容是坏的", append(append([]byte{}, PNGMagic...), []byte("garbage")...)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Normalize(c.data, FormatPNG)
			if !errors.Is(err, ErrInvalidImage) {
				t.Fatalf("错误 = %v，期望 ErrInvalidImage", err)
			}
		})
	}
}

// TestNormalizeIgnoresHint 格式提示只是提示：字节说了算，扩展名写错也能复制成功。
func TestNormalizeIgnoresHint(t *testing.T) {
	out, err := Normalize(fixture(t, "photo.jpg"), FormatPNG)
	if err != nil {
		t.Fatalf("提示写错时仍应按字节识别：%v", err)
	}
	if _, err := png.Decode(bytes.NewReader(out)); err != nil {
		t.Fatalf("输出不是 PNG：%v", err)
	}
}

// TestSniff 按文件头认容器：JPEG、PNG、WebP、TIFF、HEIC 各一例。
func TestSniff(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		want Container
	}{
		{"PNG", fixture(t, "alpha.png"), ContainerPNG},
		{"JPEG", fixture(t, "photo.jpg"), ContainerJPEG},
		{"WebP", fixture(t, "photo.webp"), ContainerWebP},
		{"TIFF", fixture(t, "photo.tiff"), ContainerTIFF},
		{"HEIC", append([]byte{0x00, 0x00, 0x00, 0x18}, []byte("ftypheic")...), ContainerHEIC},
		{"认不出", []byte("plain text"), ContainerUnknown},
		{"空", nil, ContainerUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Sniff(c.data); got != c.want {
				t.Fatalf("容器 = %q，期望 %q", got, c.want)
			}
		})
	}
}
