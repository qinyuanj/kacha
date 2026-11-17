package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// writeDescriptor 写一份只带签名的更新描述。
func writeDescriptor(t *testing.T, path, signature string) {
	t.Helper()
	data, err := json.MarshalIndent(descriptor{Signature: signature}, "", "  ")
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

// 真签名通过；换安装器字节、改签名、没有内置公钥都必须失败。
func TestVerifyWithKey(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	dir := t.TempDir()
	pkg := []byte("安装器字节")
	installer := filepath.Join(dir, "kacha-setup-1.6.0-amd64.exe")
	if err := os.WriteFile(installer, pkg, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	sum := sha256.Sum256(pkg)
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, sum[:]))
	descriptorPath := filepath.Join(dir, "update-windows-amd64.json")
	writeDescriptor(t, descriptorPath, sig)
	keyText := base64.StdEncoding.EncodeToString(pub)

	if err := verifyWithKey(keyText, installer, descriptorPath); err != nil {
		t.Fatalf("真签名必须验过：%v", err)
	}

	other := filepath.Join(dir, "other.exe")
	if err := os.WriteFile(other, []byte("换掉的字节"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := verifyWithKey(keyText, other, descriptorPath); err == nil {
		t.Fatalf("签名必须绑在这份安装器的字节上")
	}

	tampered := filepath.Join(dir, "tampered.json")
	writeDescriptor(t, tampered, base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize)))
	if err := verifyWithKey(keyText, installer, tampered); err == nil {
		t.Fatalf("改过的签名必须验不过")
	}

	// 这次构建没有内置公钥：拒绝，而不是退化成「不验了」。
	if err := verifyWithKey("", installer, descriptorPath); err == nil {
		t.Fatalf("没有内置公钥时必须拒绝")
	}

	// 描述或安装器不存在。
	if err := verifyWithKey(keyText, installer, filepath.Join(dir, "missing.json")); err == nil {
		t.Fatalf("描述不存在时必须失败")
	}
	if err := verifyWithKey(keyText, filepath.Join(dir, "missing.exe"), descriptorPath); err == nil {
		t.Fatalf("安装器不存在时必须失败")
	}
}
