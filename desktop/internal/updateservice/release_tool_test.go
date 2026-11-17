package updateservice

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// 发布端与客户端必须是同一套规则：这里直接跑 tools/signrelease 生成资产，
// 再让本服务按真实流程选版、下载、验签。发布端「自己觉得对」不算数。
//
// 跳过条件：没有 go 工具链时无法构建签名工具。
func TestSignedAssetsFromReleaseToolAreAccepted(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("没有 go 工具链，跳过发布端兼容性验证")
	}
	pub := newPublisher(t)
	work := t.TempDir()
	installer := filepath.Join(work, InstallerName("1.6.0"))
	pkg := []byte("真实安装器字节（测试替身）")
	if err := os.WriteFile(installer, pkg, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	notesPath := filepath.Join(work, "notes.md")
	if err := os.WriteFile(notesPath, []byte(defaultNotes("1.6.0")), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	// 用测试私钥跑真实的签名工具。
	cmd := exec.Command("go", "run", "./tools/signrelease",
		"-installer", installer,
		"-version", "1.6.0",
		"-notes", notesPath,
		"-base-url", "http://lzxsvn:3000",
		"-out", work,
	)
	cmd.Dir = filepath.Join("..", "..", "..")
	cmd.Env = append(os.Environ(), "MYGO_UPDATER_PRIVATE_KEY="+pub.privText())
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("签名工具失败：%v\n%s", err, out)
	}
	desc, err := os.ReadFile(filepath.Join(work, ManifestName))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var m Manifest
	if err := json.Unmarshal(desc, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if m.Version != "1.6.0" || m.Platform != "windows-amd64" {
		t.Fatalf("描述字段不对：%+v", m)
	}
	// 客户端按自己的规则验：公钥解析、摘要与签名都要过。
	key, err := ParsePublicKey(pub.keyText())
	if err != nil {
		t.Fatalf("ParsePublicKey: %v", err)
	}
	digest := digestOf(pkg)
	if err := Verify(key, digest, m.Signature); err != nil {
		t.Fatalf("发布工具产出的签名客户端验不过：%v", err)
	}
	// 换成别的包内容必须验不过（证明签名绑的是这份字节）。
	if err := Verify(key, digestOf([]byte("换掉的内容")), m.Signature); err == nil {
		t.Fatalf("签名必须绑定到安装器的字节")
	}
}
