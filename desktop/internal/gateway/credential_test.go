package gateway

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// 合成秘密只用于测试；真实密钥不进仓库、日志或诊断。
const syntheticKey = "sk-spec152-synthetic-not-real"

// 密钥默认持久化、受 Windows 系统保护：重启（重新构造服务）后仍可读，
// 数据根里的文件不出现明文，替换与清除都落到同一个文件身份上。
func TestApiKeyPersistenceAndProtection(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "api-key.protected")

	first := New(path)
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
	restarted := New(path)
	key, err := restarted.ReadApiKey()
	if err != nil || key != syntheticKey {
		t.Fatalf("重启后读密钥 = %q, %v；应为 %q", key, err, syntheticKey)
	}
	stored, err := os.ReadFile(path)
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
	if key, err := New(path).ReadApiKey(); err != nil || key != "" {
		t.Fatalf("清除后重启读密钥 = %q, %v", key, err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("清除后保护文件还在：%v", err)
	}
}

// 数据根不随凭据变化：密钥文件与设置文件各写各的，替换 / 清除密钥不动设置。
func TestApiKeyDoesNotChangeDataRoot(t *testing.T) {
	root := t.TempDir()
	settingsPath := filepath.Join(root, "settings.json")
	if err := os.WriteFile(settingsPath, []byte("{\"base_url\":\"http://gw:3001\"}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc := New(filepath.Join(root, "api-key.protected"))
	if err := svc.WriteApiKey(syntheticKey); err != nil {
		if errors.Is(err, ErrUnsupported) {
			t.Skip("当前平台没有 Windows 系统保护")
		}
		t.Fatal(err)
	}
	if err := svc.DeleteApiKey(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte("http://gw:3001")) || bytes.Contains(data, []byte(syntheticKey)) {
		t.Fatalf("密钥操作改变了设置文件或泄露了密钥：%s", data)
	}
}
