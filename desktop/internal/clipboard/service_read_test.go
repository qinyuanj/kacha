package clipboard

import (
	"errors"
	"testing"
)

// TestReadFailureOversizeIsNotBusy 超过 64 MiB 单张上限要报成超限（unsupported + tooLarge），
// 不能折成可重试的 busy——那会让用户对着无法变小的图一直重试。
//
// 错误文案照抄 MyGo v0.9.0 的真实返回值（internal/windows/clipboard.go:165）。
// 原来用的是编出来的文案，MyGo 换措辞时这条守卫会继续绿，真机上却按 failed 收。
func TestReadFailureOversizeIsNotBusy(t *testing.T) {
	kind, reason := readFailureKindReason(errors.New("mygo: clipboard representation exceeds 64 MiB"))
	if kind == string(KindBusy) {
		t.Fatalf("超限读失败被折成 busy：kind=%q", kind)
	}
	if kind != string(KindUnsupported) || reason != ReasonTooLarge {
		t.Fatalf("超限读失败 = (%q, %q)，期望 (%q, %q)", kind, reason, KindUnsupported, ReasonTooLarge)
	}
}

// TestReadFailureBusyStaysBusy 真正的剪贴板占用仍是可重试的 busy。
func TestReadFailureBusyStaysBusy(t *testing.T) {
	kind, reason := readFailureKindReason(errors.New("OpenClipboard: cannot lock clipboard (busy)"))
	if kind != string(KindBusy) || reason != ReasonBusy {
		t.Fatalf("占用读失败 = (%q, %q)，期望 (%q, %q)", kind, reason, KindBusy, ReasonBusy)
	}
}
