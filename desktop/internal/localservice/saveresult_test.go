package localservice

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 造一个带图层的结果和一块画板，给「另存为」服务用。
func seedSaveRoot(t *testing.T) (string, string, string) {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "2026-01-02", "t1")
	for _, d := range []string{filepath.Join(dir, "layers"), filepath.Join(root, localstore.BoardsDir)} {
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
	board := filepath.Join(root, localstore.BoardsDir, "板.ugcboard.json")
	write(board, "{\"format_version\":2,\"title\":\"板\",\"nodes\":[{\"type\":\"result\",\"path\":\"2026-01-02/t1/result.png\"}],\"edges\":[]}")
	return root, filepath.Join(dir, "result.png"), board
}

func TestSaveResultUsesChosenTarget(t *testing.T) {
	root, src, _ := seedSaveRoot(t)
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
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("目标文件读不出来：%v", err)
	}
}

func TestSaveResultCancelWritesNothing(t *testing.T) {
	root, src, _ := seedSaveRoot(t)
	target := filepath.Join(t.TempDir(), "t1.zip")
	withSaveDialog(t, func(mygo.SaveDialogOptions) (string, error) { return "", nil })
	out, err := New(localstore.New(root)).SaveResult(src)
	if err != nil || out.OK || out.Kind != "cancelled" {
		t.Fatalf("取消结局 = %+v, %v", out, err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("取消不该写目标：%v", err)
	}
}

func TestSaveResultMissingIsTyped(t *testing.T) {
	root, _, _ := seedSaveRoot(t)
	withSaveDialog(t, func(mygo.SaveDialogOptions) (string, error) { return filepath.Join(t.TempDir(), "x.png"), nil })
	out, err := New(localstore.New(root)).SaveResult(filepath.Join(root, "没有.png"))
	if err != nil || out.OK || out.Kind != "missing" {
		t.Fatalf("缺图结局 = %+v, %v", out, err)
	}
}

func TestSaveBoardResultsUsesChosenTarget(t *testing.T) {
	root, _, board := seedSaveRoot(t)
	target := filepath.Join(t.TempDir(), "板-结果.zip")
	withSaveDialog(t, func(mygo.SaveDialogOptions) (string, error) { return target, nil })
	out, err := New(localstore.New(root)).SaveBoardResults(board)
	if err != nil || !out.OK {
		t.Fatalf("SaveBoardResults = %+v, %v", out, err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("整板结果读不出来：%v", err)
	}
}
