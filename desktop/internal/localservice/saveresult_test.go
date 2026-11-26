package localservice

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 造一个带图层的结果，给「另存为」服务用。
func seedSaveRoot(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "2026-01-02", "t1")
	for _, d := range []string{filepath.Join(dir, "layers")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(p, text string) {
		t.Helper()
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(dir, "result.png"), "base")
	write(filepath.Join(dir, "layers.json"), "{\"layers\":[]}")
	write(filepath.Join(dir, "layers", "01.png"), "layer")
	return root, filepath.Join(dir, "result.png")
}

// zipEntries 把结果包读成「条目名 → 内容」：只有真的解包才能证明写进去的是什么。
func zipEntries(t *testing.T, path string) map[string]string {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("OpenReader(%s): %v", path, err)
	}
	defer zr.Close()
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		out[f.Name] = string(data)
	}
	return out
}

// 另存一张带图层的结果：用对话框选的目标，默认名来自 resultsave.SuggestedName，
// 包里实际有底图、layers.json 与图层。只 Stat 目标的话，零字节文件也能过。
func TestSaveResultUsesChosenTarget(t *testing.T) {
	root, src := seedSaveRoot(t)
	target := filepath.Join(t.TempDir(), "t1.zip")
	withSaveDialog(t, func(opts mygo.SaveDialogOptions) (string, error) {
		if opts.DefaultPath != "t1.zip" {
			t.Fatalf("默认名 = %s", opts.DefaultPath)
		}
		return target, nil
	})
	out, err := New(localstore.New(root)).SaveResult(src)
	if err != nil || !out.OK {
		t.Fatalf("SaveResult = %+v, %v", out, err)
	}
	entries := zipEntries(t, target)
	for name, want := range map[string]string{
		"result.png":    "base",
		"layers.json":   `{"layers":[]}`,
		"layers/01.png": "layer",
	} {
		if got, ok := entries[name]; !ok || got != want {
			t.Fatalf("结果包 %s = %q（存在 %v），want %q；entries = %+v", name, got, ok, want, entries)
		}
	}
}

// 取消对话框是中性结局：不是失败，也不落盘任何东西。
//
// 取消时对话框返回空串，服务在调 resultsave 之前就返回，所以断言落在 cancelled 类别上：
// 漏掉那段早返回会变成 failed。原来的 os.Stat(target) 永远不可能存在——那个 target
// 从没交给生产代码——抓不到任何回归，已删。
func TestSaveResultCancelIsNeutral(t *testing.T) {
	root, src := seedSaveRoot(t)
	withSaveDialog(t, func(mygo.SaveDialogOptions) (string, error) { return "", nil })
	out, err := New(localstore.New(root)).SaveResult(src)
	if err != nil || out.OK || out.Kind != "cancelled" || out.Message == "" {
		t.Fatalf("取消结局 = %+v, %v", out, err)
	}
}

func TestSaveResultMissingIsTyped(t *testing.T) {
	root, _ := seedSaveRoot(t)
	withSaveDialog(t, func(mygo.SaveDialogOptions) (string, error) { return filepath.Join(t.TempDir(), "x.png"), nil })
	out, err := New(localstore.New(root)).SaveResult(filepath.Join(root, "没有.png"))
	if err != nil || out.OK || out.Kind != "missing" {
		t.Fatalf("缺图结局 = %+v, %v", out, err)
	}
}

