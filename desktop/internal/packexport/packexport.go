// Package packexport 按 ADR 0013 的画板包格式在本机打包：清单与画板由页面给文本，
// 任务目录与参考图按规格从数据根流式写入 zip；被省略的重复路径由导入端还原。
//
// 这里只做事实与打包：目标选择、进度轮询与取消状态由 desktop/internal/packservice 负责。
package packexport

import (
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// 失败类别：界面按类别分支，不看文案。
const (
	KindInvalid   = "invalid"
	KindCancelled = "cancelled"
	KindFailed    = "failed"
)

// 步骤名。
const (
	StepCheck = "check"
	StepPack  = "pack"
)

// Error 是一次导出失败的结局：类别、步骤与给用户看的说法。
type Error struct {
	Kind    string
	Step    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func invalidf(format string, args ...any) *Error {
	return &Error{Kind: KindInvalid, Step: StepCheck, Message: fmt.Sprintf(format, args...)}
}

func failedf(format string, args ...any) *Error {
	return &Error{Kind: KindFailed, Step: StepPack, Message: fmt.Sprintf(format, args...)}
}

// Fact 是包内一个文件的长度与哈希（去重与预估大小的输入）。
type Fact struct {
	Entry  string `json:"entry"`
	Size   int64  `json:"size"`
	Sha256 string `json:"sha256"`
}

// TextEntry 是直接写进 zip 的文本条目（manifest.json 与画板）。
type TextEntry struct {
	Entry string `json:"entry"`
	Text  string `json:"text"`
}

// FileEntry 把一个数据根内的文件放到包内的指定路径。
type FileEntry struct {
	Source string `json:"source"`
	Entry  string `json:"entry"`
}

// Spec 是页面按既有画板包规则算好的导出规格。
type Spec struct {
	Texts    []TextEntry `json:"texts"`
	TaskDirs []string    `json:"task_dirs"`
	Files    []FileEntry `json:"files"`
	Omitted  []string    `json:"omitted"`
}

// Progress 是一次导出的进度快照。
type Progress struct {
	Step       string `json:"step"`
	Done       int    `json:"done"`
	Total      int    `json:"total"`
	BytesDone  int64  `json:"bytes_done"`
	BytesTotal int64  `json:"bytes_total"`
	Detail     string `json:"detail"`
}

// Result 是一次成功导出的计数。
type Result struct {
	TaskDirs int   `json:"task_dirs"`
	Bytes    int64 `json:"bytes"`
}

// item 是一个要写进包的文件：包内路径与数据根内的实路径。
type item struct {
	entry  string
	source string
}

// Facts 展开任务目录与参考图，给出每个条目的长度与 sha256（含被去重省略的条目）。
func Facts(root string, spec Spec) ([]Fact, *Error) {
	items, err := collect(root, spec, true)
	if err != nil {
		return nil, err
	}
	facts := make([]Fact, 0, len(items))
	for _, it := range items {
		info, err := os.Lstat(it.source)
		if err != nil || !info.Mode().IsRegular() {
			return nil, invalidf("包源文件读不出来：%s", it.entry)
		}
		sum, err := fileSha256(it.source)
		if err != nil {
			return nil, failedf("算哈希失败：%v", err)
		}
		facts = append(facts, Fact{Entry: it.entry, Size: info.Size(), Sha256: sum})
	}
	return facts, nil
}

// fileSha256 流式算一个文件的 sha256。
func fileSha256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

// collect 展开规格里的文件，校验路径边界与去重清单；includeOmitted 为 false 时略过被省略的条目。
func collect(root string, spec Spec, includeOmitted bool) ([]item, *Error) {
	omitted := map[string]bool{}
	for _, entry := range spec.Omitted {
		if !safePath(entry) {
			return nil, invalidf("duplicates 含无效路径：%s", entry)
		}
		omitted[entry] = true
	}
	items := []item{}
	for _, dir := range spec.TaskDirs {
		if !taskDirValid(dir) {
			return nil, invalidf("任务目录路径无效：%s", dir)
		}
		abs := filepath.Join(root, filepath.FromSlash(dir))
		if !within(root, abs) {
			return nil, invalidf("任务目录越出数据根：%s", dir)
		}
		found, err := walkTaskDir(root, abs, dir, omitted, includeOmitted)
		if err != nil {
			return nil, err
		}
		items = append(items, found...)
	}
	for _, file := range spec.Files {
		if !safePath(file.Entry) {
			return nil, invalidf("包内路径无效：%s", file.Entry)
		}
		abs := filepath.Clean(file.Source)
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(root, abs)
		}
		if !within(root, abs) {
			return nil, invalidf("源文件越出数据根：%s", file.Source)
		}
		if !omitted[file.Entry] || includeOmitted {
			items = append(items, item{entry: file.Entry, source: abs})
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].entry < items[j].entry })
	if err := checkPaths(items, spec, omitted, includeOmitted); err != nil {
		return nil, err
	}
	return items, nil
}

// checkPaths 守住唯一条目与被省略路径：重复写入和凭空省略都不允许。
func checkPaths(items []item, spec Spec, omitted map[string]bool, includeOmitted bool) *Error {
	seen := map[string]bool{}
	for _, it := range items {
		if seen[it.entry] {
			return invalidf("包内路径重复：%s", it.entry)
		}
		seen[it.entry] = true
	}
	for _, text := range spec.Texts {
		if !safePath(text.Entry) || seen[text.Entry] {
			return invalidf("文本条目路径无效或重复：%s", text.Entry)
		}
		seen[text.Entry] = true
	}
	if !includeOmitted {
		for entry := range omitted {
			if seen[entry] {
				return invalidf("被省略的路径同时出现在包里：%s", entry)
			}
		}
	}
	return nil
}

// walkTaskDir 列一个任务目录下的全部文件（不跟着符号链接走）。
func walkTaskDir(root, abs, rel string, omitted map[string]bool, includeOmitted bool) ([]item, *Error) {
	items := []item{}
	err := filepath.WalkDir(abs, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return failedf("读任务目录失败：%v", err)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return invalidf("任务目录含符号链接：%s", path)
		}
		if entry.IsDir() {
			return nil
		}
		name, err := filepath.Rel(root, path)
		if err != nil {
			return failedf("算包内路径失败：%v", err)
		}
		packPath := filepath.ToSlash(name)
		if !safePath(packPath) {
			return invalidf("包内路径无效：%s", packPath)
		}
		if omitted[packPath] && !includeOmitted {
			return nil
		}
		items = append(items, item{entry: packPath, source: path})
		return nil
	})
	if err != nil {
		return nil, failedf("读任务目录失败：%v", err)
	}
	return items, nil
}

// safePath 与导入端一致：每段非空、不是 . / ..、不含反斜杠冒号与控制字符。
func safePath(name string) bool {
	if name == "" {
		return false
	}
	for _, segment := range strings.Split(name, "/") {
		if segment == "" || segment == "." || segment == ".." || strings.ContainsAny(segment, "\\:") {
			return false
		}
		for _, r := range segment {
			if r < 0x20 || r == 0x7f {
				return false
			}
		}
	}
	return true
}

// taskDirValid 只接受 <UTC 日期>/<task_id> 两段的任务目录。
func taskDirValid(dir string) bool {
	parts := strings.Split(dir, "/")
	return len(parts) == 2 && isDate(parts[0]) && parts[1] != ""
}

func isDate(s string) bool {
	if len(s) != 10 || s[4] != '-' || s[7] != '-' {
		return false
	}
	for i, r := range s {
		if i == 4 || i == 7 {
			continue
		}
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// within 判路径是否在 root 里（Windows 盘符大小写不敏感）。
func within(root, path string) bool {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	prefix := strings.ToLower(absRoot) + string(os.PathSeparator)
	return strings.HasPrefix(strings.ToLower(absPath), prefix)
}
