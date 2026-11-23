package packexport

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Export 按规格把数据根里的文件写进 target：先写临时文件，全部成功才原子改名。
// overwrite 表示用户已明确确认覆盖已存在的目标；没有确认就只新建不覆盖。
// 进度逐条目回报；取消时不留目标文件，也不留临时产物。
func Export(root, target string, spec Spec, overwrite bool, onProgress func(Progress), cancelled func() bool) (Result, *Error) {
	items, failure := collect(root, spec, false)
	if failure != nil {
		return Result{}, failure
	}
	if strings.TrimSpace(target) == "" {
		return Result{}, invalidf("没有选导出目标")
	}
	totalBytes := itemsBytes(items)
	report(onProgress, Progress{Step: StepCheck, Total: len(items), BytesTotal: totalBytes, Detail: "正在检查"})
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Result{}, failedf("建不了导出目录：%v", err)
	}
	temp, err := os.CreateTemp(dir, ".ugcpack-export-*.tmp")
	if err != nil {
		return Result{}, failedf("建不了临时包：%v", err)
	}
	tempPath := temp.Name()
	ok := false
	defer func() {
		_ = temp.Close()
		if !ok {
			_ = os.Remove(tempPath)
		}
	}()
	zw := zip.NewWriter(temp)
	if failure := writeTexts(zw, spec.Texts); failure != nil {
		return Result{}, failure
	}
	result, failure := writeItems(zw, items, totalBytes, onProgress, cancelled)
	if failure != nil {
		return Result{}, failure
	}
	result.TaskDirs = len(spec.TaskDirs)
	if err := zw.Close(); err != nil {
		return Result{}, failedf("打包失败：%v", err)
	}
	if err := temp.Close(); err != nil {
		return Result{}, failedf("写包失败：%v", err)
	}
	// 覆盖保护留在导出这一侧：只有调用方带上用户的明确确认，才允许替换已存在的目标；
	// 不依赖系统对话框有没有提示过。
	if _, err := os.Stat(target); err == nil && !overwrite {
		return Result{}, invalidf("目标已存在，不覆盖：%s", target)
	}
	if err := os.Rename(tempPath, target); err != nil {
		return Result{}, failedf("提交画板包失败：%v", err)
	}
	ok = true
	report(onProgress, Progress{Step: "done", Done: len(items), Total: len(items), BytesDone: result.Bytes, BytesTotal: totalBytes, Detail: "导出完成"})
	return result, nil
}

// writeTexts 写清单与画板：文本条目不参与去重，名字已在 collect 里校验过。
func writeTexts(zw *zip.Writer, texts []TextEntry) *Error {
	for _, text := range texts {
		writer, err := zw.CreateHeader(&zip.FileHeader{Name: text.Entry, Method: zip.Deflate})
		if err != nil {
			return failedf("写包内条目失败：%v", err)
		}
		if _, err := io.WriteString(writer, text.Text); err != nil {
			return failedf("写包内文本失败：%v", err)
		}
	}
	return nil
}

// writeItems 逐条目流式写文件；图片本身已压缩，按 Store 存放，文本用 Deflate。
func writeItems(zw *zip.Writer, items []item, totalBytes int64, onProgress func(Progress), cancelled func() bool) (Result, *Error) {
	result := Result{TaskDirs: len(items)}
	var done int64
	for i, it := range items {
		if cancelled != nil && cancelled() {
			return Result{}, &Error{Kind: KindCancelled, Step: StepPack, Message: "已取消导出"}
		}
		written, failure := writeItem(zw, it)
		if failure != nil {
			return Result{}, failure
		}
		done += written
		result.Bytes += written
		report(onProgress, Progress{Step: StepPack, Done: i + 1, Total: len(items), BytesDone: done, BytesTotal: totalBytes, Detail: it.entry})
	}
	return result, nil
}

// writeItem 写一个文件条目，返回写出的字节数。
func writeItem(zw *zip.Writer, it item) (int64, *Error) {
	info, err := os.Lstat(it.source)
	if err != nil || !info.Mode().IsRegular() {
		return 0, invalidf("包源文件读不出来：%s", it.entry)
	}
	method := zip.Store
	if strings.HasSuffix(it.entry, ".json") {
		method = zip.Deflate
	}
	writer, err := zw.CreateHeader(&zip.FileHeader{Name: it.entry, Method: method})
	if err != nil {
		return 0, failedf("写包内条目失败：%v", err)
	}
	file, err := os.Open(it.source)
	if err != nil {
		return 0, failedf("读包源文件失败：%v", err)
	}
	defer file.Close()
	written, err := io.Copy(writer, file)
	if err != nil {
		return 0, failedf("写包内容失败：%v", err)
	}
	return written, nil
}

// itemsBytes 合计要写出的字节数（进度分母）。
func itemsBytes(items []item) int64 {
	var total int64
	for _, it := range items {
		if info, err := os.Lstat(it.source); err == nil {
			total += info.Size()
		}
	}
	return total
}

func report(fn func(Progress), p Progress) {
	if fn != nil {
		fn(p)
	}
}
