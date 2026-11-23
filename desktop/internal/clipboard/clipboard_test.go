package clipboard

import (
	"bytes"
	"testing"
)

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
//
// 两张图字节不同，比的是内容与顺序——原来用 &out.Images[0][0] 的指针相等断言「没有拷贝字节」
// 这一实现形状，一个行为正确的防御性拷贝实现会误红。
func TestClassifyKeepsImageOrder(t *testing.T) {
	first := append(append([]byte{}, PNGMagic...), 0x01)
	second := append(append([]byte{}, PNGMagic...), 0x02)
	out := Classify(Content{Images: [][]byte{first, second}})
	if out.Kind != KindImages {
		t.Fatalf("类别 = %q，期望 %q", out.Kind, KindImages)
	}
	if len(out.Images) != 2 {
		t.Fatalf("图片张数 = %d，期望 2", len(out.Images))
	}
	for i, want := range [][]byte{first, second} {
		if !bytes.Equal(out.Images[i], want) {
			t.Fatalf("第 %d 张 = %v，期望 %v", i, out.Images[i], want)
		}
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
