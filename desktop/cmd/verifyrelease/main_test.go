package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

// 内置公钥为空：拒绝，并且文案要给出下一步——把私钥推导出的公钥写进内置公钥文件。
// 只说「对不上」不算指引：发布负责人在构建前需要知道该写哪个值、哪个文件。
func TestCheckPrivateKeyRefusesWithoutBuiltinKey(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	publicText, err := checkPrivateKey(base64.StdEncoding.EncodeToString(priv), "")
	if err == nil {
		t.Fatalf("内置公钥为空时必须拒绝：否则构建出的客户端没有可信发布者")
	}
	if want := base64.StdEncoding.EncodeToString(pub); publicText != want {
		t.Fatalf("推导出的公钥 = %q，期望 %q", publicText, want)
	}
	if !strings.Contains(err.Error(), publicText) || !strings.Contains(err.Error(), "publisher_key.txt") {
		t.Fatalf("失败文案要给出该写入的公钥与文件：%v", err)
	}
}

// 私钥与内置公钥不是一对：拒绝，并同时给出两边公钥，让人能判断该换哪一边。
// 这条错配原本要到发布阶段才被 verifyrelease 发现，那时整次构建已经白跑。
func TestCheckPrivateKeyRefusesMismatch(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	otherPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	publicText, err := checkPrivateKey(base64.StdEncoding.EncodeToString(priv), base64.StdEncoding.EncodeToString(otherPub))
	if err == nil {
		t.Fatalf("私钥与内置公钥不是一对时必须拒绝")
	}
	if want := base64.StdEncoding.EncodeToString(pub); publicText != want {
		t.Fatalf("推导出的公钥 = %q，期望 %q", publicText, want)
	}
	if strings.Contains(err.Error(), base64.StdEncoding.EncodeToString(priv)) {
		t.Fatalf("失败文案泄漏了私钥")
	}
	for _, want := range []string{publicText, base64.StdEncoding.EncodeToString(otherPub), "publisher_key.txt"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("失败文案缺 %q：%v", want, err)
		}
	}
}

// 配对成功：通过并回显配对的公钥，构建可以开始。
func TestCheckPrivateKeyAcceptsMatchingPair(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	publicText, err := checkPrivateKey(base64.StdEncoding.EncodeToString(priv), base64.StdEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatalf("配对的私钥与公钥必须通过：%v", err)
	}
	if want := base64.StdEncoding.EncodeToString(pub); publicText != want {
		t.Fatalf("公钥 = %q，期望 %q", publicText, want)
	}
}

// 没有私钥：拒绝，并指出私钥只从环境变量来、不要写进仓库或命令行。
func TestCheckPrivateKeyRefusesUnsetPrivateKey(t *testing.T) {
	t.Setenv("MYGO_UPDATER_PRIVATE_KEY", "")
	builtin := base64.StdEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))
	if _, err := checkPrivateKey(os.Getenv("MYGO_UPDATER_PRIVATE_KEY"), builtin); err == nil {
		t.Fatalf("没有私钥时必须拒绝")
	} else if !strings.Contains(err.Error(), "MYGO_UPDATER_PRIVATE_KEY") {
		t.Fatalf("失败文案要指向环境变量：%v", err)
	}
}
