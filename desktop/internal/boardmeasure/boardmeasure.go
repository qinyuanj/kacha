// Package boardmeasure 量一块画板的体量（#158）：画板文件引用了哪些任务目录与独立图片，
// 以及每个条目多少字节。
//
// 口径与词表里的画板体量一致：一块画板引用的任务目录与独立图片的总字节，同一任务目录在这块画板内
// 只计一次；它不按节点数计，也不等于按内容去重后的画板包大小。
//
// 认引用的两种写法与清理（usageservice）同一套约定（ADR 0018）：<日期>/<task_id>/… 的相对路径，
// 以及任务编号里带的 UTC 日期。区别在粒度：这里逐节点归因（阶段体量与「收掉未定稿」预计减少量要它），
// 清理那边整份画板扫一遍（多认只会少清理）。读不懂的节点在这边按保守扫描，多认只影响体量。
package boardmeasure

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// BoardFormatVersion 是读得懂的画板格式版本上限（与前端 BOARD_FORMAT_VERSION 一致）。
// 2 加入的阶段与定稿都不带来新的引用，规则不变。
const BoardFormatVersion = 2

var (
	dateDir    = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	taskIDHead = regexp.MustCompile(`^([0-9]{4})([0-9]{2})([0-9]{2})T[0-9]{6}Z-`)
	// 读不懂的节点里按整串认出的任务编号（保守扫描）。
	taskIDAnywhere = regexp.MustCompile(`^([0-9]{4})([0-9]{2})([0-9]{2})T[0-9]{6}Z-[0-9a-fA-F]{8}$`)
)

// TaskDirOfRelPath 报告相对数据根的路径（正斜杠）是否落在 <日期>/<task_id>/… 里，是则返回任务目录。
func TaskDirOfRelPath(rel string) (string, bool) {
	parts := strings.Split(rel, "/")
	if len(parts) < 3 || !dateDir.MatchString(parts[0]) || parts[1] == "" {
		return "", false
	}
	return parts[0] + "/" + parts[1], true
}

// TaskDirOfTaskID 由任务编号开头的 UTC 时间戳还原任务目录；不是本工具生成的编号时报 false。
func TaskDirOfTaskID(taskID string) (string, bool) {
	c := taskIDHead.FindStringSubmatch(taskID)
	if c == nil {
		return "", false
	}
	return c[1] + "-" + c[2] + "-" + c[3] + "/" + taskID, true
}

// NodeRef 是一个节点引用的条目（任务目录或独立图片，相对数据根、正斜杠）。
type NodeRef struct {
	// ID 是节点 id；读不懂、没有 id 的节点为空（其引用仍计入画板体量）。
	ID    string
	Items []string
}

// Measure 是一块画板的度量：节点 → 引用的条目，条目 → 字节数。
type Measure struct {
	// Nodes 只列引用非空的节点。
	Nodes map[string][]string `json:"nodes"`
	// Dirs 是画板引用的每个条目 → 字节数；引用但不在盘上的条目记 0。
	Dirs map[string]int64 `json:"dirs"`
}

// Total 是画板体量：引用的各条目字节之和（同一目录只算一次）。
func (m Measure) Total() int64 {
	total := int64(0)
	for _, n := range m.Dirs {
		total += n
	}
	return total
}

// refs 收集一个节点的引用。
type refs struct{ items map[string]bool }

func (r *refs) add(item string) {
	if item != "" {
		r.items[item] = true
	}
}

// addPath 认一个路径字段：落在任务目录里就是那个目录，否则是这个文件本身。
func (r *refs) addPath(v any) {
	s, ok := v.(string)
	if !ok {
		return
	}
	rel, ok := relPath(s)
	if !ok {
		return
	}
	if dir, ok := TaskDirOfRelPath(rel); ok {
		r.add(dir)
		return
	}
	r.add(rel)
}

func (r *refs) addTaskID(v any) {
	if s, ok := v.(string); ok {
		if dir, ok := TaskDirOfTaskID(s); ok {
			r.add(dir)
		}
	}
}

// addDeep 读不懂的节点：其中像任务目录或任务编号的整串都算引用（保守）。
func (r *refs) addDeep(v any) {
	switch x := v.(type) {
	case string:
		if rel, ok := relPath(x); ok {
			if dir, ok := TaskDirOfRelPath(rel); ok {
				r.add(dir)
			}
		}
		if taskIDAnywhere.MatchString(x) {
			r.addTaskID(x)
		}
	case []any:
		for _, item := range x {
			r.addDeep(item)
		}
	case map[string]any:
		for _, item := range x {
			r.addDeep(item)
		}
	}
}

// addTaskNode 任务节点：上次提交的任务编号、按份数展开的各份、以及各张图的身份与路径。
func (r *refs) addTaskNode(obj map[string]any) {
	last, ok := obj["last_submitted"].(map[string]any)
	if !ok {
		return
	}
	r.addTaskID(last["task_id"])
	if ids, ok := last["copy_task_ids"].([]any); ok {
		for _, id := range ids {
			r.addTaskID(id)
		}
	}
	if images, ok := last["images"].([]any); ok {
		for _, image := range images {
			if m, ok := image.(map[string]any); ok {
				r.addTaskID(m["task_id"])
				r.addPath(m["path"])
			}
		}
	}
}

func (r *refs) addNode(node any) {
	obj, ok := node.(map[string]any)
	if !ok {
		r.addDeep(node)
		return
	}
	switch obj["type"] {
	case "prompt":
	case "reference":
		r.addPath(obj["path"])
	case "result":
		r.addPath(obj["path"])
		r.addTaskID(obj["task_id"])
	case "task":
		r.addTaskNode(obj)
	default:
		r.addDeep(node)
	}
}

func sorted(items map[string]bool) []string {
	out := make([]string, 0, len(items))
	for item := range items {
		out = append(out, item)
	}
	sort.Strings(out)
	return out
}

// NodeRefs 逐个节点收集引用；ok 为 false 表示画板读不懂（损坏 / 版本更高），不能当成没有引用。
func NodeRefs(text string) ([]NodeRef, bool) {
	var raw any
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		return nil, false
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil, false
	}
	version, ok := obj["format_version"].(float64)
	if !ok || version != float64(int64(version)) || version < 1 || version > BoardFormatVersion {
		return nil, false
	}
	nodes, ok := obj["nodes"].([]any)
	if !ok {
		return nil, false
	}
	out := make([]NodeRef, 0, len(nodes))
	for _, node := range nodes {
		collected := &refs{items: map[string]bool{}}
		collected.addNode(node)
		id := ""
		if o, ok := node.(map[string]any); ok {
			id, _ = o["id"].(string)
		}
		out = append(out, NodeRef{ID: id, Items: sorted(collected.items)})
	}
	return out, true
}

// MeasureBoard 量一块画板：每个节点引用的条目，以及每个条目的字节数（不存在记 0）。
// 画板读不懂时 ok 为 false，调用方应把体量显示为未知，而不是 0。
func MeasureBoard(root, text string) (Measure, bool) {
	nodeRefs, ok := NodeRefs(text)
	if !ok {
		return Measure{}, false
	}
	m := Measure{Nodes: map[string][]string{}, Dirs: map[string]int64{}}
	for _, node := range nodeRefs {
		for _, item := range node.Items {
			if _, seen := m.Dirs[item]; !seen {
				m.Dirs[item] = bytesOf(root, item)
			}
		}
		if node.ID != "" && len(node.Items) > 0 {
			m.Nodes[node.ID] = node.Items
		}
	}
	return m, true
}

// BoardBytes 量一块画板文件的体量：主文件读不懂时按备份算（与打开画板时的回退一致），
// 都读不懂时返回 nil —— 体量未知，不当成 0。
func BoardBytes(root string, main, bak *string) *int64 {
	for _, text := range []*string{main, bak} {
		if text == nil {
			continue
		}
		if m, ok := MeasureBoard(root, *text); ok {
			total := m.Total()
			return &total
		}
	}
	return nil
}

// bytesOf 量一个条目的字节数：目录按其中各文件长度累加，文件按自身长度；读不到记 0。
func bytesOf(root, item string) int64 {
	abs, ok := resolveInside(root, item)
	if !ok {
		return 0
	}
	return treeBytes(abs)
}

// treeBytes 累加一个条目下所有文件的字节数；符号链接不跟（不把根外的字节算进来）。
func treeBytes(path string) int64 {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		return 0
	}
	if !info.IsDir() {
		return info.Size()
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return 0
	}
	total := int64(0)
	for _, entry := range entries {
		total += treeBytes(filepath.Join(path, entry.Name()))
	}
	return total
}

// relPath 把画板里的路径写法折成相对数据根的正斜杠路径；越界（.. 或根外绝对路径）时报 false。
func relPath(p string) (string, bool) {
	slashed := strings.ReplaceAll(p, "\\", "/")
	if slashed == "" || strings.HasPrefix(slashed, "//") || (len(slashed) > 1 && slashed[1] == ':') {
		return "", false
	}
	for _, part := range strings.Split(slashed, "/") {
		if part == ".." {
			return "", false
		}
	}
	cleaned := filepath.ToSlash(filepath.Clean(filepath.FromSlash(slashed)))
	if cleaned == "" || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", false
	}
	return cleaned, true
}

// resolveInside 把条目折成数据根内的绝对路径；越界时报 false，不顺着画板文件读盘。
func resolveInside(root, item string) (string, bool) {
	rel, ok := relPath(item)
	if !ok {
		return "", false
	}
	abs := filepath.Join(root, filepath.FromSlash(rel))
	cleanRoot, cleanAbs := filepath.Clean(root), filepath.Clean(abs)
	if !strings.EqualFold(cleanAbs, cleanRoot) && !strings.HasPrefix(strings.ToLower(cleanAbs), strings.ToLower(cleanRoot)+string(os.PathSeparator)) {
		return "", false
	}
	return abs, true
}
