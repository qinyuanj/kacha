// Package diagnostics 是脱敏诊断采集与导出（#162）。
//
// 允许清单决定采集项：只生成版本、平台、运行状态与脱敏日志这几类派生事实，
// 不打包凭据文件、设置原文、画板或创作内容。所有文本在写入内存前都按
// 「已知秘密精确替换 + 敏感字段整值替换 + Bearer 模式替换」处理，
// 因此明文密钥不进日志、不进诊断包，也不出现在包内文件名里。
package diagnostics

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

const (
	// 容量上限：日志条数、单字段字节、字段个数与整包字节都有界，采集不会拖垮界面或占满磁盘。
	maxLogEntries  = 200
	maxFieldCount  = 24
	maxFieldBytes  = 2048
	maxBundleBytes = 4 << 20
	// 见过的密钥个数上限：密钥换得再频繁，记住的旧值也有界。
	maxSeenSecrets = 8
	// 落盘日志的字节上限：文件超过它就从头重写，容量有界。
	maxLogFileBytes = 1 << 20
	redacted        = "[REDACTED]"
)

var (
	// 字段名命中即整值替换，不依赖值长什么样。
	sensitiveField = regexp.MustCompile(`(?i)(authorization|api[-_]?key|token|secret|password|credential)`)
	// 鉴权头里的 Bearer 串即使字段名没命中也要遮掉。
	bearerToken = regexp.MustCompile(`(?i)(bearer\s+)\S+`)
	// 主机名与本机绝对路径不属于排障事实：即便调用方误写进日志也不带出去。
	windowsPath = regexp.MustCompile(`[A-Za-z]:[\\/][^\s，。；,;]+`)
	uncPath     = regexp.MustCompile(`\\[^\s，。；,;]+`)
	unixPath    = regexp.MustCompile(`(^|[\s(（])(/(?:Users|home|tmp|var|mnt)/[^\s，。；,;]+)`)
)

// logFileName 是落盘脱敏日志的文件名：固定常量，不含用户内容，也不含任何秘密。
const logFileName = "diagnostics.log.jsonl"

// saveDialog 弹系统「另存为」对话框；测试替换掉，不弹窗。
var saveDialog = func(opts mygo.SaveDialogOptions) (string, error) { return mygo.Dialog.Save(opts) }

// Outcome 是导出的类型化结局：ok / cancelled / failed，界面只按 kind 分支。
type Outcome struct {
	OK      bool   `json:"ok"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Bytes   int64  `json:"bytes"`
}

// logEntry 是一条已经脱敏的日志；字段按名字排序，输出稳定可比对。
type logEntry struct {
	At     string            `json:"at"`
	Kind   string            `json:"kind"`
	Fields map[string]string `json:"fields"`
}

// Service 持有受保护的日志缓冲与当前秘密的读法；不缓存秘密明文。
type Service struct {
	version string
	root    string
	// roots 是可切换的数据根（迁移 #161）：装了它，日志跟着新位置写。
	roots   *dataroot.Roots
	secrets func() []string

	mu      sync.Mutex
	logs    []logEntry
	dropped int
	// seenSecrets 记着这个进程见过的密钥值（只用于把同值从文本里替换掉）。
	// 密钥被替换或清除后旧值读不到了，但旧值可能已经出现在早先的日志里，
	// 记着它才能保证后来的导出也不泄漏。
	seenSecrets []string
}

// New 用应用版本、数据根与「读当前秘密」的回调造服务；回调只在脱敏时调用。
func New(version, root string, secrets func() []string) *Service {
	return &Service{version: version, root: root, secrets: orNone(secrets)}
}

// NewFollowing 造一个跟着共享数据根走的服务：迁移切换后日志写到新位置。
func NewFollowing(version string, roots *dataroot.Roots, secrets func() []string) *Service {
	return &Service{version: version, roots: roots, secrets: orNone(secrets)}
}

// orNone 让 nil 回调也能安全调用。
func orNone(secrets func() []string) func() []string {
	if secrets == nil {
		return func() []string { return nil }
	}
	return secrets
}

// Root 返回当前数据根。
func (s *Service) Root() string {
	if s.roots != nil {
		return s.roots.Current()
	}
	return s.root
}

// truncate 把过长文本截断并留下痕迹，避免一条日志把整包撑大。
// 按字符截断（不切碎 UTF-8 字符），免得中文日志出现半个字。
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	runes := []rune(s)
	if len(runes) > max {
		runes = runes[:max]
	}
	return string(runes) + "...(truncated)"
}

// redact 对一段即将落进包里的文本做三层脱敏：
// 当前密钥、本进程见过的旧密钥（替换或清除后仍要遮）、以及鉴权头里的 Bearer 串。
func (s *Service) redact(text string) string {
	if host, err := os.Hostname(); err == nil && host != "" {
		text = strings.ReplaceAll(text, host, redacted)
	}
	text = windowsPath.ReplaceAllString(text, redacted)
	text = uncPath.ReplaceAllString(text, redacted)
	text = unixPath.ReplaceAllString(text, "1"+redacted)
	for _, secret := range s.knownSecrets() {
		if secret != "" {
			text = strings.ReplaceAll(text, secret, redacted)
		}
	}
	text = bearerToken.ReplaceAllString(text, "${1}"+redacted)
	return truncate(text, maxFieldBytes)
}

// knownSecrets 给出当前密钥与见过的旧密钥；调用方必须已持有 s.mu。
func (s *Service) knownSecrets() []string {
	current := s.secrets()
	for _, secret := range current {
		if secret == "" {
			continue
		}
		known := false
		for _, seen := range s.seenSecrets {
			if seen == secret {
				known = true
				break
			}
		}
		if !known {
			s.seenSecrets = append(s.seenSecrets, secret)
			if len(s.seenSecrets) > maxSeenSecrets {
				s.seenSecrets = s.seenSecrets[len(s.seenSecrets)-maxSeenSecrets:]
			}
		}
	}
	out := make([]string, 0, len(current)+len(s.seenSecrets))
	out = append(out, current...)
	out = append(out, s.seenSecrets...)
	return out
}

// Log 收一条结构化日志：字段名敏感就整值替换，否则对值脱敏；容量满了丢最旧的一条。
// 调用方（shell/ui.log）只传类别与小字段，不传提示词、图片、创作内容或密钥。
func (s *Service) Log(kind string, fields map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.logs) >= maxLogEntries {
		copy(s.logs, s.logs[1:])
		s.logs = s.logs[:len(s.logs)-1]
		s.dropped++
	}
	safe := make(map[string]string)
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if len(safe) >= maxFieldCount {
			s.dropped++
			continue
		}
		name := truncate(k, 128)
		if sensitiveField.MatchString(name) {
			safe[name] = redacted
			continue
		}
		safe[name] = s.redact(fields[k])
	}
	s.logs = append(s.logs, logEntry{
		At:     time.Now().UTC().Format(time.RFC3339),
		Kind:   truncate(kind, 128),
		Fields: safe,
	})
	s.appendToFile(logEntry{At: s.logs[len(s.logs)-1].At, Kind: truncate(kind, 128), Fields: safe})
}

// appendToFile 把一条脱敏日志追加到数据根下的日志文件：内容已脱敏，文件大小有界。
func (s *Service) appendToFile(entry logEntry) {
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	path := filepath.Join(s.Root(), logFileName)
	// 文件已超上限时先截断重来，保证容量有界（内容都是脱敏后的旧日志）。
	if info, statErr := os.Stat(path); statErr == nil && info.Size() >= maxLogFileBytes {
		_ = os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	_, _ = f.Write(append(line, '\n'))
}

// readFileLogs 读回落盘的脱敏日志；文件不存在返回空。
func (s *Service) readFileLogs() []logEntry {
	data, err := os.ReadFile(filepath.Join(s.Root(), logFileName))
	if err != nil {
		return nil
	}
	entries := []logEntry{}
	for _, line := range bytes.Split(data, []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var entry logEntry
		if err := json.Unmarshal(line, &entry); err != nil {
			continue
		}
		entries = append(entries, entry)
	}
	return entries
}

// collector 是允许清单里的一项：名字即包内文件名（固定常量，不含用户提供的内容），
// collect 只产出派生的可核对事实；任何一项失败都让导出明确失败，不用空包冒充。
type collector struct {
	name    string
	limit   int
	collect func() ([]byte, error)
}

// allowlist 是本服务唯一会写进包的文件集合；没有第四条路径能把别的文件带进来。
func (s *Service) allowlist() []collector {
	return []collector{
		{name: "diagnostics.json", limit: 64 << 10, collect: s.collectFacts},
		{name: "logs.jsonl", limit: 1 << 20, collect: s.collectLogs},
		{name: "README.txt", limit: 8 << 10, collect: collectReadme},
	}
}

// collectFacts 生成版本、平台与运行状态；凭据与画板只报存在与计数，不报内容与路径。
func (s *Service) collectFacts() ([]byte, error) {
	info, err := os.Stat(s.Root())
	if err != nil {
		return nil, fmt.Errorf("数据根不可读: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("数据根不是目录")
	}
	count := 0
	entries, err := os.ReadDir(filepath.Join(s.Root(), localstore.BoardsDir))
	if err == nil {
		for _, e := range entries {
			if !e.IsDir() && !strings.HasSuffix(e.Name(), ".bak") {
				count++
			}
		}
	}
	s.mu.Lock()
	hasSecret := len(s.knownSecrets()) > 0
	s.mu.Unlock()
	facts := map[string]any{
		"version": s.version,
		"platform": map[string]string{
			"os":   runtime.GOOS,
			"arch": runtime.GOARCH,
			"go":   runtime.Version(),
		},
		"runtime": map[string]any{
			"credential_present": hasSecret,
			"board_count":        count,
			"boards_readable":    err == nil,
		},
		"captured_at":  time.Now().UTC().Format(time.RFC3339),
		"dropped_logs": s.dropped,
		"redaction":    "sensitive fields, known secrets and bearer tokens are replaced with " + redacted,
	}
	data, err := json.MarshalIndent(facts, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("序列化诊断事实失败: %w", err)
	}
	return append(data, '\n'), nil
}

// collectLogs 输出已脱敏的日志快照：落盘的那份是唯一真源（重启后仍可排障），
// 内存里还没落盘成功的那些补在后面（写盘失败时至少不丢这次会话的日志）。
// 同一条日志不会出现两次：内存里的条目按内容去重后再合并。
func (s *Service) collectLogs() ([]byte, error) {
	s.mu.Lock()
	snapshot := make([]logEntry, len(s.logs))
	copy(snapshot, s.logs)
	s.mu.Unlock()

	entries := s.readFileLogs()
	seen := make(map[string]bool, len(entries))
	for _, entry := range entries {
		seen[entryKey(entry)] = true
	}
	for _, entry := range snapshot {
		key := entryKey(entry)
		if seen[key] {
			continue
		}
		seen[key] = true
		entries = append(entries, entry)
	}
	if len(entries) > maxLogEntries {
		entries = entries[len(entries)-maxLogEntries:]
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	for _, entry := range entries {
		if err := enc.Encode(entry); err != nil {
			return nil, fmt.Errorf("序列化日志失败: %w", err)
		}
	}
	return buf.Bytes(), nil
}

// entryKey 是日志条目的去重键：时间、类别与字段合起来足以区分两条记录。
func entryKey(entry logEntry) string {
	fields := make([]string, 0, len(entry.Fields))
	for name, value := range entry.Fields {
		fields = append(fields, name+"="+value)
	}
	sort.Strings(fields)
	return entry.At + "|" + entry.Kind + "|" + strings.Join(fields, ",")
}

func collectReadme() ([]byte, error) {
	return []byte("Kacha 诊断包（脱敏）\n\n" +
		"diagnostics.json：版本、平台与运行状态；凭据只报是否存在，画板只报数量。\n" +
		"logs.jsonl：有限条数的脱敏日志；敏感字段、已知密钥与鉴权串以 [REDACTED] 代替。\n\n" +
		"本包不包含 API 密钥、鉴权头、画板内容、任务目录或画板包。\n"), nil
}

// bundle 按允许清单在内存里打 zip；每一项都限制大小，总大小也有上限。
func (s *Service) bundle() ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	total := 0
	for _, item := range s.allowlist() {
		data, err := item.collect()
		if err != nil {
			_ = zw.Close()
			return nil, fmt.Errorf("采集 %s 失败: %w", item.name, err)
		}
		if len(data) > item.limit {
			_ = zw.Close()
			return nil, fmt.Errorf("采集 %s 超过容量上限", item.name)
		}
		total += len(data)
		if total > maxBundleBytes {
			_ = zw.Close()
			return nil, errors.New("诊断包超过容量上限")
		}
		w, err := zw.Create(item.name)
		if err != nil {
			_ = zw.Close()
			return nil, err
		}
		if _, err := w.Write(data); err != nil {
			_ = zw.Close()
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// BundleOutcome 给反馈附件用：同一份允许清单和脱敏逻辑，但只在内存里返回字节，不弹另存为。
type BundleOutcome struct {
	OK      bool   `json:"ok"`
	Kind    string `json:"kind"`
	Message string `json:"message,omitempty"`
	Name    string `json:"name"`
	Data    []byte `json:"data"`
	Bytes   int    `json:"bytes"`
}

// Bundle 为「附带脱敏诊断包」生成安全附件；失败给明确文案，不写本机文件。
func (s *Service) Bundle() BundleOutcome {
	data, err := s.bundle()
	if err != nil {
		return BundleOutcome{Kind: "failed", Message: "采集诊断信息失败：" + err.Error()}
	}
	return BundleOutcome{OK: true, Kind: "saved", Name: "diagnostics.zip", Data: data, Bytes: len(data)}
}

// Export 让用户选本机目标并写出诊断包：取消不写文件，目标不可写或采集失败都给明确结局。
func (s *Service) Export() (Outcome, error) {
	target, err := saveDialog(mygo.SaveDialogOptions{
		Title:       "导出诊断包",
		DefaultPath: "kacha-diagnostics-" + time.Now().Format("20060102-150405") + ".zip",
		Filters:     []mygo.FileFilter{{Name: "诊断包", Extensions: []string{"zip"}}},
	})
	if err != nil {
		return Outcome{}, err
	}
	if target == "" {
		return Outcome{OK: false, Kind: "cancelled", Message: "已取消导出诊断包"}, nil
	}
	data, err := s.bundle()
	if err != nil {
		return Outcome{OK: false, Kind: "failed", Message: "采集诊断信息失败：" + err.Error()}, nil
	}
	if err := os.WriteFile(target, data, 0o600); err != nil {
		return Outcome{OK: false, Kind: "failed", Message: "写入诊断包失败：" + err.Error()}, nil
	}
	return Outcome{OK: true, Bytes: int64(len(data))}, nil
}
