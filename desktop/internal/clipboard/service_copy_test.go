package clipboard

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

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

// TestCopyImageUnsupported HEIC、TIFF 在复制侧明确失败，并指向该节点已有的「另存为…」。
func TestCopyImageUnsupported(t *testing.T) {
	writer := &fakeWriter{}
	service := Service{Writer: writer}
	out := service.CopyImage(fixture(t, "photo.tiff"), "tiff")
	if out.OK {
		t.Fatal("TIFF 不该报成功")
	}
	if out.Kind != ImageUnsupported {
		t.Fatalf("类别 = %q，期望 %q", out.Kind, ImageUnsupported)
	}
	if !strings.Contains(out.Message, "另存为") {
		t.Fatalf("消息没说替代动作：%q", out.Message)
	}
	if writer.call != 0 {
		t.Fatal("不受支持的格式不该碰系统剪贴板")
	}
}

// TestCopyImageUnsupportedNamesRealContainer 提示写错时，消息说的是按字节认出来的容器：
// 用户看到「tiff」而不是被扩展名骗出来的「png」。
func TestCopyImageUnsupportedNamesRealContainer(t *testing.T) {
	out := Service{Writer: &fakeWriter{}}.CopyImage(fixture(t, "photo.tiff"), "png")
	if out.Kind != ImageUnsupported {
		t.Fatalf("类别 = %q，期望 %q", out.Kind, ImageUnsupported)
	}
	if !strings.Contains(out.Message, "tiff") || strings.Contains(out.Message, "（png）") {
		t.Fatalf("消息应说出真实容器：%q", out.Message)
	}
}

// TestCopyImageUnsupportedReportsContainer 结局带上认出来的容器名：页面据此说「TIFF 不受支持」。
func TestCopyImageUnsupportedReportsContainer(t *testing.T) {
	out := Service{Writer: &fakeWriter{}}.CopyImage(fixture(t, "photo.tiff"), "png")
	if out.Kind != ImageUnsupported {
		t.Fatalf("类别 = %q，期望 %q", out.Kind, ImageUnsupported)
	}
	if out.Container != "tiff" {
		t.Fatalf("容器 = %q，期望 tiff", out.Container)
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

// TestBoundCopyImageReadsThroughStore 绑定服务用真实 store 读绝对路径：用户数据根内的绝对路径照用，
// 越出根的路径被拒绝（复制不能把任意本机文件写进剪贴板）。
func TestBoundCopyImageReadsThroughStore(t *testing.T) {
	root := t.TempDir()
	store := localstore.New(root)
	abs := filepath.Join(root, "参考", "cat.jpg")
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatalf("建目录: %v", err)
	}
	if err := os.WriteFile(abs, fixture(t, "photo.jpg"), 0o644); err != nil {
		t.Fatalf("写 fixture: %v", err)
	}
	writer := &fakeWriter{}
	out := Bound{Service: Service{Writer: writer}, read: store.ReadFile}.CopyImage(abs, "jpeg")
	if !out.OK {
		t.Fatalf("结局 = %+v，期望成功", out)
	}
	if !IsPNG(writer.got) {
		t.Fatal("写进系统剪贴板的不是 PNG")
	}

	outside := filepath.Join(t.TempDir(), "secret.png")
	if err := os.WriteFile(outside, fixture(t, "alpha.png"), 0o644); err != nil {
		t.Fatalf("写越界文件: %v", err)
	}
	refused := Bound{Service: Service{Writer: &fakeWriter{}}, read: store.ReadFile}.CopyImage(outside, "png")
	if refused.OK {
		t.Fatal("越出用户数据根的路径不该被读")
	}
}

// TestBoundStillReadsClipboard 绑定的服务仍然能读剪贴板：读与写是同一个服务（#129 / #130）。
func TestBoundStillReadsClipboard(t *testing.T) {
	bound := NewBound(func(string) ([]byte, error) { return nil, errors.New("不该被调用") })
	// 读走 MyGo，测试环境没有窗口：只要方法存在、签名是 Snapshot 即可（真读由真机验收）。
	var _ func() Snapshot = bound.Read
}

// TestCopyImageOtherFailure 别的写失败按 failed 收，不伪装成 busy 让用户白重试。
func TestCopyImageOtherFailure(t *testing.T) {
	service := Service{Writer: &fakeWriter{err: errors.New("OleSetClipboard failed: 0x800401D0")}}
	out := service.CopyImage(fixture(t, "alpha.png"), "png")
	if out.OK || out.Kind != ImageFailed {
		t.Fatalf("结局 = %+v，期望 failed", out)
	}
}
