package localservice

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// withPickImagesDialog 换掉系统选图对话框：不弹窗，按测试给的结果返回。
func withPickImagesDialog(t *testing.T, fn func(opts mygo.OpenDialogOptions) ([]string, error)) {
	t.Helper()
	prev := pickImagesDialog
	pickImagesDialog = fn
	t.Cleanup(func() { pickImagesDialog = prev })
}

// seedPickedImages 在本机目录（数据根之外）造两张图：用户选中的本机图片不在数据根里。
func seedPickedImages(t *testing.T) ([]string, []byte, []byte) {
	t.Helper()
	dir := t.TempDir()
	first := []byte("\x89PNG\r\n\x1a\none")
	second := []byte("\x89PNG\r\n\x1a\ntwo")
	a := filepath.Join(dir, "橘猫.png")
	b := filepath.Join(dir, "截图 2.png")
	if err := os.WriteFile(a, first, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(b, second, 0o644); err != nil {
		t.Fatal(err)
	}
	return []string{a, b}, first, second
}

func TestPickImagesReturnsBytesBase64(t *testing.T) {
	paths, first, second := seedPickedImages(t)
	root := t.TempDir()
	var pickedMultiple bool
	withPickImagesDialog(t, func(opts mygo.OpenDialogOptions) ([]string, error) {
		pickedMultiple = opts.Multiple
		if len(opts.Filters) == 0 || len(opts.Filters[0].Extensions) == 0 {
			t.Fatalf("选图对话框没有图片后缀过滤：%+v", opts.Filters)
		}
		if !strings.Contains(strings.Join(opts.Filters[0].Extensions, ","), "png") {
			t.Fatalf("选图对话框没有 png 后缀：%+v", opts.Filters)
		}
		return paths, nil
	})
	picked, err := New(localstore.New(root)).PickImages(true)
	if err != nil {
		t.Fatalf("PickImages: %v", err)
	}
	if !pickedMultiple {
		t.Fatal("多选请求没有传给选图对话框")
	}
	if len(picked) != 2 {
		t.Fatalf("选中张数 = %d，期望 2", len(picked))
	}
	if picked[0].Name != "橘猫.png" || picked[1].Name != "截图 2.png" {
		t.Fatalf("文件名 = %q / %q", picked[0].Name, picked[1].Name)
	}
	// 字节走 base64：页面按 base64 还原成 File，原图字节保持不变。
	gotFirst, err := base64.StdEncoding.DecodeString(picked[0].Data)
	if err != nil {
		t.Fatalf("第一张不是合法 base64：%v", err)
	}
	if string(gotFirst) != string(first) {
		t.Fatalf("第一张字节 = %q，期望 %q", gotFirst, first)
	}
	gotSecond, err := base64.StdEncoding.DecodeString(picked[1].Data)
	if err != nil || string(gotSecond) != string(second) {
		t.Fatalf("第二张字节读错：%v / %q", err, gotSecond)
	}
	// 本机选图只读不写：原文件一个字节都不动。
	same, err := os.ReadFile(paths[0])
	if err != nil || string(same) != string(first) {
		t.Fatalf("选图改动了原文件：%v / %q", err, same)
	}
}

func TestPickImagesCancelReturnsEmpty(t *testing.T) {
	withPickImagesDialog(t, func(mygo.OpenDialogOptions) ([]string, error) { return nil, nil })
	picked, err := New(localstore.New(t.TempDir())).PickImages(true)
	if err != nil {
		t.Fatalf("取消不该是错误：%v", err)
	}
	if len(picked) != 0 {
		t.Fatalf("取消返回了 %d 张", len(picked))
	}
}

func TestPickImagesReadFailureIsError(t *testing.T) {
	// 有一张读不出来就整批失败：不能静默少给一张参考图。
	withPickImagesDialog(t, func(mygo.OpenDialogOptions) ([]string, error) {
		return []string{filepath.Join(t.TempDir(), "不存在.png")}, nil
	})
	_, err := New(localstore.New(t.TempDir())).PickImages(false)
	if err == nil || !strings.Contains(err.Error(), "读取选中的图片失败") {
		t.Fatalf("读失败没报错：%v", err)
	}
}

func TestPickImagesDialogErrorPropagates(t *testing.T) {
	boom := errors.New("对话框没起来")
	withPickImagesDialog(t, func(mygo.OpenDialogOptions) ([]string, error) { return nil, boom })
	if _, err := New(localstore.New(t.TempDir())).PickImages(false); !errors.Is(err, boom) {
		t.Fatalf("对话框失败没传出来：%v", err)
	}
}
