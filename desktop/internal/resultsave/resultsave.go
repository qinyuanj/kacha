// Package resultsave 把单张生成结果保存到用户选的本机位置：带图层时打 zip。
package resultsave

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/qinyuanj/kacha/desktop/internal/pathguard"
)

// 失败类别：界面按类别分支。
const (
	KindMissing   = "missing"
	KindForbidden = "forbidden"
	KindFailed    = "failed"
)

// Error 是一次保存失败的结局。
type Error struct {
	Kind    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func missingf(format string, args ...any) *Error {
	return &Error{Kind: KindMissing, Message: fmt.Sprintf(format, args...)}
}

func failedf(format string, args ...any) *Error {
	return &Error{Kind: KindFailed, Message: fmt.Sprintf(format, args...)}
}

// zipItem 是包内一个条目，指向数据根里的一个文件。
type zipItem struct {
	name string
	path string
}

// SaveResult 保存一张结果：有图层时写底图 + layers.json + layers/* 的 zip，否则原样复制字节。
func SaveResult(root, src, target string) *Error {
	if !pathguard.Inside(root, src) {
		return &Error{Kind: KindForbidden, Message: "结果不在数据根内，不能另存"}
	}
	info, err := os.Lstat(src)
	if err != nil || info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return missingf("结果图片读不出来：%s", filepath.Base(src))
	}
	layers, failure := layerItems(src)
	if failure != nil {
		return failure
	}
	if len(layers) == 0 {
		return copyTo(src, target)
	}
	items := append([]zipItem{{name: filepath.Base(src), path: src}}, layers...)
	return writeZip(target, items)
}

// SuggestedName 给系统「另存为」对话框一个默认名：带图层的结果用任务编号加 .zip。
func SuggestedName(root, src string) string {
	if pathguard.Inside(root, src) {
		if layers, failure := layerItems(src); failure == nil && len(layers) > 0 {
			return filepath.Base(filepath.Dir(src)) + ".zip"
		}
	}
	return filepath.Base(src)
}

// layerItems 读一个结果旁边的 layers.json 与 layers/ 下的图层（不含隐藏项）。
func layerItems(result string) ([]zipItem, *Error) {
	if strings.TrimSuffix(filepath.Base(result), filepath.Ext(result)) != "result" {
		return nil, nil
	}
	dir := filepath.Dir(result)
	items := []zipItem{}
	jsonPath := filepath.Join(dir, "layers.json")
	if info, err := os.Lstat(jsonPath); err == nil && info.Mode().IsRegular() {
		items = append(items, zipItem{name: "layers.json", path: jsonPath})
	}
	layerDir := filepath.Join(dir, "layers")
	entries, err := os.ReadDir(layerDir)
	if err != nil {
		return items, nil
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		items = append(items, zipItem{name: "layers/" + entry.Name(), path: filepath.Join(layerDir, entry.Name())})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].name < items[j].name })
	return items, nil
}

// copyTo 原样复制一张普通结果，先写临时文件再改名；目标已存在不覆盖。
func copyTo(src, target string) *Error {
	in, err := os.Open(src)
	if err != nil {
		return missingf("结果图片读不出来：%v", err)
	}
	defer in.Close()
	temp, failure := tempOf(target)
	if failure != nil {
		return failure
	}
	done := false
	defer finishTemp(temp, &done)
	out, err := os.OpenFile(temp, os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return failedf("写不了目标文件：%v", err)
	}
	_, err = io.Copy(out, in)
	closeErr := out.Close()
	if err != nil || closeErr != nil {
		return failedf("写目标文件失败：%v", err)
	}
	if err := commit(temp, target, &done); err != nil {
		return err
	}
	return nil
}

// writeZip 把条目写成一个可读 zip；文本条目用 Deflate，图片原样存放。
func writeZip(target string, items []zipItem) *Error {
	temp, failure := tempOf(target)
	if failure != nil {
		return failure
	}
	done := false
	defer finishTemp(temp, &done)
	file, err := os.OpenFile(temp, os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return failedf("写不了结果包：%v", err)
	}
	zw := zip.NewWriter(file)
	for _, item := range items {
		if err := writeZipItem(zw, item); err != nil {
			return failedf("写结果包失败：%v", err)
		}
	}
	if err := zw.Close(); err != nil {
		return failedf("结果包没有写完：%v", err)
	}
	if err := file.Close(); err != nil {
		return failedf("结果包没有写好：%v", err)
	}
	if err := commit(temp, target, &done); err != nil {
		return err
	}
	return nil
}

// writeZipItem 写一个 zip 条目：图片原样存放。
func writeZipItem(zw *zip.Writer, item zipItem) error {
	writer, err := zw.CreateHeader(&zip.FileHeader{Name: item.name, Method: zip.Store})
	if err != nil {
		return err
	}
	file, err := os.Open(item.path)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.Copy(writer, file)
	return err
}

// tempOf 在目标目录里建临时文件的路径（不提前建目标文件）。
func tempOf(target string) (string, *Error) {
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", failedf("建不了目标目录：%v", err)
	}
	file, err := os.CreateTemp(dir, ".kacha-save-*.tmp")
	if err != nil {
		return "", failedf("建不了临时文件：%v", err)
	}
	name := file.Name()
	_ = file.Close()
	return name, nil
}

// finishTemp 失败时清掉临时产物。
func finishTemp(temp string, done *bool) {
	if !*done {
		_ = os.Remove(temp)
	}
}

// commit 原子提交：目标已存在不覆盖；done 由调用点在成功时置位。
func commit(temp, target string, done *bool) *Error {
	if _, err := os.Stat(target); err == nil {
		return failedf("目标已存在，不覆盖：%s", filepath.Base(target))
	}
	if err := os.Rename(temp, target); err != nil {
		return failedf("提交结果失败：%v", err)
	}
	*done = true
	return nil
}


