// Package packimport 把一个手工导出的画板包（.ugcpack）导入本地数据根。
//
// 画板包格式见 client/src/core/boardPack.ts：zip 里是
// manifest.json、画板/<文件>.ugcboard.json、<日期>/<task_id>/… 与 导入参考图/<文件>。
// 导入分九步（检查 → 解压到临时目录 → 还原被省略的重复内容 → 核对 → 合并 → 提交画板 → 清理），
// 检查通过之前不写任何东西：路径越界、符号链接、缺失条目与读不懂的清单都在这一步被拒，
// 拒绝时本地数据保持不变。
//
// 合并按内容判定，从不覆盖：任务目录按 task.json 逐字节比对，参考图按整文件比对；
// 一样就跳过（identical），不一样就报冲突（conflict）。画板一律作为新画板提交（只新建，
// 名字由标题派生），后一块写失败时把前面写好的画板撤掉，不留半成品。
//
// 这里不碰界面：进度经回调给出，go test 不需要窗口就能跑。
package packimport

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

const (
	// TempPrefix 是导入临时目录的前缀（在数据根下，导入结束无论成败都删掉）。
	TempPrefix = ".ugcpack-import."
	// ManifestName 是包内清单的文件名。
	ManifestName = "manifest.json"
	// BoardsDirName 是包内画板目录名（与数据根里的画板目录同名）。
	BoardsDirName = localstore.BoardsDir
	// ReferencesDirName 是包内、也是数据根里的导入参考图目录名。
	ReferencesDirName = "导入参考图"
	// TaskRecordName 是任务目录里判定「同一份」的身份文件。
	TaskRecordName = "task.json"
	// PackFormatVersion 是本机读得懂的最高包格式版本。
	PackFormatVersion = 2
	// staleTempAge 是临时目录的清扫门槛：更老的说明上次导入中断了。
	staleTempAge = time.Hour
)

// 导入的步骤名：错误里带上它，界面据此说清卡在哪一步。
const (
	StepCheck   = "check"
	StepExtract = "extract"
	StepRestore = "restore"
	StepMerge   = "merge"
	StepBoards  = "boards"
)

// 失败类别：界面按类别分支，不看文案。
const (
	// KindCorrupt 是包本身有问题（缺条目、路径越界、清单读不懂、内容不完整）。
	KindCorrupt = "corrupt"
	// KindNewer 是包的格式版本高于本机。
	KindNewer = "newer"
	// KindInvalid 是导入前的本地前提不成立（包文件读不出来等）。
	KindInvalid = "invalid"
	// KindConflict 是画板提交撞上同名或本地画板已在别处改动。
	KindConflict = "conflict"
	// KindSlotsFull 是可编辑画板位已满：本机存储拒绝新建，导入不能绕过。
	KindSlotsFull = "slotsFull"
	// KindFailed 是本地写入失败。
	KindFailed = "failed"
	// KindCancelled 是用户取消了导入：已移入的任务目录保留，画板不再写入。
	KindCancelled = "cancelled"
)

// Error 是一次导入失败的结局：类别、卡在哪一步、给用户看的说法。
type Error struct {
	Kind    string `json:"kind"`
	Step    string `json:"step"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Message }

func corruptf(step, format string, args ...any) *Error {
	return &Error{Kind: KindCorrupt, Step: step, Message: fmt.Sprintf(format, args...)}
}

// Progress 是一次导入的进度快照：步骤、已做与总数、正在做什么。
type Progress struct {
	Step   string `json:"step"`
	Done   int    `json:"done"`
	Total  int    `json:"total"`
	Detail string `json:"detail"`
	// BytesDone 与 BytesTotal 是解压的字节进度：大包只看条目数看不出进展。
	BytesDone  int64 `json:"bytes_done"`
	BytesTotal int64 `json:"bytes_total"`
}

// Outcome 是一个合并单元的结局：moved（移入）/ identical（本机已有且一致）/ conflict（不一致，未覆盖）。
type Outcome struct {
	Path    string `json:"path"`
	Outcome string `json:"outcome"`
}

// Report 是一次成功导入的结局。
type Report struct {
	// Outcomes 是每个合并单元的结局（任务目录与参考图）。
	Outcomes []Outcome `json:"outcomes"`
	// Bytes 是解压出来的字节数。
	Bytes int64 `json:"bytes"`
	// Boards 是新画板相对数据根的路径。
	Boards []string `json:"boards"`
	// Imported 是移入的任务目录数。
	Imported int `json:"imported"`
	// Skipped 是本机已有且一致、跳过的任务目录数。
	Skipped int `json:"skipped"`
	// Conflicts 是不一致、未覆盖的包内路径。
	Conflicts []string `json:"conflicts"`
	// Missing 是画板引用了、但本机与包里都没有的图片（节点保留，显示为缺图占位）。
	Missing []string `json:"missing"`
	// Message 是给用户看的一句话结论。
	Message string `json:"message"`
}

// Store 是导入需要的本地文件层（生产实现是 localstore.Store）。
type Store interface {
	// Root 是数据根的绝对路径：导入的一切都写在这里面。
	Root() string
	// CreateBoard 在画板目录里新建一块画板（只新建，名字由标题派生）。
	CreateBoard(title, text string) (string, localstore.Result)
}

// Importer 把画板包导入一个数据根。进度回调与取消判定都可以为 nil。
type Importer struct {
	store      Store
	onProgress func(Progress)
	cancelled  func() bool
}

// New 造一个以 root 为数据根的导入器。
func New(root string) *Importer {
	return NewWithStore(localstore.New(root))
}

// NewWithStore 造一个用给定文件层的导入器（测试可以换成自己的）。
func NewWithStore(store Store) *Importer {
	return &Importer{store: store}
}

// OnProgress 设置进度回调：每一步开始时给出总数，之后逐个报已做的数量。
func (im *Importer) OnProgress(fn func(Progress)) { im.onProgress = fn }

// OnCancel 设置取消判定：每处理一个条目问一次，返回 true 就停下（已移入的保留、画板不写）。
func (im *Importer) OnCancel(fn func() bool) { im.cancelled = fn }

// cancelledNow 报告用户是否取消了导入。
func (im *Importer) cancelledNow(step string) error {
	if im.cancelled != nil && im.cancelled() {
		return &Error{Kind: KindCancelled, Step: step, Message: "已取消导入；已移入的任务目录保留"}
	}
	return nil
}

func (im *Importer) report(p Progress) {
	if im.onProgress != nil {
		im.onProgress(p)
	}
}

// packBoard 是包内的一块画板：条目名、标题与原文。
type packBoard struct {
	entry string
	title string
	text  string
}

// unit 是一个合并单元：任务目录（identity = task.json）或参考图（identity = 空，整文件比对）。
type unit struct {
	path     string
	identity string
}

// plan 是检查通过后的导入计划：还没写任何东西。
type plan struct {
	entries    map[string]*zip.File
	boards     []packBoard
	units      []unit
	duplicates map[string]string
	files      []string
}

// Import 导入 packPath 指向的画板包，返回结局；失败时返回带类别与步骤的 *Error。
func (im *Importer) Import(packPath string) (Report, error) {
	zr, err := zip.OpenReader(packPath)
	if err != nil {
		return Report{}, &Error{Kind: KindInvalid, Step: StepCheck, Message: "画板包读不出来（可能不完整）：" + err.Error()}
	}
	defer zr.Close()

	im.report(Progress{Step: StepCheck, Detail: "正在检查画板包"})
	planned, err := readPlan(zr.File)
	if err != nil {
		return Report{}, err
	}

	im.sweepStaleTemps()
	tempDir, err := os.MkdirTemp(im.store.Root(), TempPrefix)
	if err != nil {
		return Report{}, &Error{Kind: KindFailed, Step: StepExtract, Message: "建不了导入临时目录：" + err.Error()}
	}
	defer os.RemoveAll(tempDir)

	written, err := im.extract(tempDir, planned)
	if err != nil {
		return Report{}, err
	}
	if err := im.restoreDuplicates(tempDir, planned); err != nil {
		return Report{}, err
	}
	if err := verifyUnits(tempDir, planned.units); err != nil {
		return Report{}, err
	}
	outcomes, err := im.merge(tempDir, planned.units)
	if err != nil {
		return Report{}, err
	}
	boards, err := im.commitBoards(planned.boards)
	if err != nil {
		return Report{}, err
	}

	report := summarize(outcomes, planned.units, boards, written, missingImages(planned.boards, im.store.Root()))
	im.report(Progress{Step: "done", Done: 1, Total: 1, Detail: report.Message})
	return report, nil
}

// root 返回数据根。
func (im *Importer) root() string { return im.store.Root() }

// readPlan 只读清单、画板文本与条目名，判版本与布局：不合格的包在这里就被拒，一个字节都不写。
func readPlan(files []*zip.File) (plan, error) {
	entries := map[string]*zip.File{}
	for _, f := range files {
		name := f.Name
		if strings.HasSuffix(name, "/") {
			continue
		}
		if f.Mode()&os.ModeSymlink != 0 {
			return plan{}, corruptf(StepCheck, "包内含符号链接：%s", name)
		}
		if !safePath(name) {
			return plan{}, corruptf(StepCheck, "包内路径无效：%s", name)
		}
		entries[name] = f
	}

	manifestFile, ok := entries[ManifestName]
	if !ok {
		return plan{}, corruptf(StepCheck, "缺少 %s", ManifestName)
	}
	manifestText, err := readEntry(manifestFile)
	if err != nil {
		return plan{}, corruptf(StepCheck, "%s 读不出来：%v", ManifestName, err)
	}
	manifest, err := parseManifest(manifestText)
	if err != nil {
		return plan{}, err
	}

	names := map[string]bool{}
	for name := range entries {
		names[name] = true
	}
	duplicates, err := checkDuplicates(manifest.Duplicates, names, manifest.Boards)
	if err != nil {
		return plan{}, err
	}
	for omitted := range duplicates {
		names[omitted] = true
	}

	// 布局：只允许清单、画板、任务目录里的文件与导入参考图；其余一律判损坏。
	taskDirs := map[string]bool{}
	references := []string{}
	for name := range names {
		if name == ManifestName || isBoardEntry(name) {
			continue
		}
		if dir, ok := taskDirOf(name); ok {
			taskDirs[dir] = true
			continue
		}
		if parts := strings.Split(name, "/"); len(parts) == 2 && parts[0] == ReferencesDirName {
			references = append(references, name)
			continue
		}
		return plan{}, corruptf(StepCheck, "包内含无法识别的路径：%s", name)
	}
	dirs := sortedKeys(taskDirs)
	for _, dir := range dirs {
		if !names[dir+"/"+TaskRecordName] {
			return plan{}, corruptf(StepCheck, "任务目录 %s 缺少 %s", dir, TaskRecordName)
		}
	}

	boards := []packBoard{}
	for _, entry := range manifest.Boards {
		file, ok := entries[entry]
		if !ok {
			return plan{}, corruptf(StepCheck, "包内缺少画板 %s", entry)
		}
		text, err := readEntry(file)
		if err != nil {
			return plan{}, corruptf(StepCheck, "画板 %s 读不出来：%v", entry, err)
		}
		title, err := checkBoard(entry, text)
		if err != nil {
			return plan{}, err
		}
		boards = append(boards, packBoard{entry: entry, title: title, text: string(text)})
	}

	units := make([]unit, 0, len(dirs)+len(references))
	for _, dir := range dirs {
		units = append(units, unit{path: dir, identity: TaskRecordName})
	}
	sort.Strings(references)
	for _, ref := range references {
		units = append(units, unit{path: ref})
	}

	// 要解压的条目：合并单元里的文件（被省略的路径不在其中，稍后由代表条目还原）。
	needed := []string{}
	for name := range entries {
		if name == ManifestName || isBoardEntry(name) {
			continue
		}
		needed = append(needed, name)
	}
	sort.Strings(needed)

	return plan{entries: entries, boards: boards, units: units, duplicates: duplicates, files: needed}, nil
}

// manifest 是清单里导入关心的字段。
type manifest struct {
	PackFormatVersion json.Number       `json:"pack_format_version"`
	AppVersion        *string           `json:"app_version"`
	Boards            []string          `json:"boards"`
	Duplicates        map[string]string `json:"duplicates"`
}

// parseManifest 判清单的版本与形状。
func parseManifest(text []byte) (manifest, error) {
	var m manifest
	decoder := json.NewDecoder(strings.NewReader(string(text)))
	if err := decoder.Decode(&m); err != nil {
		return manifest{}, corruptf(StepCheck, "%s 不是有效的 JSON", ManifestName)
	}
	version, err := m.PackFormatVersion.Int64()
	if err != nil || version < 1 {
		return manifest{}, corruptf(StepCheck, "%s 缺少包格式版本", ManifestName)
	}
	if version > PackFormatVersion {
		by := ""
		if m.AppVersion != nil && *m.AppVersion != "" {
			by = fmt.Sprintf("（由 %s 导出）", *m.AppVersion)
		}
		return manifest{}, &Error{
			Kind:    KindNewer,
			Step:    StepCheck,
			Message: fmt.Sprintf("该画板包的格式版本 %d 高于本机支持的 %d%s，请升级本工具后再导入", version, PackFormatVersion, by),
		}
	}
	if m.AppVersion == nil || m.Boards == nil {
		return manifest{}, corruptf(StepCheck, "%s 格式无效", ManifestName)
	}
	return m, nil
}

// checkBoard 判一块画板文本：必须是 JSON 对象、版本读得懂；标题为空时用文件名。
func checkBoard(entry string, text []byte) (string, error) {
	var header struct {
		FormatVersion json.Number `json:"format_version"`
		Title         string      `json:"title"`
	}
	if err := json.Unmarshal(text, &header); err != nil {
		return "", corruptf(StepCheck, "包内画板 %s 已损坏：不是有效的 JSON", path.Base(entry))
	}
	version, err := header.FormatVersion.Int64()
	if err != nil || version < 1 {
		return "", corruptf(StepCheck, "包内画板 %s 已损坏：缺少 format_version", path.Base(entry))
	}
	if version > PackFormatVersion {
		return "", &Error{
			Kind:    KindNewer,
			Step:    StepCheck,
			Message: fmt.Sprintf("包内画板 %s 由更新版本保存（format_version %d），请升级本工具后再导入", path.Base(entry), version),
		}
	}
	title := strings.TrimSpace(header.Title)
	if title == "" {
		title = strings.TrimSuffix(path.Base(entry), localstore.BoardExt)
	}
	return title, nil
}

// checkDuplicates 判 v2 清单的 duplicates：键要是可省略的路径且不是实存条目，值要是实存条目，不许链式映射。
func checkDuplicates(duplicates map[string]string, entries map[string]bool, boards []string) (map[string]string, error) {
	if len(duplicates) == 0 {
		return map[string]string{}, nil
	}
	boardEntries := map[string]bool{}
	for _, entry := range boards {
		boardEntries[entry] = true
	}
	out := map[string]string{}
	for omitted, source := range duplicates {
		if !safePath(omitted) {
			return nil, corruptf(StepCheck, "duplicates 含无效路径：%s", omitted)
		}
		if omitted == ManifestName || isBoardEntry(omitted) || boardEntries[omitted] {
			return nil, corruptf(StepCheck, "duplicates 不能省略 %s", omitted)
		}
		if entries[omitted] {
			return nil, corruptf(StepCheck, "duplicates 的省略路径 %s 同时是包内条目", omitted)
		}
		if _, chained := duplicates[source]; chained {
			return nil, corruptf(StepCheck, "duplicates 不允许链式映射：%s → %s", omitted, source)
		}
		if !entries[source] {
			return nil, corruptf(StepCheck, "duplicates 指向包内不存在的条目：%s → %s", omitted, source)
		}
		if _, ok := taskDirOf(omitted); !ok {
			if parts := strings.Split(omitted, "/"); len(parts) != 2 || parts[0] != ReferencesDirName {
				return nil, corruptf(StepCheck, "duplicates 只能省略任务目录或导入参考图里的文件：%s", omitted)
			}
		}
		out[omitted] = source
	}
	return out, nil
}

// extract 把合并单元里的文件解压到临时目录，返回解压的字节数。
func (im *Importer) extract(tempDir string, planned plan) (int64, error) {
	total := len(planned.files)
	var totalBytes int64
	for _, name := range planned.files {
		totalBytes += int64(planned.entries[name].UncompressedSize64)
	}
	im.report(Progress{Step: StepExtract, Total: total, BytesTotal: totalBytes, Detail: "正在解压"})
	var written int64
	for i, name := range planned.files {
		if err := im.cancelledNow(StepExtract); err != nil {
			return 0, err
		}
		file := planned.entries[name]
		dst := filepath.Join(tempDir, filepath.FromSlash(name))
		if !within(tempDir, dst) {
			return 0, corruptf(StepExtract, "包内路径越出导入目录：%s", name)
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return 0, &Error{Kind: KindFailed, Step: StepExtract, Message: "建不了目录：" + err.Error()}
		}
		n, err := writeEntry(file, dst)
		if err != nil {
			return 0, err
		}
		written += n
		im.report(Progress{Step: StepExtract, Done: i + 1, Total: total, BytesDone: written, BytesTotal: totalBytes, Detail: name})
	}
	return written, nil
}

// writeEntry 把一个 zip 条目写进 dst（目标已存在就拒绝）。
func writeEntry(file *zip.File, dst string) (int64, error) {
	rc, err := file.Open()
	if err != nil {
		return 0, corruptf(StepExtract, "包内条目 %s 读不出来（可能不完整）：%v", file.Name, err)
	}
	defer rc.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return 0, &Error{Kind: KindFailed, Step: StepExtract, Message: "写不了文件：" + err.Error()}
	}
	n, copyErr := io.Copy(out, rc)
	closeErr := out.Close()
	if copyErr != nil {
		return n, corruptf(StepExtract, "包内条目 %s 解不出来（可能不完整）：%v", file.Name, copyErr)
	}
	if closeErr != nil {
		return n, &Error{Kind: KindFailed, Step: StepExtract, Message: "写不了文件：" + closeErr.Error()}
	}
	return n, nil
}

// restoreDuplicates 把被省略的路径还原成与代表条目内容相同的文件（先硬链接，失败再复制）。
func (im *Importer) restoreDuplicates(tempDir string, planned plan) error {
	if len(planned.duplicates) == 0 {
		return nil
	}
	keys := sortedKeys(planned.duplicates)
	im.report(Progress{Step: StepRestore, Total: len(keys), Detail: "正在还原重复内容"})
	for i, omitted := range keys {
		source := planned.duplicates[omitted]
		src := filepath.Join(tempDir, filepath.FromSlash(source))
		dst := filepath.Join(tempDir, filepath.FromSlash(omitted))
		if !within(tempDir, dst) {
			return corruptf(StepRestore, "包内路径越出导入目录：%s", omitted)
		}
		if _, err := os.Stat(dst); err == nil {
			return corruptf(StepRestore, "被省略的路径 %s 也出现在包里", omitted)
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return &Error{Kind: KindFailed, Step: StepRestore, Message: "建不了目录：" + err.Error()}
		}
		if err := os.Link(src, dst); err != nil {
			if err := copyFile(src, dst); err != nil {
				return &Error{Kind: KindFailed, Step: StepRestore, Message: "还原重复内容失败：" + err.Error()}
			}
		}
		im.report(Progress{Step: StepRestore, Done: i + 1, Total: len(keys), Detail: omitted})
	}
	return nil
}

// verifyUnits 核对每个合并单元都在、且身份文件在：包内容不完整时在这里拒绝，还没动数据根。
func verifyUnits(tempDir string, units []unit) error {
	for _, u := range units {
		info, err := os.Stat(filepath.Join(tempDir, filepath.FromSlash(u.path)))
		if u.identity == "" {
			// 参考图是单个文件：不是文件就是包不完整。
			if err != nil || info.IsDir() {
				return corruptf(StepExtract, "包内缺少 %s", u.path)
			}
			continue
		}
		if err != nil || !info.IsDir() {
			return corruptf(StepExtract, "包内缺少 %s", u.path)
		}
		identity := filepath.Join(tempDir, filepath.FromSlash(u.path), u.identity)
		info, err = os.Stat(identity)
		if err != nil || info.IsDir() {
			return corruptf(StepExtract, "任务目录 %s 缺少 %s", u.path, u.identity)
		}
	}
	return nil
}

// merge 逐个合并单元落盘：本机已有就比对（一样跳过、不一样报冲突），没有就移入。
func (im *Importer) merge(tempDir string, units []unit) ([]Outcome, error) {
	total := len(units)
	im.report(Progress{Step: StepMerge, Total: total, Detail: "正在合并"})
	outcomes := make([]Outcome, 0, total)
	root := im.root()
	for i, u := range units {
		if err := im.cancelledNow(StepMerge); err != nil {
			return nil, err
		}
		src := filepath.Join(tempDir, filepath.FromSlash(u.path))
		dst := filepath.Join(root, filepath.FromSlash(u.path))
		outcome := "moved"
		if _, err := os.Stat(dst); err == nil {
			same, err := sameContent(src, dst, u.identity)
			if err != nil {
				return nil, &Error{Kind: KindFailed, Step: StepMerge, Message: "比对 " + u.path + " 失败：" + err.Error()}
			}
			if same {
				outcome = "identical"
			} else {
				outcome = "conflict"
			}
		} else {
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return nil, &Error{Kind: KindFailed, Step: StepMerge, Message: "建不了目录：" + err.Error()}
			}
			if err := os.Rename(src, dst); err != nil {
				return nil, &Error{Kind: KindFailed, Step: StepMerge, Message: "移入 " + u.path + " 失败：" + err.Error()}
			}
		}
		outcomes = append(outcomes, Outcome{Path: u.path, Outcome: outcome})
		im.report(Progress{Step: StepMerge, Done: i + 1, Total: total, Detail: u.path})
	}
	return outcomes, nil
}

// commitBoards 把包内画板作为新画板提交（只新建）；后一块失败时把前面写好的撤掉，不留半成品。
func (im *Importer) commitBoards(boards []packBoard) ([]string, error) {
	total := len(boards)
	im.report(Progress{Step: StepBoards, Total: total, Detail: "正在写入画板"})
	created := make([]string, 0, total)
	for i, b := range boards {
		if err := im.cancelledNow(StepBoards); err != nil {
			rollback(created)
			return nil, err
		}
		path, result := im.store.CreateBoard(b.title, b.text)
		if !result.OK {
			rollback(created)
			kind := KindFailed
			switch result.Kind {
			case localstore.KindConflict:
				kind = KindConflict
			case localstore.KindAlreadyExist:
				kind = KindConflict
			case localstore.KindInvalid:
				kind = KindInvalid
			case localstore.KindSlotsFull:
				kind = KindSlotsFull
			}
			return nil, &Error{Kind: kind, Step: StepBoards, Message: "画板没有写入：" + result.Message}
		}
		created = append(created, path)
		im.report(Progress{Step: StepBoards, Done: i + 1, Total: total, Detail: path})
	}
	out := make([]string, 0, len(created))
	for _, abs := range created {
		out = append(out, rel(im.store.Root(), abs))
	}
	return out, nil
}

// rollback 撤掉这次导入已经写好的画板（主文件与 .bak 一起）。
func rollback(created []string) {
	for _, path := range created {
		_ = os.Remove(path)
		_ = os.Remove(path + ".bak")
	}
}

// summarize 把结局折成一句话与计数：只有任务目录计入「导入 / 跳过」，参考图只看冲突。
func summarize(outcomes []Outcome, units []unit, boards []string, bytes int64, missing []string) Report {
	report := Report{Outcomes: outcomes, Bytes: bytes, Boards: boards, Conflicts: []string{}, Missing: missing}
	taskDirs := map[string]bool{}
	for _, u := range units {
		if u.identity != "" {
			taskDirs[u.path] = true
		}
	}
	for _, o := range outcomes {
		if o.Outcome == "conflict" {
			report.Conflicts = append(report.Conflicts, o.Path)
			continue
		}
		if !taskDirs[o.Path] {
			continue
		}
		if o.Outcome == "moved" {
			report.Imported++
		} else {
			report.Skipped++
		}
	}
	conflictText := ""
	if len(report.Conflicts) > 0 {
		conflictText = fmt.Sprintf("，%d 项冲突未覆盖", len(report.Conflicts))
	}
	missingText := ""
	if len(report.Missing) > 0 {
		missingText = fmt.Sprintf("，%d 张图片缺失（保留占位）", len(report.Missing))
	}
	report.Message = fmt.Sprintf("导入 %d 个任务，跳过 %d 个%s%s", report.Imported, report.Skipped, conflictText, missingText)
	return report
}

// missingImages 列出画板引用了、但本机没有的图片：节点保留，界面显示缺图占位。
//
// 只看 reference 与 result 节点的 path：它们指向数据根里的图片；根目录外的绝对路径同样按文件判断。
func missingImages(boards []packBoard, root string) []string {
	missing := []string{}
	seen := map[string]bool{}
	for _, b := range boards {
		var parsed struct {
			Nodes []struct {
				Type string `json:"type"`
				Path string `json:"path"`
			} `json:"nodes"`
		}
		if err := json.Unmarshal([]byte(b.text), &parsed); err != nil {
			continue
		}
		for _, node := range parsed.Nodes {
			if node.Type != "reference" && node.Type != "result" {
				continue
			}
			if node.Path == "" {
				continue
			}
			abs := filepath.FromSlash(node.Path)
			if !filepath.IsAbs(abs) {
				abs = filepath.Join(root, abs)
			}
			if info, err := os.Stat(abs); err == nil && !info.IsDir() {
				continue
			}
			rel := filepath.ToSlash(node.Path)
			if seen[rel] {
				continue
			}
			seen[rel] = true
			missing = append(missing, rel)
		}
	}
	sort.Strings(missing)
	return missing
}

// sweepStaleTemps 清掉上次中断留下的临时目录（超过 staleTempAge 的）。
func (im *Importer) sweepStaleTemps() {
	entries, err := os.ReadDir(im.store.Root())
	if err != nil {
		return
	}
	now := time.Now()
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), TempPrefix) {
			continue
		}
		info, err := e.Info()
		if err != nil || now.Sub(info.ModTime()) < staleTempAge {
			continue
		}
		_ = os.RemoveAll(filepath.Join(im.store.Root(), e.Name()))
	}
}

// sameContent 比对包内单元与本机已有的：任务目录只看 task.json，参考图看整文件。
func sameContent(src, dst, identity string) (bool, error) {
	if identity == "" {
		return sameFile(src, dst)
	}
	return sameFile(filepath.Join(src, identity), filepath.Join(dst, identity))
}

// sameFile 逐字节比对两个文件；一边读不出来就是不一样（按冲突处理）。
func sameFile(a, b string) (bool, error) {
	left, err := os.ReadFile(a)
	if err != nil {
		return false, err
	}
	right, err := os.ReadFile(b)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if len(left) != len(right) {
		return false, nil
	}
	for i := range left {
		if left[i] != right[i] {
			return false, nil
		}
	}
	return true, nil
}

// copyFile 复制文件（硬链接不可用时用）。
func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}

// readEntry 读出一个 zip 条目的全部字节。
func readEntry(file *zip.File) ([]byte, error) {
	rc, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// isBoardEntry 判条目名是不是 画板/<文件>。
func isBoardEntry(name string) bool {
	parts := strings.Split(name, "/")
	return len(parts) == 2 && parts[0] == BoardsDirName
}

// safePath 判包内路径：每段都不能为空、不能是 . 或 ..、不能有反斜杠、冒号与控制字符。
func safePath(name string) bool {
	if name == "" {
		return false
	}
	for _, segment := range strings.Split(name, "/") {
		if !safeSegment(segment) {
			return false
		}
	}
	return true
}

func safeSegment(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	if strings.ContainsAny(s, "\\:") {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// taskDirOf 判相对路径落在 <YYYY-MM-DD>/<task_id>/… 里时返回任务目录。
func taskDirOf(rel string) (string, bool) {
	parts := strings.Split(rel, "/")
	if len(parts) < 3 || !isDateDir(parts[0]) || parts[1] == "" {
		return "", false
	}
	return parts[0] + "/" + parts[1], true
}

// isDateDir 判第一段是不是 UTC 日期目录（YYYY-MM-DD）。
func isDateDir(s string) bool {
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

// within 判 p 是否在 root 里（root 自己不算）。
func within(root, p string) bool {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	absPath, err := filepath.Abs(p)
	if err != nil {
		return false
	}
	return strings.HasPrefix(strings.ToLower(absPath), strings.ToLower(absRoot)+string(os.PathSeparator))
}

// rel 把绝对路径写成相对数据根的正斜杠路径；根目录外的保留绝对路径。
func rel(root, abs string) string {
	if strings.HasPrefix(strings.ToLower(abs), strings.ToLower(root)+string(os.PathSeparator)) {
		return filepath.ToSlash(strings.TrimPrefix(abs, root+string(os.PathSeparator)))
	}
	return filepath.ToSlash(abs)
}

// sortedKeys 返回 map 的键（升序）。
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
