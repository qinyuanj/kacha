// Package usageservice 是桌面壳的本机用量、未引用清理与回收恢复服务。
//
// 只做本机文件操作，不碰界面：真实字节扫描、画板引用判定、阈值持久化与回收区都落在数据根里。
// 页面经 MyGo 的 Usage 服务调用；go test 用临时目录与注入时钟覆盖全部行为（#159）。
package usageservice

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

const (
	// LimitMetaFile 是容量提醒阈值的元数据文件（属于高级设置，不是画板）。
	LimitMetaFile = "usage-limit.json"
	// RetentionDays 是清理内容在本机回收区的保留天数。
	RetentionDays = 14

	KindInvalid  = "invalid"
	KindFailed   = "failed"
	KindMissing  = "missing"
	KindConflict = "alreadyExists"

	// recycleTasksDir 是任务目录清理后的本机回收区；既有画板回收区仍在 回收区/ 下。
	recycleTasksDir = "回收区/任务目录"
	recycleSidecar  = ".kacha-recycle.json"
	manifestFile    = "usage-recycle.json"
)

// Outcome 与 localservice.Outcome 同形：页面按 ok / kind / message 分支。
type Outcome struct {
	OK      bool   `json:"ok"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

func ok() Outcome { return Outcome{OK: true} }

func failed(kind, message string) Outcome { return Outcome{Kind: kind, Message: message} }

// DateBytes 是一天里全部任务目录的字节和。
type DateBytes struct {
	Date  string `json:"date"`
	Bytes int64  `json:"bytes"`
}

// Candidate 是一个未引用任务目录的预览项。
type Candidate struct {
	Dir       string `json:"dir"`
	Bytes     int64  `json:"bytes"`
	LastWrite int64  `json:"last_write"`
}

// Usage 是页面显示的真实本机用量。
type Usage struct {
	TotalBytes      int64       `json:"total_bytes"`
	BoardsBytes     int64       `json:"boards_bytes"`
	MetaBytes       int64       `json:"meta_bytes"`
	LastAccess      int64       `json:"last_access"`
	ByDate          []DateBytes `json:"by_date"`
	Unreferenced    []Candidate `json:"unreferenced"`
	UnreadableBoard *string     `json:"unreadable_board"`
	LimitBytes      *int64      `json:"limit_bytes"`
	LimitLevel      string      `json:"limit_level"`
}

// CleanResult 是清理的结局：逐项报告，部分失败也能追溯。
type CleanResult struct {
	OK      bool        `json:"ok"`
	Kind    string      `json:"kind"`
	Message string      `json:"message"`
	Moved   []Candidate `json:"moved"`
	Skipped []string    `json:"skipped"`
	Failed  []string    `json:"failed"`
}

// Service 是页面能调用的本机用量能力。
type Service struct {
	store *localstore.Store
	now   func() time.Time
}

// New 造一个用系统时钟的服务。
func New(store *localstore.Store) *Service {
	return NewWithClock(store, time.Now)
}

// NewWithClock 注入时钟，让 14 天保留期在测试里可控。
func NewWithClock(store *localstore.Store, now func() time.Time) *Service {
	return &Service{store: store, now: now}
}

var dateDir = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// dirStat 是一个目录里所有普通文件的字节和与最近修改时间（秒）。
type dirStat struct {
	bytes int64
	last  int64
}

func statDir(root string) (dirStat, error) {
	out := dirStat{}
	info, err := os.Stat(root)
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if !info.IsDir() {
		out.bytes = info.Size()
		out.last = info.ModTime().Unix()
		return out, nil
	}
	err = filepath.WalkDir(root, func(_ string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		out.bytes += info.Size()
		if t := info.ModTime().Unix(); t > out.last {
			out.last = t
		}
		return nil
	})
	return out, err
}

// taskDirs 列出数据根下全部 `<UTC 日期>/<任务编号>` 任务目录及其体量。
func (s *Service) taskDirs() (map[string]dirStat, error) {
	out := map[string]dirStat{}
	top, err := os.ReadDir(s.store.Root())
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	for _, d := range top {
		if !d.IsDir() || !dateDir.MatchString(d.Name()) {
			continue
		}
		day := filepath.Join(s.store.Root(), d.Name())
		children, err := os.ReadDir(day)
		if err != nil {
			return nil, err
		}
		for _, c := range children {
			if !c.IsDir() || strings.HasPrefix(c.Name(), ".") || c.Type()&os.ModeSymlink != 0 {
				continue
			}
			abs := filepath.Join(day, c.Name())
			stat, err := statDir(abs)
			if err != nil {
				return nil, err
			}
			out[d.Name()+"/"+c.Name()] = stat
		}
	}
	return out, err
}

// RecycleEntry 是用户可操作的回收区一行：保留原位置、清理时间与到期状态。
type RecycleEntry struct {
	ID        string `json:"id"`
	Dir       string `json:"dir"`
	Bytes     int64  `json:"bytes"`
	CleanedAt int64  `json:"cleaned_at"`
	Location  string `json:"location"`
	Expired   bool   `json:"expired"`
}

type recycleRecord struct {
	ID        string `json:"id"`
	Dir       string `json:"dir"`
	Bytes     int64  `json:"bytes"`
	CleanedAt int64  `json:"cleaned_at"`
	Location  string `json:"location"`
}

type recycleManifest struct {
	Format  int             `json:"format_version"`
	Next    int             `json:"next"`
	Entries []recycleRecord `json:"entries"`
}

var taskPathRef = regexp.MustCompile(`(\d{4}-\d{2}-\d{2})[\\/]([^\\/" ]+)`)
var taskIDRef = regexp.MustCompile(`(\d{4})(\d{2})(\d{2})T\d{6}Z-[0-9a-fA-F]{8}`)

// relPath 把绝对路径写成相对数据根的正斜杠路径，供提示与记录使用。
func relPath(root, abs string) string {
	r, a := filepath.Clean(root), filepath.Clean(abs)
	if strings.HasPrefix(strings.ToLower(a), strings.ToLower(r)+string(os.PathSeparator)) {
		return filepath.ToSlash(a[len(r)+1:])
	}
	return filepath.ToSlash(a)
}

// collectRefs 从画板 JSON 里收出被引用的任务目录。任务目录的两种写法（相对路径与 task_id）
// 都按数据根约定识别；多认不算危险（只会少清理），漏认才会误删。
func collectRefs(v any, refs map[string]bool) {
	switch x := v.(type) {
	case map[string]any:
		for _, value := range x {
			collectRefs(value, refs)
		}
	case []any:
		for _, value := range x {
			collectRefs(value, refs)
		}
	case string:
		for _, m := range taskPathRef.FindAllStringSubmatch(x, -1) {
			refs[m[1]+"/"+m[2]] = true
		}
		for _, m := range taskIDRef.FindAllStringSubmatch(x, -1) {
			refs[m[1]+"-"+m[2]+"-"+m[3]+"/"+m[0]] = true
		}
	}
}

// references 扫描可编辑与归档画板；任何相关文件读不出来时给出阻断原因，不返回半份引用表。
func (s *Service) references() (map[string]bool, *string, error) {
	refs := map[string]bool{}
	for _, dir := range []string{s.store.BoardDir(), filepath.Join(s.store.BoardDir(), localstore.ArchiveDir)} {
		entries, err := os.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			rel := relPath(s.store.Root(), dir)
			return refs, &rel, nil
		}
		for _, e := range entries {
			if e.IsDir() || e.Type()&os.ModeSymlink != 0 || !strings.HasSuffix(e.Name(), localstore.BoardExt) || strings.HasSuffix(e.Name(), ".bak") {
				continue
			}
			abs := filepath.Join(dir, e.Name())
			data, err := os.ReadFile(abs)
			if err != nil {
				rel := relPath(s.store.Root(), abs)
				return refs, &rel, nil
			}
			var parsed any
			if err := json.Unmarshal(data, &parsed); err != nil {
				rel := relPath(s.store.Root(), abs)
				return refs, &rel, nil
			}
			collectRefs(parsed, refs)
		}
	}
	return refs, nil, nil
}

// saveManifest 原子写回收清单；清单丢了也能从每个目录里的 sidecar 重建。
func (s *Service) saveManifest(m recycleManifest) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if out := s.store.WriteMeta(manifestFile, string(data)); !out.OK {
		return errors.New(out.Message)
	}
	return nil
}

// loadManifest 读清单并补齐只落在磁盘上的记录：中途失败或重启后仍能追溯。
func (s *Service) loadManifest() recycleManifest {
	m := recycleManifest{Format: 1, Entries: []recycleRecord{}}
	if text, err := s.store.ReadMeta(manifestFile); err == nil && text != "" {
		_ = json.Unmarshal([]byte(text), &m)
	}
	if m.Format != 1 {
		m.Format, m.Entries = 1, []recycleRecord{}
	}
	seen := map[string]bool{}
	for _, r := range m.Entries {
		seen[r.ID] = true
	}
	base, err := s.store.Resolve(recycleTasksDir)
	if err != nil {
		return m
	}
	dirs, err := os.ReadDir(base)
	if err != nil {
		return m
	}
	changed := false
	for _, d := range dirs {
		if !d.IsDir() || seen[d.Name()] {
			continue
		}
		data, err := os.ReadFile(filepath.Join(base, d.Name(), recycleSidecar))
		if err != nil {
			continue
		}
		var r recycleRecord
		if err := json.Unmarshal(data, &r); err != nil || r.Dir == "" {
			continue
		}
		r.ID, r.Location = d.Name(), recycleTasksDir+"/"+d.Name()
		m.Entries, seen[d.Name()] = append(m.Entries, r), true
		changed = true
	}
	if changed {
		_ = s.saveManifest(m)
	}
	return m
}

func (s *Service) expired(r recycleRecord) bool {
	return s.now().Sub(time.Unix(r.CleanedAt, 0)) >= RetentionDays*24*time.Hour
}

// writeAtomic 在同目录写临时文件再改名：清单与 sidecar 不会留下半截 JSON。
func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// moveToRecycle 把一份可靠未引用的任务目录移进回收区，并同时留下可重建的 sidecar。
func (s *Service) moveToRecycle(dir string, stat dirStat, m *recycleManifest) (Candidate, error) {
	m.Next++
	id := fmt.Sprintf("r%06d", m.Next)
	location := recycleTasksDir + "/" + id
	src, err := s.store.Resolve(dir)
	if err != nil {
		return Candidate{}, err
	}
	dst, err := s.store.Resolve(location)
	if err != nil {
		return Candidate{}, err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return Candidate{}, err
	}
	if err := os.Rename(src, dst); err != nil {
		return Candidate{}, err
	}
	record := recycleRecord{ID: id, Dir: dir, Bytes: stat.bytes, CleanedAt: s.now().Unix(), Location: location}
	side, _ := json.Marshal(record)
	if err := writeAtomic(filepath.Join(dst, recycleSidecar), side); err != nil {
		return Candidate{}, err
	}
	m.Entries = append(m.Entries, record)
	if err := s.saveManifest(*m); err != nil {
		return Candidate{}, err
	}
	return Candidate{Dir: dir, Bytes: stat.bytes, LastWrite: stat.last}, nil
}

// Cleanup 只处理执行时仍可靠未引用的任务目录；预览里的清单不构成授权。
func (s *Service) Cleanup(dirs []string) CleanResult {
	result := CleanResult{OK: true, Moved: []Candidate{}, Skipped: []string{}, Failed: []string{}}
	refs, unreadable, err := s.references()
	if err != nil {
		result.OK, result.Kind, result.Message = false, KindFailed, err.Error()
		return result
	}
	if unreadable != nil {
		result.OK, result.Kind = false, KindInvalid
		result.Message = "画板读不懂（" + *unreadable + "），拒绝清理"
		return result
	}
	tasks, err := s.taskDirs()
	if err != nil {
		result.OK, result.Kind, result.Message = false, KindFailed, err.Error()
		return result
	}
	m := s.loadManifest()
	for _, dir := range dirs {
		stat, exists := tasks[dir]
		if !exists || refs[dir] {
			result.Skipped = append(result.Skipped, dir)
			continue
		}
		candidate, err := s.moveToRecycle(dir, stat, &m)
		if err != nil {
			result.Failed = append(result.Failed, dir)
			result.Message = "部分目录未能移入回收区"
			continue
		}
		result.Moved = append(result.Moved, candidate)
	}
	return result
}

// Recycle 列出回收区条目；到期与否按注入时钟判定，14 天内绝不提前删除。
func (s *Service) Recycle() []RecycleEntry {
	out := []RecycleEntry{}
	for _, r := range s.loadManifest().Entries {
		out = append(out, RecycleEntry{
			ID: r.ID, Dir: r.Dir, Bytes: r.Bytes, CleanedAt: r.CleanedAt, Location: r.Location, Expired: s.expired(r),
		})
	}
	return out
}

func (s *Service) findRecord(id string) (recycleManifest, int) {
	m := s.loadManifest()
	for i, r := range m.Entries {
		if r.ID == id {
			return m, i
		}
	}
	return m, -1
}

// Restore 把一份内容恢复到原位置；原位置已有内容时拒绝，绝不覆盖。
func (s *Service) Restore(id string) Outcome {
	m, idx := s.findRecord(id)
	if idx < 0 {
		return failed(KindMissing, "回收区里没有这一项")
	}
	r := m.Entries[idx]
	if s.expired(r) {
		return failed(KindInvalid, "已超过 "+strconv.Itoa(RetentionDays)+" 天保留期，不能恢复")
	}
	src, err := s.store.Resolve(r.Location)
	if err != nil {
		return failed(KindInvalid, err.Error())
	}
	target, err := s.store.Resolve(r.Dir)
	if err != nil {
		return failed(KindInvalid, err.Error())
	}
	if _, err := os.Stat(target); err == nil || !errors.Is(err, os.ErrNotExist) {
		return failed(KindConflict, "原位置已有内容，未覆盖")
	}
	if info, err := os.Stat(src); err != nil || !info.IsDir() {
		return failed(KindMissing, "回收区内容缺失，条目保留待查")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return failed(KindFailed, err.Error())
	}
	if err := os.Rename(src, target); err != nil {
		return failed(KindFailed, err.Error())
	}
	_ = os.Remove(filepath.Join(target, recycleSidecar))
	m.Entries = append(m.Entries[:idx], m.Entries[idx+1:]...)
	if err := s.saveManifest(m); err != nil {
		return failed(KindFailed, err.Error())
	}
	return ok()
}

// PurgeExpired 只清理用户确认过的期满项；未到期内容与画板、归档都不碰。
func (s *Service) PurgeExpired() Outcome {
	m := s.loadManifest()
	kept := []recycleRecord{}
	purged := 0
	for _, r := range m.Entries {
		if !s.expired(r) {
			kept = append(kept, r)
			continue
		}
		abs, err := s.store.Resolve(r.Location)
		if err != nil || os.RemoveAll(abs) != nil {
			kept = append(kept, r)
			continue
		}
		purged++
	}
	m.Entries = kept
	if err := s.saveManifest(m); err != nil {
		return failed(KindFailed, err.Error())
	}
	return Outcome{OK: true, Message: fmt.Sprintf("已清理 %d 个期满项", purged)}
}

// Usage 扫描数据根，给出真实字节、任务目录体量与持久化的提醒档位。
func (s *Service) Usage() (Usage, error) {
	u := Usage{ByDate: []DateBytes{}, Unreferenced: []Candidate{}}
	root, err := statDir(s.store.Root())
	if err != nil {
		return u, err
	}
	boards, err := statDir(s.store.BoardDir())
	if err != nil {
		return u, err
	}
	tasks, err := s.taskDirs()
	if err != nil {
		return u, err
	}
	u.TotalBytes, u.BoardsBytes, u.LastAccess = root.bytes, boards.bytes, root.last
	byDate := map[string]int64{}
	taskBytes := int64(0)
	names := make([]string, 0, len(tasks))
	for name := range tasks {
		names = append(names, name)
	}
	sort.Strings(names)
	refs, unreadable, err := s.references()
	if err != nil {
		return u, err
	}
	u.UnreadableBoard = unreadable
	if unreadable != nil {
		u.Unreferenced = nil
	}
	for _, name := range names {
		stat := tasks[name]
		byDate[strings.Split(name, "/")[0]] += stat.bytes
		taskBytes += stat.bytes
		if unreadable == nil && !refs[name] {
			u.Unreferenced = append(u.Unreferenced, Candidate{Dir: name, Bytes: stat.bytes, LastWrite: stat.last})
		}
	}
	for date, bytes := range byDate {
		u.ByDate = append(u.ByDate, DateBytes{Date: date, Bytes: bytes})
	}
	sort.Slice(u.ByDate, func(i, j int) bool { return u.ByDate[i].Date < u.ByDate[j].Date })
	u.MetaBytes = u.TotalBytes - u.BoardsBytes - taskBytes
	if u.MetaBytes < 0 {
		u.MetaBytes = 0
	}
	u.LimitBytes, u.LimitLevel = s.limit(u.TotalBytes)
	return u, nil
}

// limit 读本机持久化的阈值并算提醒档位；阈值只提醒，不参与任何生成判定。
func (s *Service) limit(total int64) (*int64, string) {
	text, err := s.store.ReadMeta(LimitMetaFile)
	if err != nil || text == "" {
		return nil, ""
	}
	var raw struct {
		LimitBytes int64 `json:"limit_bytes"`
	}
	if err := json.Unmarshal([]byte(text), &raw); err != nil || raw.LimitBytes <= 0 {
		return nil, ""
	}
	limit := raw.LimitBytes
	if total >= limit {
		return &limit, "alert"
	}
	warn := limit / 10 * 8
	if total >= warn {
		return &limit, "warn"
	}
	return &limit, ""
}

// SetLimit 保存容量提醒阈值（字节）；0 表示清除。任何值都不阻止生成。
func (s *Service) SetLimit(bytes int64) Outcome {
	if bytes < 0 {
		return failed("invalid", "容量提醒阈值不能为负数")
	}
	text := ""
	if bytes > 0 {
		text = fmt.Sprintf(`{"limit_bytes":%d}`, bytes)
	}
	if out := s.store.WriteMeta(LimitMetaFile, text); !out.OK {
		return failed(out.Kind, out.Message)
	}
	return ok()
}
