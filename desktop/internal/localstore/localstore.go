// Package localstore 是桌面壳的本地文件层：画板、数据根里的文件与元数据。
//
// 一切都在数据根里：画板在 画板/，元数据在 .kacha/，删除的画板进 回收区/。
// 写入是原子的（临时文件 + 改名），覆盖前把旧主文件留一份 .bak；内容版本是主文件字节的 sha256。
// 这里不碰界面，go test 就能跑。
package localstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/qinyuanj/kacha/desktop/internal/boardmeasure"
	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
)

const (
	// BoardsDir 是画板目录名（见 core/paths.ts 的 BOARDS_DIR_NAME）。
	BoardsDir = "画板"
	// ArchiveDir 是归档画板目录名（画板目录下的子目录）。
	ArchiveDir = "归档"
	// MetaDir 是元数据目录名：settings.json、ui-state.json 等。
	MetaDir = ".kacha"
	// RecycleDir 是回收区目录名：删掉的画板移到这里，不直接抹掉。
	RecycleDir = "回收区"
	// BoardExt 是画板文件扩展名。
	BoardExt = ".ugcboard.json"
	// BoardSlots 是本机可编辑画板的数量上限。
	BoardSlots = 20
	// DefaultBoardTitle 是新建画板的默认标题（与共享契约 contracts/board-policy.json 一致）。
	DefaultBoardTitle = "未命名画板"
)

// windowsReserved 是 Windows 不能用作文件名的保留名。
var windowsReserved = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

// boardFileStem 是标题派生的文件名主干：去掉 Windows / macOS 非法字符与控制字符，
// 去首尾空白，Windows 不允许结尾空格和点；空则用默认标题；保留名加下划线。
func boardFileStem(title string) string {
	stem := strings.Map(func(r rune) rune {
		switch {
		case r < 0x20:
			return -1
		case strings.ContainsRune(`<>:"/\|?*`, r):
			return -1
		default:
			return r
		}
	}, title)
	stem = strings.TrimSpace(stem)
	stem = strings.TrimRight(stem, ". ")
	if stem == "" {
		stem = DefaultBoardTitle
	}
	if windowsReserved[strings.ToLower(stem)] {
		stem += "_"
	}
	return stem
}

// BoardFileName 由标题派生画板文件名（带扩展名）：重名加 " (2)"、" (3)"…，
// 比较不区分大小写（Windows / macOS 默认文件系统）。与 client/src/core/board.ts 同口径。
func BoardFileName(title string, existing []string) string {
	taken := map[string]bool{}
	for _, n := range existing {
		taken[strings.ToLower(n)] = true
	}
	stem := boardFileStem(title)
	for i := 1; ; i++ {
		name := stem + BoardExt
		if i > 1 {
			name = fmt.Sprintf("%s (%d)%s", stem, i, BoardExt)
		}
		if !taken[strings.ToLower(name)] {
			return name
		}
	}
}

// 失败类别：前端按类别分支（见 shell/port.ts 的 PortFailureKind），不是按文案。
const (
	KindMissing      = "missing"
	KindConflict     = "conflict"
	KindAlreadyExist = "alreadyExists"
	KindSlotsFull    = "slotsFull"
	KindArchived     = "archived"
	KindInvalid      = "invalid"
	KindFailed       = "failed"
)

// Result 是一次写入的结局：成功时 Kind 为空，失败时 Message 说明原因。
type Result struct {
	OK      bool   `json:"ok"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Version string `json:"version"`
}

func fail(kind, message string) Result {
	return Result{OK: false, Kind: kind, Message: message}
}

func ok(version string) Result {
	return Result{OK: true, Version: version}
}

// BoardTexts 是画板的主文件、备份与内容版本；画板不存在时 Main 与 Bak 为空。
type BoardTexts struct {
	Main    *string `json:"main"`
	Bak     *string `json:"bak"`
	Version *string `json:"version"`
}

// BoardEntry 是画板列表的一行：字节数读不出来时为 null（度量留给后面的切片）。
type BoardEntry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Archived bool   `json:"archived"`
	Bytes    *int64 `json:"bytes"`
}

// BoardListing 是画板列表：画板、画板位与体量提醒线。
type BoardListing struct {
	Boards    []BoardEntry `json:"boards"`
	Slots     Slots        `json:"slots"`
	SizeLines SizeLines    `json:"size_lines"`
}

// Slots 是画板位：已用与总数。
type Slots struct {
	Used  int `json:"used"`
	Total int `json:"total"`
}

// SizeLines 是体量提醒线（字节）：黄线与红线。
type SizeLines struct {
	Warn  int64 `json:"warn"`
	Alert int64 `json:"alert"`
}

// DirEntry 是目录里的一项。
type DirEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"is_dir"`
}

// Store 是数据根上的文件层。
type Store struct {
	// mu 串行化画板的创建 / 归档 / 取消归档：画板位与文件搬移都是一个原子决定，
	// 并发抢位时不能各看到 19 位然后都写进去。
	mu sync.Mutex
	// roots 是可切换的数据根（迁移 #161）：每次读写都现取，切一次就落到新位置。
	// 用 New 造的 Store 没有它，位置固定。
	roots *dataroot.Roots
	root  string
}

// New 造一个以 root 为数据根的 Store。
func New(root string) *Store {
	return &Store{root: root}
}

// NewFollowing 造一个跟着共享数据根走的 Store：迁移切换后读写自动落到新位置。
func NewFollowing(roots *dataroot.Roots) *Store {
	return &Store{roots: roots}
}

// Root 返回当前数据根。
func (s *Store) Root() string {
	if s.roots != nil {
		return s.roots.Current()
	}
	return s.root
}

// BoardDir 返回画板目录的绝对路径。
func (s *Store) BoardDir() string { return filepath.Join(s.Root(), BoardsDir) }

// MetaPath 返回元数据文件（settings.json、ui-state.json 等）的绝对路径。
func (s *Store) MetaPath(name string) string { return filepath.Join(s.Root(), MetaDir, name) }

// Resolve 把界面给的路径解析成绝对路径：绝对路径照用，相对路径按数据根拼。
// 越出数据根的路径一律拒绝（导入与外部引用都不能跑出去）。
func (s *Store) Resolve(path string) (string, error) {
	if path == "" {
		return "", errors.New("路径为空")
	}
	abs := path
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(s.Root(), filepath.FromSlash(path))
	}
	abs = filepath.Clean(abs)
	root := filepath.Clean(s.Root())
	if !withinRoot(root, abs) {
		return "", fmt.Errorf("路径越出数据根：%s", path)
	}
	// 词法前缀不够：根内一个指向根外的符号链接会被顺着读 / 写，必须按真实路径再判一次。
	if err := checkRealContainment(root, abs); err != nil {
		return "", err
	}
	return abs, nil
}

// withinRoot 是词法前缀判定：abs 等于 root 或在 root 之下（大小写不敏感，Windows）。
func withinRoot(root, abs string) bool {
	return strings.EqualFold(abs, root) || strings.HasPrefix(strings.ToLower(abs), strings.ToLower(root)+string(os.PathSeparator))
}

// checkRealContainment 要求解析符号链接后的真实目标仍在根内（spec 故事 32）。
//
// 根与目标都按真实位置比较；目标还不存在（新建文件）时取最深的已存在祖先解析，再拼回剩余部分，
// 这样根内的链接指向根外也会被拒。
func checkRealContainment(root, abs string) error {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		// 根都还不存在：根内不可能已有链接，词法检查已够。
		return nil
	}
	realAbs, err := evalExisting(abs)
	if err != nil {
		return err
	}
	if !withinRoot(filepath.Clean(realRoot), filepath.Clean(realAbs)) {
		return fmt.Errorf("路径经符号链接越出数据根：%s", abs)
	}
	return nil
}

// evalExisting 解析路径的真实位置：目标不存在时找到最深的已存在祖先解析，再拼回其余部分。
func evalExisting(path string) (string, error) {
	p := filepath.Clean(path)
	var rest []string
	for {
		if _, err := os.Lstat(p); err == nil {
			real, err := filepath.EvalSymlinks(p)
			if err != nil {
				return "", err
			}
			for i := len(rest) - 1; i >= 0; i-- {
				real = filepath.Join(real, rest[i])
			}
			return real, nil
		} else if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(p)
		if parent == p {
			return "", fmt.Errorf("路径不存在：%s", path)
		}
		rest = append(rest, filepath.Base(p))
		p = parent
	}
}

// ReadBoard 读画板的主文件、备份与内容版本；画板不存在时返回空值而不报错。
func (s *Store) ReadBoard(path string) (BoardTexts, error) {
	abs, err := s.Resolve(path)
	if err != nil {
		return BoardTexts{}, err
	}
	main, err := os.ReadFile(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return BoardTexts{}, nil
		}
		return BoardTexts{}, err
	}
	texts := BoardTexts{Main: ptr(string(main)), Version: ptr(hashOf(main))}
	if bak, err := os.ReadFile(abs + ".bak"); err == nil {
		texts.Bak = ptr(string(bak))
	}
	return texts, nil
}

// WriteOptions 是写画板的约定：version 非空表示内容版本已变则拒绝，createOnly 表示只新建。
type WriteOptions struct {
	Version    string `json:"version"`
	CreateOnly bool   `json:"create_only"`
}

// WriteBoard 写画板：原子落盘，覆盖前把旧主文件留成 .bak（只留读得出 JSON 的那份）。
//
// 只新建（createOnly）：主文件或只剩 .bak 的孤儿占住名字都拒绝。
// 带版本：主文件不在就说画板没了（不凭空建出同名画板），内容变了就是冲突。
func (s *Store) WriteBoard(path, text string, opts WriteOptions) Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	abs, err := s.Resolve(path)
	if err != nil {
		return fail(KindInvalid, err.Error())
	}
	// 归档画板只读：本机存储层也拒绝写入，界面判定不是唯一防线。
	if s.withinArchiveDir(abs) {
		return fail(KindArchived, "归档画板只读，不能写入")
	}
	old, readErr := os.ReadFile(abs)
	exists := readErr == nil
	if readErr != nil && !os.IsNotExist(readErr) {
		return fail(KindFailed, readErr.Error())
	}
	if opts.CreateOnly {
		if exists {
			return fail(KindAlreadyExist, "目标已存在，只新建不覆盖")
		}
		if _, err := os.Stat(abs + ".bak"); err == nil {
			return fail(KindAlreadyExist, "目标已存在，只新建不覆盖")
		}
		// 画板位由本机存储执行：新建、复制、导入都走只新建这条，抢位时也拦得住。
		used, err := s.editableBoardCount()
		if err != nil {
			return fail(KindFailed, err.Error())
		}
		if used >= BoardSlots {
			return fail(KindSlotsFull, fmt.Sprintf("画板位已满（%d/%d），归档或删掉一块再新建。", used, BoardSlots))
		}
	}
	if opts.Version != "" {
		if !exists {
			return fail(KindMissing, "画板不存在，可能已在别处改名或删除")
		}
		if hashOf(old) != opts.Version {
			return fail(KindConflict, "画板已在别处修改")
		}
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return fail(KindFailed, err.Error())
	}
	if exists && isJSON(old) {
		_ = writeAtomic(abs+".bak", old)
	}
	if err := writeAtomic(abs, []byte(text)); err != nil {
		return fail(KindFailed, err.Error())
	}
	return ok(hashOf([]byte(text)))
}

// CreateBoard 在画板目录里新建一块画板：文件名由标题派生（重名加 (2)），
// 只新建不覆盖已有画板。返回画板路径与结局（成功时带内容版本）。
func (s *Store) CreateBoard(title, text string) (string, Result) {
	existing, err := s.ListBoardNames(s.BoardDir())
	if err != nil {
		return "", fail(KindFailed, err.Error())
	}
	path := filepath.Join(s.BoardDir(), BoardFileName(title, existing))
	result := s.WriteBoard(path, text, WriteOptions{CreateOnly: true})
	if !result.OK {
		return "", result
	}
	return path, result
}

// ListBoardNames 列出目录里的画板文件名，保留扩展名
// （只剩 .bak 的孤儿也算一块画板，主文件与它的 .bak 是同一块，列一次）。
func (s *Store) ListBoardNames(dir string) ([]string, error) {
	abs, err := s.Resolve(dir)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}
	names := []string{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		main := strings.TrimSuffix(e.Name(), ".bak")
		if strings.HasSuffix(main, BoardExt) {
			names = append(names, main)
		}
	}
	sort.Strings(names)
	return dedupe(names), nil
}

// List 列出画板目录与归档目录里的画板，以及画板位与体量提醒线。
func (s *Store) List() (BoardListing, error) {
	listing := BoardListing{
		Boards:    []BoardEntry{},
		Slots:     Slots{Total: BoardSlots},
		SizeLines: SizeLines{Warn: 500 << 20, Alert: 1024 << 20},
	}
	for _, spec := range []struct {
		dir      string
		archived bool
	}{
		{s.BoardDir(), false},
		{filepath.Join(s.BoardDir(), ArchiveDir), true},
	} {
		names, err := s.ListBoardNames(spec.dir)
		if err != nil {
			continue
		}
		for _, name := range names {
			full := filepath.Join(spec.dir, name)
			listing.Boards = append(listing.Boards, BoardEntry{
				Name:     name,
				Path:     s.rel(full),
				Archived: spec.archived,
				Bytes:    s.bodySize(full),
			})
			if !spec.archived {
				listing.Slots.Used++
			}
		}
	}
	return listing, nil
}

// bodySize 量一块画板的体量（#158）：引用的任务目录与独立图片各计一次，主文件读不懂时按 .bak 算。
// 主文件与备份都读不懂时为 nil —— 体量未知，不当成 0，也不等同于按内容去重后的画板包大小。
func (s *Store) bodySize(abs string) *int64 {
	text := func(path string) *string {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		value := string(data)
		return &value
	}
	return boardmeasure.BoardBytes(s.root, text(abs), text(abs+".bak"))
}

// RenameBoard 改画板名：主文件与 .bak 一起搬；目标已存在（含只剩 .bak 的孤儿）则拒绝。
// 带版本：内容已变就说画板已在别处改过，原地不动。
func (s *Store) RenameBoard(from, to string, version string) Result {
	src, err := s.Resolve(from)
	if err != nil {
		return fail(KindInvalid, err.Error())
	}
	dst, err := s.Resolve(to)
	if err != nil {
		return fail(KindInvalid, err.Error())
	}
	if !s.exists(src) {
		return fail(KindMissing, "画板不存在")
	}
	if version != "" {
		if got := s.checkVersion(src, version); !got.OK {
			return got
		}
	}
	if s.exists(dst) {
		return fail(KindAlreadyExist, "目标已存在")
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fail(KindFailed, err.Error())
	}
	if err := moveBoard(src, dst); err != nil {
		return fail(KindFailed, err.Error())
	}
	return ok("")
}

// ArchiveBoard 把可编辑画板搬进归档目录：带版本时内容已变就拒绝；归档后只读、不占画板位。
// 主文件与 .bak 一起搬；任一步失败都尽力回滚，绝不把半完成的搬移报成成功。
func (s *Store) ArchiveBoard(from, to, version string) Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	src, err := s.Resolve(from)
	if err != nil {
		return fail(KindInvalid, err.Error())
	}
	dst, err := s.Resolve(to)
	if err != nil {
		return fail(KindInvalid, err.Error())
	}
	if s.withinArchiveDir(src) {
		return fail(KindArchived, "画板已归档")
	}
	if !s.withinArchiveDir(dst) {
		return fail(KindInvalid, "归档目标必须在归档目录里")
	}
	if !s.exists(src) {
		return fail(KindMissing, "画板不存在")
	}
	if version != "" {
		if got := s.checkVersion(src, version); !got.OK {
			return got
		}
	}
	if s.exists(dst) {
		return fail(KindAlreadyExist, "归档目标已存在")
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fail(KindFailed, err.Error())
	}
	if err := moveBoard(src, dst); err != nil {
		return fail(KindFailed, err.Error())
	}
	return ok("")
}

// UnarchiveBoard 把归档画板搬回画板目录：可编辑画板位满时拒绝，归档原件不动。
// 归档画板不会在归档期间被改写，因此不需要再核对内容版本。
func (s *Store) UnarchiveBoard(from, to string) Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	src, err := s.Resolve(from)
	if err != nil {
		return fail(KindInvalid, err.Error())
	}
	dst, err := s.Resolve(to)
	if err != nil {
		return fail(KindInvalid, err.Error())
	}
	if !s.withinArchiveDir(src) {
		return fail(KindInvalid, "源画板不在归档目录里")
	}
	if !s.withinBoardDir(dst) {
		return fail(KindInvalid, "取消归档目标必须在画板目录里")
	}
	if !s.exists(src) {
		return fail(KindMissing, "归档画板不存在")
	}
	used, err := s.editableBoardCount()
	if err != nil {
		return fail(KindFailed, err.Error())
	}
	if used >= BoardSlots {
		return fail(KindSlotsFull, fmt.Sprintf("画板位已满（%d/%d），先归档或删掉一块再取消归档。", used, BoardSlots))
	}
	if s.exists(dst) {
		return fail(KindAlreadyExist, "目标已存在")
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fail(KindFailed, err.Error())
	}
	if err := moveBoard(src, dst); err != nil {
		return fail(KindFailed, err.Error())
	}
	return ok("")
}

// RemoveBoard 删画板：主文件与 .bak 移进回收区（可恢复），不是抹掉。
// 带版本：内容已变就拒绝，画板留在原地。
func (s *Store) RemoveBoard(path string, version string) Result {
	abs, err := s.Resolve(path)
	if err != nil {
		return fail(KindInvalid, err.Error())
	}
	if !s.exists(abs) {
		return fail(KindMissing, "画板不存在")
	}
	if version != "" {
		if got := s.checkVersion(abs, version); !got.OK {
			return got
		}
	}
	recycle := filepath.Join(s.Root(), RecycleDir)
	if err := os.MkdirAll(recycle, 0o755); err != nil {
		return fail(KindFailed, err.Error())
	}
	base := filepath.Base(abs)
	target := filepath.Join(recycle, base)
	for i := 2; ; i++ {
		if _, err := os.Stat(target); err != nil {
			break
		}
		target = filepath.Join(recycle, fmt.Sprintf("%s (%d)", base, i))
	}
	if err := os.Rename(abs, target); err != nil {
		return fail(KindFailed, err.Error())
	}
	if bak, err := os.Stat(abs + ".bak"); err == nil && !bak.IsDir() {
		_ = os.Rename(abs+".bak", target+".bak")
	}
	return ok("")
}

// ReadFile 读数据根里的文件字节。
func (s *Store) ReadFile(path string) ([]byte, error) {
	abs, err := s.Resolve(path)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(abs)
}

// WriteNewFile 写新文件：目标已存在就拒绝（不覆盖）。
func (s *Store) WriteNewFile(path string, data []byte) Result {
	abs, err := s.Resolve(path)
	if err != nil {
		return fail(KindInvalid, err.Error())
	}
	if _, err := os.Stat(abs); err == nil {
		return fail(KindAlreadyExist, "目标已存在，只新建不覆盖")
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return fail(KindFailed, err.Error())
	}
	if err := writeAtomic(abs, data); err != nil {
		return fail(KindFailed, err.Error())
	}
	return ok("")
}

// IsFile 报告路径是不是一个文件。
func (s *Store) IsFile(path string) bool {
	abs, err := s.Resolve(path)
	if err != nil {
		return false
	}
	info, err := os.Stat(abs)
	return err == nil && !info.IsDir()
}

// ListDir 列目录里的项；目录不存在返回空。
func (s *Store) ListDir(path string) ([]DirEntry, error) {
	abs, err := s.Resolve(path)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return []DirEntry{}, nil
		}
		return nil, err
	}
	out := []DirEntry{}
	for _, e := range entries {
		out = append(out, DirEntry{Name: e.Name(), IsDir: e.IsDir()})
	}
	return out, nil
}

// Sha256 返回文件的 sha256（小写十六进制）。
func (s *Store) Sha256(path string) (string, error) {
	data, err := s.ReadFile(path)
	if err != nil {
		return "", err
	}
	return hashOf(data), nil
}

// ReadMeta 读元数据文本；文件不存在返回空串。
func (s *Store) ReadMeta(name string) (string, error) {
	data, err := os.ReadFile(s.MetaPath(name))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(data), nil
}

// WriteMeta 写元数据文本（原子）。
func (s *Store) WriteMeta(name, text string) Result {
	path := s.MetaPath(name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fail(KindFailed, err.Error())
	}
	if err := writeAtomic(path, []byte(text)); err != nil {
		return fail(KindFailed, err.Error())
	}
	return ok("")
}

// editableBoardCount 是可编辑画板数：画板目录顶层的主文件与 .bak 孤儿各算一块，同一块只算一次。
// 归档子目录由 ListBoardNames 跳过，因此归档画板不占画板位。
func (s *Store) editableBoardCount() (int, error) {
	names, err := s.ListBoardNames(s.BoardDir())
	if err != nil {
		return 0, err
	}
	return len(names), nil
}

// withinArchiveDir 报告路径是不是画板目录下的归档子目录（含更深层）。
func (s *Store) withinArchiveDir(abs string) bool {
	return withinRoot(filepath.Join(s.BoardDir(), ArchiveDir), filepath.Clean(abs))
}

// withinBoardDir 报告路径是不是可编辑画板目录里的顶层画板（归档子目录除外）。
func (s *Store) withinBoardDir(abs string) bool {
	return withinRoot(s.BoardDir(), filepath.Clean(abs)) && !s.withinArchiveDir(abs)
}

// moveBoard 把主文件与 .bak 一起搬：备份搬失败时尽力把主文件搬回原处。
// 只在调用方确认目标不存在、版本匹配后调用。
func moveBoard(src, dst string) error {
	hadMain := isRegularFile(src)
	if hadMain {
		if err := os.Rename(src, dst); err != nil {
			return err
		}
	}
	if isRegularFile(src + ".bak") {
		if err := os.Rename(src+".bak", dst+".bak"); err != nil {
			if hadMain {
				_ = os.Rename(dst, src)
			}
			return err
		}
	}
	return nil
}

// isRegularFile 报告路径是不是一个真实文件（目录与不存在的都不算）。
func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// exists 报告画板在不在：主文件或只剩 .bak 的孤儿都算在。
func (s *Store) exists(abs string) bool {
	if _, err := os.Stat(abs); err == nil {
		return true
	}
	if _, err := os.Stat(abs + ".bak"); err == nil {
		return true
	}
	return false
}

// checkVersion 核对画板内容版本：主文件不在或内容已变都拒绝（画板已在别处改动）。
func (s *Store) checkVersion(abs, version string) Result {
	old, err := os.ReadFile(abs)
	if err != nil {
		return fail(KindConflict, "画板已在别处修改")
	}
	if hashOf(old) != version {
		return fail(KindConflict, "画板已在别处修改")
	}
	return ok("")
}

// dedupe 去掉重复项（排序后同名的挨在一起）。
func dedupe(names []string) []string {
	out := names[:0]
	for i, n := range names {
		if i > 0 && n == names[i-1] {
			continue
		}
		out = append(out, n)
	}
	return out
}

// rel 把绝对路径写成相对数据根的正斜杠路径；根目录外的保留绝对路径。
func (s *Store) rel(abs string) string {
	root := filepath.Clean(s.Root())
	if strings.HasPrefix(strings.ToLower(abs), strings.ToLower(root)+string(os.PathSeparator)) {
		return filepath.ToSlash(strings.TrimPrefix(abs, root+string(os.PathSeparator)))
	}
	return filepath.ToSlash(abs)
}

// writeAtomic 先写同目录临时文件再改名：成功只看见完整内容，失败不留半截文件。
func writeAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// hashOf 是文件字节的 sha256（小写十六进制）。
func hashOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// isJSON 判断是不是读得出的 JSON（留 .bak 备份的前提）。
func isJSON(data []byte) bool {
	var v any
	return json.Unmarshal(data, &v) == nil
}

func ptr[T any](v T) *T { return &v }
