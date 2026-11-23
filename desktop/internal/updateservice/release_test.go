package updateservice

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

// digestOf 是包的 sha256：签名签的就是它，但哈希本身不是签名。
func digestOf(pkg []byte) []byte {
	sum := sha256.Sum256(pkg)
	return sum[:]
}

// base64Of 是 base64 编码：签名与公钥都是这个形状的文本。
func base64Of(raw []byte) string {
	return base64.StdEncoding.EncodeToString(raw)
}

// 版本比较与正式版本识别是选版的基础：预发布与 v 前缀都不算正式版本。
func TestFormalTagAcceptsOnlyPlainVersions(t *testing.T) {
	cases := []struct {
		tag  string
		want string
		ok   bool
	}{
		{"v1.5.0", "1.5.0", true},
		{"1.5.0", "1.5.0", true},
		{"v1.5.0-beta.1", "", false},
		{"v1.5", "", false},
		{"v1.5.0.1", "", false},
		{"nightly", "", false},
		{"v", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := formalTag(c.tag)
		if ok != c.ok || got != c.want {
			t.Fatalf("formalTag(%q) = (%q, %v), want (%q, %v)", c.tag, got, ok, c.want, c.ok)
		}
	}
}

// 比较按数字大小，不按字符串：1.10.0 比 1.9.0 新。
func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.5.0", "1.5.0", 0},
		{"1.6.0", "1.5.0", 1},
		{"1.5.0", "1.6.0", -1},
		{"1.10.0", "1.9.0", 1},
		{"2.0.0", "1.99.99", 1},
		{"1.5.10", "1.5.9", 1},
	}
	for _, c := range cases {
		got := compareVersions(c.a, c.b)
		if (got > 0) != (c.want > 0) || (got < 0) != (c.want < 0) {
			t.Fatalf("compareVersions(%q, %q) = %d, want sign of %d", c.a, c.b, got, c.want)
		}
	}
}

// 安装器文件名是发布资产名的约定（packaging/publish_release.py 也按这个名字产出）。
func TestInstallerNameMatchesReleaseAssets(t *testing.T) {
	if got := InstallerName("1.6.0"); got != "kacha-setup-1.6.0-amd64.exe" {
		t.Fatalf("InstallerName = %q", got)
	}
}

// 签名是发布者的 Ed25519 签名，不是文件哈希：哈希对得上但签名不对时必须拒绝。
func TestVerifyRejectsHashInPlaceOfSignature(t *testing.T) {
	pub := newPublisher(t)
	pkg := []byte("安装包内容")
	digest := digestOf(pkg)
	key, err := ParsePublicKey(pub.keyText())
	if err != nil {
		t.Fatalf("ParsePublicKey: %v", err)
	}
	// 拿哈希当签名：长度不对，必须拒绝。
	if err := Verify(key, digest, base64Of(digest)); err == nil {
		t.Fatalf("a bare digest must never pass as a signature")
	}
	// 真签名通过。
	if err := Verify(key, digest, pub.sign(pkg)); err != nil {
		t.Fatalf("a real publisher signature must pass: %v", err)
	}
}

// 公钥解析要拒绝形状不对的输入，而不是静默当成「没有签名」。
func TestParsePublicKeyRejectsBadInput(t *testing.T) {
	for _, text := range []string{"", "不是 base64", "AAAA"} {
		if _, err := ParsePublicKey(text); err == nil {
			t.Fatalf("ParsePublicKey(%q) must fail", text)
		}
	}
}
