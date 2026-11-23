package diagnostics

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 合成密钥：与前端夹具同一个占位值，真值由运行环境填入，不写死在仓库里。
const testSecret = "sk-spec152-synthetic-not-real"

func withDialog(t *testing.T, fn func(mygo.SaveDialogOptions) (string, error)) {
	t.Helper()
	old := saveDialog
	saveDialog = fn
	t.Cleanup(func() { saveDialog = old })
}

func newService(root string, secrets ...string) *Service {
	return New("1.5.0", root, func() []string { return secrets })
}

func readZip(t *testing.T, path string) (map[string]string, []string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读诊断包: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("诊断包不是有效 zip: %v", err)
	}
	entries := map[string]string{}
	names := []string{}
	for _, f := range zr.File {
		names = append(names, f.Name)
		r, err := f.Open()
		if err != nil {
			t.Fatalf("打开 %s: %v", f.Name, err)
		}
		var buf bytes.Buffer
		if _, err := buf.ReadFrom(r); err != nil {
			t.Fatalf("读 %s: %v", f.Name, err)
		}
		_ = r.Close()
		entries[f.Name] = buf.String()
	}
	return entries, names
}

// 允许清单决定采集项：只得到派生的版本 / 平台 / 运行状态 / 脱敏日志，
// 不打包凭据文件、设置原文、画板或创作内容；全部输出都不含合成密钥。
func TestExportUsesAllowlistAndRedactsSecrets(t *testing.T) {
	root := t.TempDir()
	// 盘上放一份密钥、一份带密钥的设置和一块有创作内容的画板：都不许进包。
	if err := os.WriteFile(filepath.Join(root, "api-key.protected"), []byte(testSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "settings.json"), []byte(`{"base_url":"http://gw","api_key":"`+testSecret+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	boards := filepath.Join(root, "画板")
	if err := os.MkdirAll(boards, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(boards, "a.json"), []byte("创作内容不应进诊断包"), 0o600); err != nil {
		t.Fatal(err)
	}

	svc := newService(root, testSecret)
	svc.Log("task", map[string]string{
		"model":         "test-model",
		"authorization": "Bearer " + testSecret,
		"note":        "gateway_key=gw-synthetic-secret {{SECRET_9p7w668j}}",
	})
	dest := filepath.Join(t.TempDir(), "diag.zip")
	withDialog(t, func(mygo.SaveDialogOptions) (string, error) { return dest, nil })

	out, err := svc.Export()
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if !out.OK {
		t.Fatalf("导出失败: %+v", out)
	}

	entries, names := readZip(t, dest)
	for _, want := range []string{"diagnostics.json", "logs.jsonl", "README.txt"} {
		if _, ok := entries[want]; !ok {
			t.Fatalf("诊断包缺少 %s，只有 %v", want, names)
		}
	}
	for _, name := range names {
		lower := strings.ToLower(name)
		if strings.Contains(lower, "api-key") || strings.Contains(lower, "settings") || strings.Contains(lower, "画板") {
			t.Fatalf("诊断包包含了不允许的文件名 %q", name)
		}
	}
	for name, body := range entries {
		if strings.Contains(body, testSecret) {
			t.Fatalf("%s 泄漏了合成密钥", name)
		}
		if strings.Contains(body, "创作内容不应进诊断包") {
			t.Fatalf("%s 泄漏了创作内容", name)
		}
	}

	var facts struct {
		Version  string `json:"version"`
		Platform struct {
			OS   string `json:"os"`
			Arch string `json:"arch"`
		} `json:"platform"`
		Runtime struct {
			CredentialPresent bool `json:"credential_present"`
			BoardCount        int  `json:"board_count"`
		} `json:"runtime"`
	}
	if err := json.Unmarshal([]byte(entries["diagnostics.json"]), &facts); err != nil {
		t.Fatalf("解析 diagnostics.json: %v\n%s", err, entries["diagnostics.json"])
	}
	if facts.Version != "1.5.0" {
		t.Fatalf("version = %q, want 1.5.0", facts.Version)
	}
	if facts.Platform.OS == "" || facts.Platform.Arch == "" {
		t.Fatalf("平台信息缺失: %+v", facts.Platform)
	}
	if !facts.Runtime.CredentialPresent {
		t.Fatal("运行状态应报告凭据存在（布尔），而不是值")
	}
	if facts.Runtime.BoardCount != 1 {
		t.Fatalf("画板计数 = %d, want 1", facts.Runtime.BoardCount)
	}
	if !strings.Contains(entries["logs.jsonl"], "[REDACTED]") {
		t.Fatalf("日志没有脱敏标记: %s", entries["logs.jsonl"])
	}
}

// 已保存 → 已替换 → 已清除：三种状态下的日志与包内全部内容都不能出现任一密钥。
func TestBundleExcludesSecretsCredentialsHostnameAndPaths(t *testing.T) {
	root := t.TempDir()
	boards := filepath.Join(root, localstore.BoardsDir)
	if err := os.MkdirAll(boards, 0o755); err != nil {
		t.Fatal(err)
	}
	host, err := os.Hostname()
	if err != nil || host == "" {
		t.Fatalf("hostname: %v", err)
	}
	svc := newService(root, testSecret)
	svc.Log("connection", map[string]string{
		"authorization": "Bearer " + testSecret,
		"api_key":       testSecret,
		"note":        "gateway_key=gw-synthetic-secret {{SECRET_9p7w668j}}",
	})

	out := svc.Bundle()
	if !out.OK || out.Kind != "saved" || len(out.Data) == 0 {
		t.Fatalf("Bundle outcome = %+v", out)
	}
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "bundle.zip")
	if err := os.WriteFile(zipPath, out.Data, 0o600); err != nil {
		t.Fatal(err)
	}
	entries, _ := readZip(t, zipPath)
	for name, body := range entries {
		for _, secret := range []string{testSecret, host, "C:/Users/me", `\\lzxsvn\share`} {
			if strings.Contains(body, secret) {
				t.Fatalf("%s leaked %q: %s", name, secret, body)
			}
		}
	}
}

func TestBundleRedactsGatewayAndCommonSecretPatterns(t *testing.T) {
	root := t.TempDir()
	boards := filepath.Join(root, localstore.BoardsDir)
	if err := os.MkdirAll(boards, 0o755); err != nil {
		t.Fatal(err)
	}
	svc := newService(root)
	svc.Log("gateway", map[string]string{
		"gateway_key": "gw-synthetic-secret",
		"note":        "gateway_key=gw-synthetic-secret sk-synthetic5678",
	})

	out := svc.Bundle()
	if !out.OK || out.Kind != "saved" || len(out.Data) == 0 {
		t.Fatalf("Bundle outcome = %+v", out)
	}
	zipPath := filepath.Join(t.TempDir(), "bundle.zip")
	if err := os.WriteFile(zipPath, out.Data, 0o600); err != nil {
		t.Fatal(err)
	}
	entries, _ := readZip(t, zipPath)
	foundRedaction := false
	for name, body := range entries {
		for _, secret := range []string{"gw-synthetic-secret", "sk-synthetic5678"} {
			if strings.Contains(body, secret) {
				t.Fatalf("%s leaked %q: %s", name, secret, body)
			}
		}
		if strings.Contains(body, "[REDACTED]") {
			foundRedaction = true
		}
	}
	if !foundRedaction {
		t.Fatal("diagnostics bundle has no redaction marker")
	}
}

func TestExportRedactsSavedReplacedAndClearedKeys(t *testing.T) {
	root := t.TempDir()
	saved := testSecret
	replaced := "sk-replaced-" + testSecret
	svc := newService(root, saved)
	svc.Log("connection", map[string]string{"stage": "saved", "detail": "key=" + saved})
	svc = newService(root, replaced) // 替换密钥；服务只读当前值，不缓存旧明文。
	svc.Log("connection", map[string]string{"stage": "replaced", "detail": "key=" + replaced})
	svc = newService(root) // 清除密钥。
	svc.Log("connection", map[string]string{"stage": "cleared", "detail": "done"})

	dest := filepath.Join(t.TempDir(), "diag.zip")
	withDialog(t, func(mygo.SaveDialogOptions) (string, error) { return dest, nil })
	out, err := svc.Export()
	if err != nil || !out.OK {
		t.Fatalf("Export: %v %+v", err, out)
	}
	entries, _ := readZip(t, dest)
	for name, body := range entries {
		for _, secret := range []string{saved, replaced} {
			if strings.Contains(body, secret) {
				t.Fatalf("%s 泄漏了密钥（保存/替换/清除之一）", name)
			}
		}
	}
}

// 用户取消：明确结局，一个字节都不写，也不留下半成品。
func TestExportCancelWritesNothing(t *testing.T) {
	root := t.TempDir()
	dest := filepath.Join(t.TempDir(), "diag.zip")
	withDialog(t, func(mygo.SaveDialogOptions) (string, error) { return "", nil })
	svc := newService(root)
	out, err := svc.Export()
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if out.OK || out.Kind != "cancelled" {
		t.Fatalf("结局 = %+v, want cancelled", out)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatalf("取消后不该写文件: %v", err)
	}
}

// 目标不可写：明确失败结局，原始创作数据不受影响。
func TestExportUnwritableTargetReportsFailure(t *testing.T) {
	root := t.TempDir()
	board := filepath.Join(root, "画板", "a.json")
	if err := os.MkdirAll(filepath.Dir(board), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(board, []byte("原始内容"), 0o600); err != nil {
		t.Fatal(err)
	}
	// 目标是已经存在的目录：跨平台都不可写，不依赖 Windows 的只读目录语义。
	dest := filepath.Join(root, "目标目录")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	withDialog(t, func(mygo.SaveDialogOptions) (string, error) { return dest, nil })
	out, err := newService(root).Export()
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if out.OK || out.Kind != "failed" || out.Message == "" {
		t.Fatalf("结局 = %+v, want failed with message", out)
	}
	body, err := os.ReadFile(board)
	if err != nil || string(body) != "原始内容" {
		t.Fatalf("原始画板被改动: %q %v", body, err)
	}
}

// 容量有界：超长字段被截断，日志条数有上限，丢弃数写进诊断事实。
func TestLogIsBounded(t *testing.T) {
	root := t.TempDir()
	svc := newService(root)
	long := strings.Repeat("x", 9000)
	svc.Log("task", map[string]string{"huge": long})
	for i := 0; i < maxLogEntries+9; i++ {
		svc.Log("task", map[string]string{"n": "1"})
	}
	dest := filepath.Join(t.TempDir(), "diag.zip")
	withDialog(t, func(mygo.SaveDialogOptions) (string, error) { return dest, nil })
	if out, err := svc.Export(); err != nil || !out.OK {
		t.Fatalf("Export: %v %+v", err, out)
	}
	entries, _ := readZip(t, dest)
	lines := strings.Split(strings.TrimSpace(entries["logs.jsonl"]), "\n")
	if len(lines) != maxLogEntries {
		t.Fatalf("日志条数 = %d, want %d", len(lines), maxLogEntries)
	}
	if strings.Contains(entries["logs.jsonl"], long) {
		t.Fatal("超长字段没有被截断")
	}
	if !strings.Contains(entries["diagnostics.json"], `"dropped_logs": 10`) {
		t.Fatalf("丢弃数没有写进事实: %s", entries["diagnostics.json"])
	}
}

// #229：导出读 dropped_logs 与日志记录必须共用同一把锁。
// 先填满缓冲，之后每收一条都会丢最旧一条并累加丢弃数；导出一边打包一边读它，
// 没有锁时这条路径在 -race 下会报数据竞争。
func TestExportConcurrentWithLoggingIsRaceFree(t *testing.T) {
	root := t.TempDir()
	svc := newService(root)
	for i := 0; i < maxLogEntries; i++ {
		svc.Log("task", map[string]string{"n": strconv.Itoa(i)})
	}
	dest := filepath.Join(t.TempDir(), "diag.zip")
	withDialog(t, func(mygo.SaveDialogOptions) (string, error) { return dest, nil })

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 4*maxLogEntries; i++ {
			svc.Log("task", map[string]string{"n": strconv.Itoa(i)})
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 20; i++ {
			if out, err := svc.Export(); err != nil || !out.OK {
				t.Errorf("并发导出失败: %v %+v", err, out)
				return
			}
		}
	}()
	wg.Wait()

	entries, _ := readZip(t, dest)
	if !strings.Contains(entries["diagnostics.json"], `"dropped_logs":`) {
		t.Fatalf("诊断事实缺少丢弃数: %s", entries["diagnostics.json"])
	}
}

// 采集失败（数据根不可用）：明确报失败，不拿空包冒充排障信息。
func TestExportReportsCollectionFailure(t *testing.T) {
	root := filepath.Join(t.TempDir(), "不存在的数据根")
	dest := filepath.Join(t.TempDir(), "diag.zip")
	withDialog(t, func(mygo.SaveDialogOptions) (string, error) { return dest, nil })
	out, err := newService(root).Export()
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if out.OK || out.Kind != "failed" || !strings.Contains(out.Message, "采集") {
		t.Fatalf("结局 = %+v, want failed with 采集 message", out)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatalf("采集失败后不该留下诊断包: %v", err)
	}
}

// 密钥被替换或清除之前写进缓冲的日志不能留在包里：
// 服务只认当前密钥，旧值已经读不到了，但它必须因为「密钥变了」而清掉可能含旧值的缓冲。
func TestExportDropsBufferedLogsWhenSecretChanges(t *testing.T) {
	root := t.TempDir()
	saved := testSecret
	replaced := "sk-replaced-" + testSecret
	current := saved
	svc := newService(root, saved)
	svc.secrets = func() []string { return []string{current} }

	svc.Log("connection", map[string]string{"stage": "saved", "detail": "旧密钥 " + saved})
	current = replaced // 用户替换了密钥。
	svc.Log("connection", map[string]string{"stage": "replaced", "detail": "新密钥 " + replaced})
	current = "" // 用户清除了密钥。
	svc.Log("connection", map[string]string{"stage": "cleared", "detail": "没有密钥了"})

	dest := filepath.Join(t.TempDir(), "diag.zip")
	withDialog(t, func(mygo.SaveDialogOptions) (string, error) { return dest, nil })
	out, err := svc.Export()
	if err != nil || !out.OK {
		t.Fatalf("Export: %v %+v", err, out)
	}
	entries, _ := readZip(t, dest)
	for name, body := range entries {
		for _, secret := range []string{saved, replaced} {
			if strings.Contains(body, secret) {
				t.Fatalf("%s 泄漏了密钥（保存/替换/清除之一）", name)
			}
		}
	}
}

// 密钥被替换之后，提到「旧密钥」的日志仍不许带明文：
// 服务只读得到当前密钥，旧值已经读不到了，但它记得自己见过哪些密钥值。
func TestExportRedactsPreviouslySeenSecretAfterReplacement(t *testing.T) {
	root := t.TempDir()
	saved := testSecret
	replaced := "sk-replaced-" + saved
	current := saved
	svc := newService(root, saved)
	svc.secrets = func() []string { return []string{current} }

	svc.Log("connection", map[string]string{"stage": "saved", "detail": "保存的密钥 " + saved})
	current = replaced // 用户替换了密钥：旧值不再能从盘上读到。
	svc.Log("task", map[string]string{"stage": "replaced", "detail": "任务记录里还留着旧密钥 " + saved})

	dest := filepath.Join(t.TempDir(), "diag.zip")
	withDialog(t, func(mygo.SaveDialogOptions) (string, error) { return dest, nil })
	out, err := svc.Export()
	if err != nil || !out.OK {
		t.Fatalf("Export: %v %+v", err, out)
	}
	entries, _ := readZip(t, dest)
	for name, body := range entries {
		if strings.Contains(body, saved) {
			t.Fatalf("%s 泄漏了已被替换的旧密钥", name)
		}
	}
}

// 重启后仍能排障：脱敏日志落盘在数据根里（有界），导出把落盘的那份一起带走。
// 否则用户重启后再导出，拿到的只是空日志，不能用来定位问题。
func TestLogsPersistAcrossRestartAndStayBounded(t *testing.T) {
	root := t.TempDir()
	svc := newService(root)
	svc.Log("task", map[string]string{"stage": "排队", "model": "test-model"})

	// 重启：换一个服务实例，读同一份数据根。
	restarted := newService(root)
	dest := filepath.Join(t.TempDir(), "diag.zip")
	withDialog(t, func(mygo.SaveDialogOptions) (string, error) { return dest, nil })
	out, err := restarted.Export()
	if err != nil || !out.OK {
		t.Fatalf("Export: %v %+v", err, out)
	}
	entries, _ := readZip(t, dest)
	if !strings.Contains(entries["logs.jsonl"], "test-model") {
		t.Fatalf("重启后诊断包里的日志是空的：%s", entries["logs.jsonl"])
	}

	// 落盘的日志有界：写很多条之后文件不再无限增长。
	for i := 0; i < maxLogEntries*3; i++ {
		restarted.Log("task", map[string]string{"n": "1"})
	}
	info, err := os.Stat(filepath.Join(root, logFileName))
	if err != nil {
		t.Fatalf("读落盘日志: %v", err)
	}
	if info.Size() > int64(maxLogFileBytes) {
		t.Fatalf("落盘日志 %d 字节，超过上限 %d", info.Size(), maxLogFileBytes)
	}
}

// 同一条日志只出现一次：落盘的那份与内存里的那份不是同一条记录的两份副本。
func TestExportDoesNotDuplicateLogEntries(t *testing.T) {
	root := t.TempDir()
	svc := newService(root)
	svc.Log("task", map[string]string{"stage": "排队", "model": "test-model"})

	dest := filepath.Join(t.TempDir(), "diag.zip")
	withDialog(t, func(mygo.SaveDialogOptions) (string, error) { return dest, nil })
	out, err := svc.Export()
	if err != nil || !out.OK {
		t.Fatalf("Export: %v %+v", err, out)
	}
	entries, _ := readZip(t, dest)
	lines := strings.Split(strings.TrimSpace(entries["logs.jsonl"]), "\n")
	if len(lines) != 1 {
		t.Fatalf("日志条数 = %d, want 1（同一条不该出现两次）：\n%s", len(lines), entries["logs.jsonl"])
	}
}
