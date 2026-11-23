package gateway

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
)

// 合成秘密只用于测试；真实密钥不进仓库、日志或诊断。
const syntheticKey = "sk-spec152-synthetic-not-real"

// 密钥默认持久化、受 Windows 系统保护：重启（重新构造服务）后仍可读，
// 数据根里的文件不出现明文，替换与清除都落到同一个文件身份上。
func TestApiKeyPersistenceAndProtection(t *testing.T) {
	root := t.TempDir()
	roots := dataroot.NewRoots(root)
	first := NewFollowing(roots)
	if key, err := first.ReadApiKey(); err != nil || key != "" {
		t.Fatalf("初始读密钥 = %q, %v；应为 empty", key, err)
	}
	if err := first.WriteApiKey(syntheticKey); err != nil {
		if errors.Is(err, ErrUnsupported) {
			t.Skip("当前平台没有 Windows 系统保护")
		}
		t.Fatalf("写密钥: %v", err)
	}
	// 重启：换一个服务实例只读同一份文件，不依赖内存缓存。
	restarted := NewFollowing(roots)
	key, err := restarted.ReadApiKey()
	if err != nil || key != syntheticKey {
		t.Fatalf("重启后读密钥 = %q, %v；应为 %q", key, err, syntheticKey)
	}
	stored, err := os.ReadFile(filepath.Join(root, keyFile))
	if err != nil {
		t.Fatalf("读保护文件: %v", err)
	}
	if bytes.Contains(stored, []byte(syntheticKey)) {
		t.Fatalf("保护文件里有明文密钥")
	}
	if len(stored) < len(syntheticKey) {
		t.Fatalf("保护文件太短，不像系统保护后的密文：%d 字节", len(stored))
	}

	// 替换：新实例写新密钥，旧实例再读也必须看到新值（没有陈旧缓存）。
	const replacement = "sk-spec152-replacement-synthetic"
	if err := restarted.WriteApiKey(replacement); err != nil {
		t.Fatalf("替换密钥: %v", err)
	}
	if key, err := first.ReadApiKey(); err != nil || key != replacement {
		t.Fatalf("替换后旧实例读到 %q, %v", key, err)
	}

	// 清除：文件消失，重启后也读不到。
	if err := first.DeleteApiKey(); err != nil {
		t.Fatalf("清除密钥: %v", err)
	}
	if key, err := NewFollowing(roots).ReadApiKey(); err != nil || key != "" {
		t.Fatalf("清除后重启读密钥 = %q, %v", key, err)
	}
	if _, err := os.Stat(filepath.Join(root, keyFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("清除后保护文件还在：%v", err)
	}
}
