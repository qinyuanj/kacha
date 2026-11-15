package clipboard

import "testing"

// pngBytes 造一段带 PNG 文件头的字节。
func pngBytes() []byte {
	return append([]byte{}, PNGMagic...)
}

// TestClassify 盯住分类顺序：标记优先于图片，图片优先于文件与文本。
func TestClassify(t *testing.T) {
	cases := []struct {
		name    string
		content Content
		kind    Kind
		reason  string
	}{
		{"节点标记", Content{Text: "kacha:clip:v1:2", HasText: true}, KindMark, ""},
		{"标记带空白也算", Content{Text: "  kacha:clip:v1:1\n", HasText: true}, KindMark, ""},
		{"标记计数为零不算", Content{Text: "kacha:clip:v1:0", HasText: true}, KindText, ""},
		{"图片", Content{Images: [][]byte{pngBytes()}}, KindImages, ""},
		{"标记与图片都在：标记优先", Content{Text: "kacha:clip:v1:3", HasText: true, Images: [][]byte{pngBytes()}}, KindMark, ""},
		{"文件", Content{HasFiles: true}, KindUnsupported, ReasonFiles},
		{"普通文本", Content{Text: "一段话", HasText: true}, KindText, ""},
		{"别的格式", Content{OtherFormats: []string{"image/heic"}}, KindUnsupported, ReasonFormat},
		{"什么都没有", Content{}, KindEmpty, ""},
		{"空文本不算有内容", Content{Text: "", HasText: true}, KindEmpty, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Classify(c.content)
			if got.Kind != c.kind {
				t.Fatalf("类别 = %q，期望 %q", got.Kind, c.kind)
			}
			if got.Reason != c.reason {
				t.Fatalf("原因 = %q，期望 %q", got.Reason, c.reason)
			}
		})
	}
}

// TestClassifyKeepsImageOrder 图片的先后顺序不能变：粘多张时按剪贴板里的顺序落成参考图。
func TestClassifyKeepsImageOrder(t *testing.T) {
	first := append([]byte{}, PNGMagic...)
	second := append([]byte{}, PNGMagic...)
	second = append(second, 0x01)
	out := Classify(Content{Images: [][]byte{first, second}})
	if out.Kind != KindImages {
		t.Fatalf("类别 = %q，期望 %q", out.Kind, KindImages)
	}
	if len(out.Images) != 2 || &out.Images[0][0] != &first[0] || &out.Images[1][0] != &second[0] {
		t.Fatalf("图片顺序变了：%v", out.Images)
	}
}

// TestOversized 单张上限是 64 MiB，与画板侧粘贴的上限一致。
func TestOversized(t *testing.T) {
	if MaxImageBytes != 64*1024*1024 {
		t.Fatalf("单张上限 = %d，期望 %d", MaxImageBytes, 64*1024*1024)
	}
	if Oversized(MaxImageBytes) {
		t.Fatal("刚好到上限不该算超限")
	}
	if !Oversized(MaxImageBytes + 1) {
		t.Fatal("超出一字节就该算超限")
	}
}

// TestIsPNG 只认 PNG 文件头。
func TestIsPNG(t *testing.T) {
	if !IsPNG(pngBytes()) {
		t.Fatal("PNG 文件头没认出来")
	}
	if IsPNG([]byte{0xff, 0xd8, 0xff}) {
		t.Fatal("JPEG 不该当成 PNG")
	}
	if ext, ok := ImageExtension(pngBytes()); !ok || ext != "png" {
		t.Fatalf("扩展名 = %q，%v", ext, ok)
	}
	if _, ok := ImageExtension([]byte{0xff, 0xd8, 0xff}); ok {
		t.Fatal("JPEG 不该给出扩展名")
	}
}

// TestIsMarkText 盯住标记的形状：前缀 + 从 1 起、不许多一位前导零的计数。
func TestIsMarkText(t *testing.T) {
	for _, text := range []string{"kacha:clip:v1:1", "kacha:clip:v1:42", "  kacha:clip:v1:7  "} {
		if !IsMarkText(text) {
			t.Fatalf("%q 该算节点标记", text)
		}
	}
	for _, text := range []string{"", "kacha:clip:v1:", "kacha:clip:v1:0", "kacha:clip:v1:01", "kacha:clip:v1:x", "kacha:clip:v2:1", "一段话"} {
		if IsMarkText(text) {
			t.Fatalf("%q 不该算节点标记", text)
		}
	}
}
