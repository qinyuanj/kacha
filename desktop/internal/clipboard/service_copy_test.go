package clipboard

import (
	"errors"
	"strings"
	"testing"

	"github.com/egoist/mygo"
)

// mygoClipboardError 拼出 MyGo 在 Windows 上写剪贴板失败时的真实文案形状：
// fmt.Errorf("mygo: %s failed (HRESULT %#08x)", what, hr)（见 mygo@v0.9.0 internal/windows/com.go）。
// 手写这份字面量是为了让期望值独立于被测代码：要验的正是「按哪种 HRESULT 归类」。
func mygoClipboardError(what string, hresult string) error {
	return errors.New("mygo: " + what + " failed (HRESULT " + hresult + ")")
}

// fakeWriter 记下写进系统剪贴板的字节；err 模拟剪贴板被占用等写入失败。
type fakeWriter struct {
	got  []byte
	err  error
	call int
}

func (f *fakeWriter) WriteImage(png []byte) error {
	f.call++
	f.got = append([]byte{}, png...)
	return f.err
}

// TestCopyImageWritesPNG 复制成功：交给系统剪贴板的是 PNG，结局是 ok。
func TestCopyImageWritesPNG(t *testing.T) {
	writer := &fakeWriter{}
	service := Service{Writer: writer}
	out := service.CopyImage(fixture(t, "photo.jpg"), "jpeg")
	if !out.OK {
		t.Fatalf("结局 = %+v，期望成功", out)
	}
	if out.Bytes != len(writer.got) || out.Bytes == 0 {
		t.Fatalf("报告的字节数 = %d，实际写入 %d", out.Bytes, len(writer.got))
	}
	if !IsPNG(writer.got) {
		t.Fatal("写进系统剪贴板的不是 PNG：JPEG 必须先归一化")
	}
}

// TestCopyImageUnsupported 容器不受支持时明确失败（HEIC、TIFF 都是 unsupported，不是 invalid）：
// 结局带上按字节认出来的容器，消息说真实容器而不是页面给的提示，并指向该节点已有的「另存为…」，
// 且不碰系统剪贴板。
func TestCopyImageUnsupported(t *testing.T) {
	heic := append([]byte{0x00, 0x00, 0x00, 0x18}, []byte("ftypheic")...)
	cases := []struct {
		name        string
		data        []byte
		hint        Format
		container   Container
		hintIsWrong bool
	}{
		{"TIFF 按字节认出来", fixture(t, "photo.tiff"), "tiff", ContainerTIFF, false},
		{"TIFF 即便提示说是 PNG", fixture(t, "photo.tiff"), FormatPNG, ContainerTIFF, true},
		{"HEIC 文件头", heic, "heic", ContainerHEIC, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			writer := &fakeWriter{}
			out := Service{Writer: writer}.CopyImage(c.data, c.hint)
			if out.OK {
				t.Fatalf("不受支持的容器不该报成功：%+v", out)
			}
			if out.Kind != ImageUnsupported {
				t.Fatalf("类别 = %q，期望 %q", out.Kind, ImageUnsupported)
			}
			if out.Container != string(c.container) {
				t.Fatalf("容器 = %q，期望 %q", out.Container, c.container)
			}
			if !strings.Contains(out.Message, string(c.container)) {
				t.Fatalf("消息应说出真实容器 %q：%q", c.container, out.Message)
			}
			if c.hintIsWrong && strings.Contains(out.Message, "（"+string(c.hint)+"）") {
				t.Fatalf("消息不该被扩展名骗成 %q：%q", c.hint, out.Message)
			}
			if !strings.Contains(out.Message, "另存为") {
				t.Fatalf("消息没说替代动作：%q", out.Message)
			}
			if writer.call != 0 {
				t.Fatal("不受支持的格式不该碰系统剪贴板")
			}
		})
	}
}

// TestCopyImageBusyPrefersStructuredKind 写入端给出结构化的「占用」错误时按 busy 收，
// 不依赖错误文案，MyGo 改措辞也不会把可重试的失败降级成普通失败。
func TestCopyImageBusyPrefersStructuredKind(t *testing.T) {
	service := Service{Writer: &fakeWriter{err: ErrClipboardBusy}}
	if out := service.CopyImage(fixture(t, "alpha.png"), "png"); out.Kind != ImageBusy {
		t.Fatalf("ErrClipboardBusy 的类别 = %q，期望 %q", out.Kind, ImageBusy)
	}
	// MyGo 自己的哨兵值也认：读取期间换了主人同样是可重试的。
	service = Service{Writer: &fakeWriter{err: mygo.ErrClipboardChanged}}
	if out := service.CopyImage(fixture(t, "alpha.png"), "png"); out.Kind != ImageBusy {
		t.Fatalf("ErrClipboardChanged 的类别 = %q，期望 %q", out.Kind, ImageBusy)
	}
}

// TestCopyImageBusy 剪贴板被占用是「可重试」的失败：既不报成功，也不是永久失败。
func TestCopyImageBusy(t *testing.T) {
	service := Service{Writer: &fakeWriter{err: errors.New("OpenClipboard: cannot lock clipboard (busy)")}}
	out := service.CopyImage(fixture(t, "alpha.png"), "png")
	if out.OK {
		t.Fatal("写失败不能报成功")
	}
	if out.Kind != ImageBusy {
		t.Fatalf("类别 = %q，期望 %q", out.Kind, ImageBusy)
	}
	if !strings.Contains(out.Message, "重试") {
		t.Fatalf("消息没说可以重试：%q", out.Message)
	}
	if !strings.Contains(out.Message, "另存为") {
		t.Fatalf("消息没说替代动作：%q", out.Message)
	}
}

// TestCopyImageBusyFromMyGoHResult MyGo 的写入走 OleSetClipboard：剪贴板一直被别的程序占着时它等 1 秒
// 再返回 HRESULT CLIPBRD_E_CANT_OPEN（0x800401D0），文案里没有 "busy"。真机验收（#132）见到这条被折成
// 普通失败，用户看到「写入系统剪贴板失败」而不是可重试的占用，所以这里按真实错误文案钉住。
func TestCopyImageBusyFromMyGoHResult(t *testing.T) {
	real := mygoClipboardError("OleSetClipboard", "0x800401d0")
	out := Service{Writer: &fakeWriter{err: real}}.CopyImage(fixture(t, "alpha.png"), "png")
	if out.OK {
		t.Fatal("写失败不能报成功")
	}
	if out.Kind != ImageBusy {
		t.Fatalf("类别 = %q，期望 %q", out.Kind, ImageBusy)
	}
	if !strings.Contains(out.Message, "重试") {
		t.Fatalf("消息没说可以重试：%q", out.Message)
	}
}

// TestCopyImageInvalid 内容坏掉是 invalid：与「容器不受支持」分开，界面给的话不一样。
func TestCopyImageInvalid(t *testing.T) {
	writer := &fakeWriter{}
	out := Service{Writer: writer}.CopyImage([]byte("not an image"), "png")
	if out.OK || out.Kind != ImageInvalid {
		t.Fatalf("结局 = %+v，期望 invalid", out)
	}
	if writer.call != 0 {
		t.Fatal("内容认不出时不该碰系统剪贴板")
	}
}

// TestBoundCopyImageReadsPath 绑定服务按页面给的路径读字节：读到的图归一化成 PNG 后写入。
func TestBoundCopyImageReadsPath(t *testing.T) {
	writer := &fakeWriter{}
	var asked string
	bound := Bound{Service: Service{Writer: writer}, read: func(path string) ([]byte, error) {
		asked = path
		return fixture(t, "photo.jpg"), nil
	}}
	out := bound.CopyImage("参考/cat.jpg", "jpeg")
	if !out.OK {
		t.Fatalf("结局 = %+v，期望成功", out)
	}
	if asked != "参考/cat.jpg" {
		t.Fatalf("读的路径 = %q，期望原样转交", asked)
	}
	if !IsPNG(writer.got) {
		t.Fatal("写进系统剪贴板的不是 PNG")
	}
}

// TestBoundCopyImageReadFailure 读不到文件（已被移走、越界）：明确失败并指向「另存为…」，不碰剪贴板。
func TestBoundCopyImageReadFailure(t *testing.T) {
	writer := &fakeWriter{}
	bound := Bound{Service: Service{Writer: writer}, read: func(string) ([]byte, error) {
		return nil, errors.New("文件不存在")
	}}
	out := bound.CopyImage("参考/gone.png", "png")
	if out.OK {
		t.Fatal("读不到图不能报成功")
	}
	if !strings.Contains(out.Message, "另存为") {
		t.Fatalf("消息没说替代动作：%q", out.Message)
	}
	if writer.call != 0 {
		t.Fatal("读不到字节时不该碰系统剪贴板")
	}
}

// TestCopyImageOtherFailure 别的写失败按 failed 收，不伪装成 busy 让用户白重试。
//
// 例子用 E_FAIL（0x80004005）：剪贴板被别的程序占着是 CLIPBRD_E_CANT_OPEN（0x800401D0），
// 那一条属于 busy（见 TestCopyImageBusyFromMyGoHResult），真机验收（#132）纠正过这个分类。
func TestCopyImageOtherFailure(t *testing.T) {
	service := Service{Writer: &fakeWriter{err: mygoClipboardError("OleSetClipboard", "0x80004005")}}
	out := service.CopyImage(fixture(t, "alpha.png"), "png")
	if out.OK || out.Kind != ImageFailed {
		t.Fatalf("结局 = %+v，期望 failed", out)
	}
}
