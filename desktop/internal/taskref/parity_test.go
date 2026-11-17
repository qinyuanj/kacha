package taskref_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/boardmeasure"
	"github.com/qinyuanj/kacha/desktop/internal/taskref"
)

// 与前端 client/src/core/taskDir.ts 共用的夹具：同一批用例两边都要给同一个答案。
// 规则只写在 taskref 里，前端是另一个实现，靠这份夹具对齐（ADR 0010）。
type parityFixture struct {
	Paths []struct {
		Rel     string  `json:"rel"`
		TaskDir *string `json:"task_dir"`
	} `json:"paths"`
	TaskIDs []struct {
		TaskID  string  `json:"task_id"`
		TaskDir *string `json:"task_dir"`
	} `json:"task_ids"`
	Boards []struct {
		Name     string          `json:"name"`
		Board    json.RawMessage `json:"board"`
		TaskDirs []string        `json:"task_dirs"`
	} `json:"boards"`
}

func loadParityFixture(t *testing.T) parityFixture {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "task-dir-refs.json"))
	if err != nil {
		t.Fatalf("读夹具失败: %v", err)
	}
	var f parityFixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("解析夹具失败: %v", err)
	}
	if len(f.Paths) == 0 || len(f.TaskIDs) == 0 || len(f.Boards) == 0 {
		t.Fatalf("夹具是空的：%s", filepath.Join("contracts", "task-dir-refs.json"))
	}
	return f
}

// 相对路径 → 任务目录的规则与前端一致。
func TestPathRulesMatchClientFixture(t *testing.T) {
	for _, c := range loadParityFixture(t).Paths {
		dir, ok := taskref.TaskDirOfRelPath(c.Rel)
		if c.TaskDir == nil {
			if ok {
				t.Fatalf("%q 不该认出任务目录，得到 %q", c.Rel, dir)
			}
			continue
		}
		if !ok || dir != *c.TaskDir {
			t.Fatalf("%q 的任务目录 = %q（%v），want %q", c.Rel, dir, ok, *c.TaskDir)
		}
	}
}

// 任务编号 → 任务目录的规则与前端一致。
func TestTaskIDRulesMatchClientFixture(t *testing.T) {
	for _, c := range loadParityFixture(t).TaskIDs {
		dir, ok := taskref.TaskDirOfTaskID(c.TaskID)
		if c.TaskDir == nil {
			if ok {
				t.Fatalf("%q 不该认出任务目录，得到 %q", c.TaskID, dir)
			}
			continue
		}
		if !ok || dir != *c.TaskDir {
			t.Fatalf("%q 的任务目录 = %q（%v），want %q", c.TaskID, dir, ok, *c.TaskDir)
		}
	}
}

// 同一批画板 JSON：Go 侧（体量度量用的逐节点认引用）与前端（导出计划）认出的任务目录必须一样。
func TestBoardTaskDirsMatchClientFixture(t *testing.T) {
	for _, c := range loadParityFixture(t).Boards {
		refs, ok := boardmeasure.NodeRefs(string(c.Board))
		if !ok {
			t.Fatalf("%s：读不懂这块画板", c.Name)
		}
		seen := map[string]bool{}
		for _, node := range refs {
			for _, item := range node.Items {
				if taskref.IsTaskDir(item) {
					seen[item] = true
				}
			}
		}
		got := make([]string, 0, len(seen))
		for dir := range seen {
			got = append(got, dir)
		}
		sort.Strings(got)
		want := append([]string{}, c.TaskDirs...)
		sort.Strings(want)
		if len(got) != len(want) {
			t.Fatalf("%s：Go 侧认出 %v，夹具（与前端一致）是 %v", c.Name, got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("%s：Go 侧认出 %v，夹具（与前端一致）是 %v", c.Name, got, want)
			}
		}
	}
}

// 整串是任务编号的保守识别（读不懂的节点用）：只认完整的 <时间戳>-<8 位十六进制>。
func TestIsTaskIDRequiresTheWholeForm(t *testing.T) {
	for _, id := range []string{"20260101T000000Z-aaaaaaaa", "20260916T091500Z-3f9c2a1b"} {
		if !taskref.IsTaskID(id) {
			t.Fatalf("%q 应当是任务编号", id)
		}
	}
	for _, text := range []string{"", "not-a-task", "20260101T000000Z-aaaaaaa", "前缀 20260101T000000Z-aaaaaaaa", "20260101T00000Z-aaaaaaaa"} {
		if taskref.IsTaskID(text) {
			t.Fatalf("%q 不是任务编号", text)
		}
	}
}

// 文本里出现的任务目录（相对路径与任务编号两种写法）都要认出来：清理那边宁可多认。
func TestTaskDirsInTextFindsBothForms(t *testing.T) {
	text := "2026-01-01/20260101T000000Z-aaaaaaaa/result.png 与 20260102T000000Z-bbbbbbbb 都在"
	got := taskref.TaskDirsInText(text)
	want := []string{"2026-01-01/20260101T000000Z-aaaaaaaa", "2026-01-02/20260102T000000Z-bbbbbbbb"}
	sort.Strings(got)
	if len(got) != len(want) {
		t.Fatalf("TaskDirsInText = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("TaskDirsInText = %v, want %v", got, want)
		}
	}
	if got := taskref.TaskDirsInText("导入参考图/cccc.png"); len(got) != 0 {
		t.Fatalf("导入参考图不该被认成任务目录：%v", got)
	}
}
