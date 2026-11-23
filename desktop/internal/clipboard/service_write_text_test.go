package clipboard

import (
	"strings"
	"testing"
)

// fakeTextWriter 记下写进系统剪贴板的文本；A1 要求文本写也走 Go 原生剪贴板。
type fakeTextWriter struct {
	got   string
	calls int
}

func (f *fakeTextWriter) WriteText(text string) {
	f.calls++
	f.got = text
}

// fakeTextReader 是写后读回的替身：clipboard 是「写完之后剪贴板里实际是什么」。
type fakeTextReader struct{ clipboard string }

func (f fakeTextReader) ReadText() string { return f.clipboard }

// TestWriteTextUsesTextWriter 文本写必须交给注入的写入端，并在读回一致时报成功。
//
// 页面的调用入口是 Clipboard.WriteText，也就是 Bound（wiring.go 绑的是 NewBound）；
// 这里直接从 Bound 进，同时覆盖它到 Service 的那一层转交。
func TestWriteTextUsesTextWriter(t *testing.T) {
	w := &fakeTextWriter{}
	bound := Bound{Service: Service{TextWriter: w, TextReader: fakeTextReader{clipboard: "kacha:clip:v1:3"}}, read: func(string) ([]byte, error) { return nil, nil }}
	out := bound.WriteText("kacha:clip:v1:3")
	if !out.OK {
		t.Fatalf("结局 = %+v，期望成功", out)
	}
	if w.calls != 1 || w.got != "kacha:clip:v1:3" {
		t.Fatalf("文本写入端收到 calls=%d got=%q", w.calls, w.got)
	}
}

// TestWriteTextVerifiesClipboard 写入端没有错误可报（MyGo 的 WriteText 不返回值）：
// 读回剪贴板对不上时必须明确失败，页面才能提示「Ctrl+V 粘贴节点可能不生效」。
func TestWriteTextVerifiesClipboard(t *testing.T) {
	out := Service{TextWriter: &fakeTextWriter{}, TextReader: fakeTextReader{clipboard: ""}}.WriteText("kacha:clip:v1:1")
	if out.OK {
		t.Fatal("没写进剪贴板不能报成功")
	}
	if out.Kind != TextFailed {
		t.Fatalf("类别 = %q，期望 %q", out.Kind, TextFailed)
	}
	if !strings.Contains(out.Message, "剪贴板") {
		t.Fatalf("消息没说清是剪贴板没写进去：%q", out.Message)
	}
}
