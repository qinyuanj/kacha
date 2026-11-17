// Package taskref 认任务目录与它的引用写法（ADR 0010）：数据根/<UTC 日期>/<任务编号>/…。
//
// 规则只有这一份：体量度量、未引用清理、导入与导出都经这里认任务目录，
// 免得几处各写一套正则后对同一块画板给出不同答案。
// 前端 client/src/core/taskDir.ts 是同一套规则的另一个实现，两边用
// contracts/task-dir-refs.json 的同一批用例对齐（见 parity_test.go）。
package taskref

import (
	"regexp"
	"sort"
	"strings"
)

var (
	// dateDir 是任务目录的第一层：UTC 日期目录。
	dateDir = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	// taskIDHead 是任务编号开头的 UTC 时间戳：<YYYYMMDD>T<HHMMSS>Z-。
	taskIDHead = regexp.MustCompile(`^([0-9]{4})([0-9]{2})([0-9]{2})T[0-9]{6}Z-`)
	// taskIDWhole 是整串就是任务编号：<时间戳>-<8 位十六进制>。
	taskIDWhole = regexp.MustCompile(`^([0-9]{4})([0-9]{2})([0-9]{2})T[0-9]{6}Z-[0-9a-fA-F]{8}$`)
	// textTaskPath 在一段文本里找 `<日期>/<名字>` 写法（保守扫描用）。
	textTaskPath = regexp.MustCompile(`([0-9]{4}-[0-9]{2}-[0-9]{2})[\\/]([^\\/" ]+)`)
	// textTaskID 在一段文本里找任务编号（保守扫描用）。
	textTaskID = regexp.MustCompile(`([0-9]{4})([0-9]{2})([0-9]{2})T[0-9]{6}Z-[0-9a-fA-F]{8}`)
)

// TaskDirOfRelPath 报告相对数据根的路径（正斜杠）是否落在 <日期>/<任务编号>/… 里，是则返回任务目录。
func TaskDirOfRelPath(rel string) (string, bool) {
	parts := strings.Split(rel, "/")
	if len(parts) < 3 || !dateDir.MatchString(parts[0]) || parts[1] == "" {
		return "", false
	}
	return parts[0] + "/" + parts[1], true
}

// IsTaskDir 报告 rel 本身就是一个任务目录（<日期>/<任务编号>）：导入导出按这个粒度处理。
func IsTaskDir(rel string) bool {
	parts := strings.Split(rel, "/")
	return len(parts) == 2 && dateDir.MatchString(parts[0]) && parts[1] != ""
}

// TaskDirOfTaskID 由任务编号开头的 UTC 时间戳还原任务目录；不是本工具生成的编号时报 false。
func TaskDirOfTaskID(taskID string) (string, bool) {
	c := taskIDHead.FindStringSubmatch(taskID)
	if c == nil {
		return "", false
	}
	return c[1] + "-" + c[2] + "-" + c[3] + "/" + taskID, true
}

// IsTaskID 报告整串是不是任务编号（<时间戳>-<8 位十六进制>）：读不懂的节点按这个保守认。
func IsTaskID(text string) bool {
	return taskIDWhole.MatchString(text)
}

// TaskDirsInText 在一段文本里找任务目录：路径写法与任务编号写法都认。
//
// 这是保守扫描（清理未引用任务目录用）：多认只会少清理，漏认才会误删，
// 所以名字里带空格时可能截出一段，调用方不应把它当成精确解析。
func TaskDirsInText(text string) []string {
	seen := map[string]bool{}
	add := func(dir string) { seen[dir] = true }
	for _, m := range textTaskPath.FindAllStringSubmatch(text, -1) {
		add(m[1] + "/" + m[2])
	}
	for _, m := range textTaskID.FindAllStringSubmatch(text, -1) {
		add(m[1] + "-" + m[2] + "-" + m[3] + "/" + m[0])
	}
	out := make([]string, 0, len(seen))
	for dir := range seen {
		out = append(out, dir)
	}
	sort.Strings(out)
	return out
}

// CollectRefs 把一份解析过的 JSON（画板文件）里出现的任务目录都收进 refs。
func CollectRefs(v any, refs map[string]bool) {
	switch x := v.(type) {
	case map[string]any:
		for _, value := range x {
			CollectRefs(value, refs)
		}
	case []any:
		for _, value := range x {
			CollectRefs(value, refs)
		}
	case string:
		for _, dir := range TaskDirsInText(x) {
			refs[dir] = true
		}
	}
}
