package diagnostics

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/gateway"
)

// 端到端脱敏证据：用真实的 Windows 系统保护密钥存储（DPAPI）走「已保存 → 已替换 → 已清除」，
// 每一步都导出一次诊断包并解开逐个文件检查：明文密钥、鉴权头与文件名里都不许出现它。
//
// 这个用例不替身密钥存储，也不替身对话框：只有解压后的实际内容能作为证据。
func TestExportWithRealProtectedCredentialNeverLeaksIt(t *testing.T) {
	root := t.TempDir()
	credPath := filepath.Join(root, "api-key.protected")
	cred := gateway.New(credPath)

	saved := "sk-spec152-synthetic-not-real"
	replaced := "sk-replaced-" + saved

	stages := []struct {
		name   string
		secret string
		apply  func() error
	}{
		{name: "已保存", secret: saved, apply: func() error { return cred.WriteApiKey(saved) }},
		{name: "已替换", secret: replaced, apply: func() error { return cred.WriteApiKey(replaced) }},
		{name: "已清除", secret: "", apply: func() error { return cred.DeleteApiKey() }},
	}

	for _, stage := range stages {
		if err := stage.apply(); err != nil {
			t.Fatalf("%s：写入密钥状态失败: %v", stage.name, err)
		}
		// 服务每次都重新读当前密钥，不缓存旧明文：替换后旧值不该再被需要，但出现过也必须被遮掉。
		svc := New("1.5.0", root, func() []string {
			key, err := cred.ReadApiKey()
			if err != nil || key == "" {
				return nil
			}
			return []string{key}
		})
		svc.Log("connection", map[string]string{
			"stage":         stage.name,
			"authorization": "Bearer " + stage.secret,
			"detail":        "网关响应里带回了 " + stage.secret,
			"model":         "test-model",
		})

		dest := filepath.Join(t.TempDir(), "diag.zip")
		withDialog(t, func(mygo.SaveDialogOptions) (string, error) { return dest, nil })
		out, err := svc.Export()
		if err != nil || !out.OK {
			t.Fatalf("%s：Export: %v %+v", stage.name, err, out)
		}

		data, err := os.ReadFile(dest)
		if err != nil {
			t.Fatalf("%s：读诊断包: %v", stage.name, err)
		}
		// 包本身（压缩字节）也不许含明文：zip 头与条目名是可见的。
		for _, secret := range []string{saved, replaced} {
			if secret != "" && bytes.Contains(data, []byte(secret)) {
				t.Fatalf("%s：诊断包原始字节里出现明文密钥", stage.name)
			}
		}
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			t.Fatalf("%s：诊断包不是有效 zip: %v", stage.name, err)
		}
		for _, f := range zr.File {
			if strings.Contains(f.Name, saved) || strings.Contains(f.Name, replaced) {
				t.Fatalf("%s：包内文件名 %q 泄漏密钥", stage.name, f.Name)
			}
			r, err := f.Open()
			if err != nil {
				t.Fatalf("%s：打开 %s: %v", stage.name, f.Name, err)
			}
			var buf bytes.Buffer
			if _, err := buf.ReadFrom(r); err != nil {
				t.Fatalf("%s：读 %s: %v", stage.name, f.Name, err)
			}
			_ = r.Close()
			body := buf.String()
			for _, secret := range []string{saved, replaced} {
				if secret != "" && strings.Contains(body, secret) {
					t.Fatalf("%s：%s 泄漏了明文密钥", stage.name, f.Name)
				}
			}
			// 凭据只报存在与否，不报值。
			if stage.name == "已保存" && f.Name == "diagnostics.json" && !strings.Contains(body, `"credential_present": true`) {
				t.Fatalf("%s：运行状态没有报告凭据存在: %s", stage.name, body)
			}
			if stage.name == "已清除" && f.Name == "diagnostics.json" && !strings.Contains(body, `"credential_present": false`) {
				t.Fatalf("%s：清除后仍报告凭据存在: %s", stage.name, body)
			}
		}
	}
}

// 落盘的脱敏日志文件本身也不许含明文密钥：它在数据根里，用户可能直接把它发出去。
func TestPersistedLogFileNeverContainsPlainKey(t *testing.T) {
	root := t.TempDir()
	credPath := filepath.Join(root, "api-key.protected")
	cred := gateway.New(credPath)
	saved := "sk-spec152-synthetic-not-real"
	if err := cred.WriteApiKey(saved); err != nil {
		t.Fatalf("保存密钥: %v", err)
	}
	svc := New("1.5.0", root, func() []string {
		key, err := cred.ReadApiKey()
		if err != nil || key == "" {
			return nil
		}
		return []string{key}
	})
	svc.Log("connection", map[string]string{
		"authorization": "Bearer " + saved,
		"detail":        "网关原文带回了 " + saved,
	})
	data, err := os.ReadFile(filepath.Join(root, logFileName))
	if err != nil {
		t.Fatalf("读落盘日志: %v", err)
	}
	if strings.Contains(string(data), saved) {
		t.Fatalf("落盘日志里出现明文密钥: %s", data)
	}
	if !strings.Contains(string(data), redacted) {
		t.Fatalf("落盘日志里没有脱敏标记: %s", data)
	}
}
