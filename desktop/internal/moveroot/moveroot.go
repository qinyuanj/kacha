// Package moveroot 把数据根整份迁到用户选定的新位置（#161）。
//
// 迁移只做三件事：先把内容逐份复制到目标并逐份校验，全部成功后原子改写状态文件里的数据根记录，
// 最后让调用方重建依赖数据根的服务。复制或校验中途失败时状态记录不动，旧位置仍是唯一数据来源；
// 已经写进目标的半份内容会被清掉，不留一个半完成的目标。
package moveroot

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
)

// 失败类别：与端口失败类别同名，页面按类别分支（见 client/src/shell/port.ts）。
const (
	// KindInvalid 是路径本身不可用（空、不可写、里面有符号链接等）。
	KindInvalid = "invalid"
	// KindSameRoot 是目标就是当前数据根。
	KindSameRoot = "sameRoot"
	// KindNested 是源与目标互相包含：搬进去会把自己也搬走。
	KindNested = "nested"
	// KindNotEmpty 是目标已有内容：迁移不覆盖已有数据。
	KindNotEmpty = "notEmpty"
	// KindCancelled 是用户取消了迁移。
	KindCancelled = "cancelled"
	// KindFailed 是复制、校验或写状态失败。
	KindFailed = "failed"
)

// Error 是一次迁移失败的结局：Kind 供页面分支，Message 说明具体原因。
type Error struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Message }

func fail(kind, format string, args ...any) *Error {
	return &Error{Kind: kind, Message: fmt.Sprintf(format, args...)}
}

// KindOf 取出失败的类别；不是本包的失败按 failed 处理。
func KindOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return KindFailed
}

// Progress 是一次迁移的进度：Done / Total 按文件计，Current 是正在处理的相对路径。
type Progress struct {
	Done    int    `json:"done"`
	Total   int    `json:"total"`
	Bytes   int64  `json:"bytes"`
	Current string `json:"current"`
}

// Options 是迁移过程中的回调；两者都可为 nil。
type Options struct {
	// Progress 每复制完一份文件回调一次。
	Progress func(Progress)
	// Cancelled 在每份文件之前问一次：返回 true 时停止迁移并清掉目标里已写入的内容。
	Cancelled func() bool
}

// Report 是一次成功迁移的结果。
type Report struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Files  int    `json:"files"`
	Bytes  int64  `json:"bytes"`
}

// Migrate 把 source 的内容整份复制到 target 并校验，成功后把状态文件里的数据根改成 target。
//
// 调用前 source 必须是当前生效的数据根（状态文件里记着的那一份）：否则可能把一个已经作废的位置当成来源。
func Migrate(source, target, statePath string, opts *Options) (Report, error) {
	if opts == nil {
		opts = &Options{}
	}
	src, dst, err := prepare(source, target)
	if err != nil {
		return Report{}, err
	}
	files, err := plan(src)
	if err != nil {
		return Report{}, err
	}
	if err := ensureEmpty(dst); err != nil {
		return Report{}, err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return Report{}, fail(KindInvalid, "建不了目标目录 %s: %v", dst, err)
	}
	report := Report{Source: src, Target: dst, Files: len(files)}
	for i, rel := range files {
		if opts.Cancelled != nil && opts.Cancelled() {
			cleanup(dst)
			return Report{}, fail(KindCancelled, "已取消迁移；旧位置的数据没有改动")
		}
		n, err := copyOne(filepath.Join(src, rel), filepath.Join(dst, rel))
		if err != nil {
			cleanup(dst)
			return Report{}, err
		}
		report.Bytes += n
		if opts.Progress != nil {
			opts.Progress(Progress{Done: i + 1, Total: len(files), Bytes: report.Bytes, Current: rel})
		}
	}
	// 全部复制并校验成功之后才动状态记录：这之前旧位置一直是生效的数据根。
	if err := dataroot.Remember(statePath, dst, src); err != nil {
		cleanup(dst)
		return Report{}, fail(KindFailed, "写数据根记录失败：%v", err)
	}
	return report, nil
}

// prepare 校验并规范化两端路径：同一份、互相包含、不可写都要在复制之前拒绝。
func prepare(source, target string) (string, string, error) {
	if strings.TrimSpace(source) == "" || strings.TrimSpace(target) == "" {
		return "", "", fail(KindInvalid, "源与目标都必须有位置")
	}
	src, err := filepath.Abs(source)
	if err != nil {
		return "", "", fail(KindInvalid, "源位置读不出来：%v", err)
	}
	dst, err := filepath.Abs(target)
	if err != nil {
		return "", "", fail(KindInvalid, "目标位置读不出来：%v", err)
	}
	src, dst = filepath.Clean(src), filepath.Clean(dst)
	if info, err := os.Stat(src); err != nil || !info.IsDir() {
		return "", "", fail(KindInvalid, "当前数据根读不出来：%s", src)
	}
	if strings.EqualFold(src, dst) {
		return "", "", fail(KindSameRoot, "目标就是当前数据根")
	}
	if within(src, dst) || within(dst, src) {
		return "", "", fail(KindNested, "目标不能与当前数据根互相包含：%s", dst)
	}
	if err := writable(dst); err != nil {
		return "", "", err
	}
	return src, dst, nil
}

// within 判断 child 是否等于 parent 或在 parent 之下（大小写不敏感，Windows）。
func within(parent, child string) bool {
	return strings.EqualFold(parent, child) || strings.HasPrefix(strings.ToLower(child), strings.ToLower(parent)+string(os.PathSeparator))
}

// writable 确认目标可写：目标已存在就要求是目录，不存在就要求能在最近的已存在祖先下建目录。
func writable(dst string) error {
	if info, err := os.Stat(dst); err == nil {
		if !info.IsDir() {
			return fail(KindInvalid, "目标是一个文件，不是文件夹：%s", dst)
		}
		return probeWrite(dst)
	}
	ancestor := filepath.Dir(dst)
	for {
		if info, err := os.Stat(ancestor); err == nil {
			if !info.IsDir() {
				return fail(KindInvalid, "目标的上级不是文件夹：%s", ancestor)
			}
			return probeWrite(ancestor)
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return fail(KindInvalid, "目标位置不存在：%s", dst)
		}
		ancestor = parent
	}
}

// probeWrite 在 dir 下试建一个临时文件：只读盘、无权限、配额不足都会在这里暴露。
func probeWrite(dir string) error {
	f, err := os.CreateTemp(dir, ".kacha-move-probe.*")
	if err != nil {
		return fail(KindInvalid, "目标位置不可写：%s（%v）", dir, err)
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return nil
}

// ensureEmpty 要求目标要么不存在，要么是个空目录：迁移不覆盖目标已有内容。
func ensureEmpty(dst string) error {
	entries, err := os.ReadDir(dst)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fail(KindInvalid, "目标位置读不出来：%v", err)
	}
	if len(entries) > 0 {
		return fail(KindNotEmpty, "目标位置已有内容，迁移不覆盖：%s", dst)
	}
	return nil
}

// plan 列出源里要搬的全部文件（相对路径，正斜杠）。符号链接一律拒绝：
// 顺着链接复制会把数据根外的内容也搬进来。
func plan(src string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fail(KindInvalid, "数据根里有符号链接，不能迁移：%s", path)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		files = append(files, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		var e *Error
		if errors.As(err, &e) {
			return nil, e
		}
		return nil, fail(KindInvalid, "读当前数据根失败：%v", err)
	}
	return files, nil
}

// copyOne 复制一份文件并校验：长度与 sha256 都对上才算这一份成功。
func copyOne(from, to string) (int64, error) {
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return 0, fail(KindFailed, "建目录失败 %s: %v", filepath.Dir(to), err)
	}
	src, err := os.Open(from)
	if err != nil {
		return 0, fail(KindFailed, "读不了 %s: %v", from, err)
	}
	defer src.Close()
	dst, err := os.Create(to)
	if err != nil {
		return 0, fail(KindFailed, "写不了 %s: %v", to, err)
	}
	hash := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(dst, hash), src)
	syncErr := dst.Sync()
	closeErr := dst.Close()
	if copyErr != nil {
		return 0, fail(KindFailed, "复制 %s 失败：%v", from, copyErr)
	}
	if syncErr != nil {
		return 0, fail(KindFailed, "落盘 %s 失败：%v", to, syncErr)
	}
	if closeErr != nil {
		return 0, fail(KindFailed, "收尾 %s 失败：%v", to, closeErr)
	}
	want, err := digestOf(from)
	if err != nil {
		return 0, err
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != want {
		return 0, fail(KindFailed, "校验 %s 不一致：目标内容与源不同", to)
	}
	if info, err := os.Stat(to); err != nil || info.Size() != n {
		return 0, fail(KindFailed, "校验 %s 不一致：长度与源不同", to)
	}
	return n, nil
}

// digestOf 算文件字节的 sha256（小写十六进制）。
func digestOf(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fail(KindFailed, "读不了 %s: %v", path, err)
	}
	defer f.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return "", fail(KindFailed, "读 %s 失败：%v", path, err)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// cleanup 清掉目标里已写入的内容：目标在迁移前是空的，所以整份删掉不会伤到用户数据。
func cleanup(dst string) {
	entries, err := os.ReadDir(dst)
	if err != nil {
		return
	}
	for _, e := range entries {
		_ = os.RemoveAll(filepath.Join(dst, e.Name()))
	}
}
