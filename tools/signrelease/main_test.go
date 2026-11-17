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

// sha256Of 是被签名的那份摘要。
func sha256Of(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}

// 签名工具产出的资产必须能被客户端那边真正验过：
// 这里用与 desktop/internal/updateservice 相同的规则（Ed25519 签 sha256 摘要）核对，
// 避免「发布端自己觉得对」而客户端验不过。
func TestRunWritesVerifiableAssets(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	t.Setenv("MYGO_UPDATER_PRIVATE_KEY", base64.StdEncoding.EncodeToString(priv))
	dir := t.TempDir()
	installer := filepath.Join(dir, "kacha-setup-1.6.0-amd64.exe")
	if err := os.WriteFile(installer, []byte("安装器字节"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	notes := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(notes, []byte("# 1.6.0\n\n- 自动更新\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := run(installer, "1.6.0", notes, "http://lzxsvn:3000", dir); err != nil {
		t.Fatalf("run: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "update-windows-amd64.json"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var m descriptor
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if m.Version != "1.6.0" || m.Platform != "windows-amd64" {
		t.Fatalf("描述字段不对：%+v", m)
	}
	if m.URL != "http://lzxsvn:3000/qinyuanj/kacha/releases/download/v1.6.0/kacha-setup-1.6.0-amd64.exe" {
		t.Fatalf("包地址 = %q", m.URL)
	}
	// .sig 与描述里的签名必须是同一个，且能用公钥验过。
	sigText, err := os.ReadFile(filepath.Join(dir, "kacha-setup-1.6.0-amd64.exe.sig"))
	if err != nil {
		t.Fatalf("ReadFile sig: %v", err)
	}
	if string(sigText) != m.Signature+"\n" {
		t.Fatalf(".sig 与描述里的签名不一致")
	}
	sig, err := base64.StdEncoding.DecodeString(m.Signature)
	if err != nil {
		t.Fatalf("DecodeString: %v", err)
	}
	pkg, _ := os.ReadFile(installer)
	if !ed25519.Verify(pub, sha256Of(pkg), sig) {
		t.Fatalf("描述里的签名验不过")
	}
}

// 没有私钥时必须失败：不能产出「看起来能发」的资产。
func TestRunRefusesWithoutPrivateKey(t *testing.T) {
	t.Setenv("MYGO_UPDATER_PRIVATE_KEY", "")
	if err := run("x.exe", "1.6.0", "notes.md", "http://lzxsvn:3000", ""); err == nil {
		t.Fatalf("没有私钥时必须失败")
	}
}

// 说明里没有本版本标题：描述不完整，拒绝。
func TestRunRefusesNotesWithoutHeading(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	t.Setenv("MYGO_UPDATER_PRIVATE_KEY", base64.StdEncoding.EncodeToString(priv))
	dir := t.TempDir()
	installer := filepath.Join(dir, "kacha-setup-1.6.0-amd64.exe")
	_ = os.WriteFile(installer, []byte("x"), 0o644)
	notes := filepath.Join(dir, "notes.md")
	_ = os.WriteFile(notes, []byte("- 没有标题\n"), 0o644)
	if err := run(installer, "1.6.0", notes, "http://lzxsvn:3000", dir); err == nil {
		t.Fatalf("说明缺少标题时必须失败")
	}
}

// 预发布版本不能当正式更新发布。
func TestRunRefusesPrereleaseVersion(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	t.Setenv("MYGO_UPDATER_PRIVATE_KEY", base64.StdEncoding.EncodeToString(priv))
	if err := run("x.exe", "1.6.0-beta.1", "notes.md", "http://lzxsvn:3000", ""); err == nil {
		t.Fatalf("预发布版本必须被拒绝")
	}
}

// 安装器文件名必须与发布资产名一致：否则描述里的地址会指错。
func TestRunRefusesWrongInstallerName(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	t.Setenv("MYGO_UPDATER_PRIVATE_KEY", base64.StdEncoding.EncodeToString(priv))
	dir := t.TempDir()
	installer := filepath.Join(dir, "wrong-name.exe")
	_ = os.WriteFile(installer, []byte("x"), 0o644)
	notes := filepath.Join(dir, "notes.md")
	_ = os.WriteFile(notes, []byte("# 1.6.0\n"), 0o644)
	if err := run(installer, "1.6.0", notes, "http://lzxsvn:3000", dir); err == nil {
		t.Fatalf("安装器文件名不对时必须失败")
	}
}
