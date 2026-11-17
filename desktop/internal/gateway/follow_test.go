package gateway

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
)

// 迁移把密钥文件整份复制到新位置后，服务跟着新数据根读：凭据不因迁移而失效，
// 也不因为换了位置就变成另一份身份（密钥文件只是数据根里的一个文件）。
func TestGatewayFollowsSwitchedRoot(t *testing.T) {
	base := t.TempDir()
	first := filepath.Join(base, "旧")
	second := filepath.Join(base, "新")
	for _, dir := range []string{first, second} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("建目录: %v", err)
		}
	}
	roots := dataroot.NewRoots(first)
	svc := NewFollowing(roots)
	if err := svc.WriteApiKey(syntheticKey); err != nil {
		if errors.Is(err, ErrUnsupported) {
			t.Skip("当前平台没有 Windows 系统保护")
		}
		t.Fatalf("写密钥: %v", err)
	}
	// 迁移把整个数据根复制到新位置（这里模拟成复制密钥文件本身）。
	blob, err := os.ReadFile(filepath.Join(first, "api-key.protected"))
	if err != nil {
		t.Fatalf("读保护文件: %v", err)
	}
	if err := os.WriteFile(filepath.Join(second, "api-key.protected"), blob, 0o600); err != nil {
		t.Fatalf("复制保护文件: %v", err)
	}
	roots.Switch(second)
	key, err := svc.ReadApiKey()
	if err != nil || key != syntheticKey {
		t.Fatalf("切换后读密钥 = %q, %v；应为 %q", key, err, syntheticKey)
	}
}
// 迁移复制期间不写密钥：密钥文件是数据根里的一份数据，写进旧位置在切换后就丢了。
// 拦下时给明确错误（ErrMoving），迁移结束后恢复。
func TestApiKeyWritesAreRejectedWhileMovingRoot(t *testing.T) {
	root := t.TempDir()
	roots := dataroot.NewRoots(root)
	svc := NewFollowing(roots)
	if !roots.BeginMove() {
		t.Fatal("开始迁移应当成功")
	}
	if err := svc.WriteApiKey(syntheticKey); !errors.Is(err, ErrMoving) {
		t.Fatalf("迁移期间写密钥 = %v, want ErrMoving", err)
	}
	if err := svc.DeleteApiKey(); !errors.Is(err, ErrMoving) {
		t.Fatalf("迁移期间清密钥 = %v, want ErrMoving", err)
	}
	if _, err := os.Stat(filepath.Join(root, "api-key.protected")); !os.IsNotExist(err) {
		t.Fatalf("迁移期间仍然写出了密钥文件: %v", err)
	}
	roots.EndMove()
	if err := svc.WriteApiKey(syntheticKey); err != nil && !errors.Is(err, ErrUnsupported) {
		t.Fatalf("迁移结束后写密钥: %v", err)
	}
}
