package clipboard

import "testing"

// fakeTextWriter 记下写进系统剪贴板的文本；A1 要求文本写也走 Go 原生剪贴板。
type fakeTextWriter struct {
	got   string
	calls int
}

func (f *fakeTextWriter) WriteText(text string) {
	f.calls++
	f.got = text
}

// TestServiceWriteTextUsesTextWriter 文本写必须交给注入的写入端（生产端是 MyGo 的 Clipboard.WriteText）。
func TestServiceWriteTextUsesTextWriter(t *testing.T) {
	w := &fakeTextWriter{}
	Service{TextWriter: w}.WriteText("kacha:clip:v1:3")
	if w.calls != 1 || w.got != "kacha:clip:v1:3" {
		t.Fatalf("文本写入端收到 calls=%d got=%q", w.calls, w.got)
	}
}

// TestBoundWriteTextUsesTextWriter 绑定服务（页面经 Clipboard.WriteText 调到）同样走文本写入端。
func TestBoundWriteTextUsesTextWriter(t *testing.T) {
	w := &fakeTextWriter{}
	bound := Bound{Service: Service{TextWriter: w}, read: func(string) ([]byte, error) { return nil, nil }}
	bound.WriteText("复制的节点标记")
	if w.calls != 1 || w.got != "复制的节点标记" {
		t.Fatalf("绑定服务没把文本交给写入端：calls=%d got=%q", w.calls, w.got)
	}
}
