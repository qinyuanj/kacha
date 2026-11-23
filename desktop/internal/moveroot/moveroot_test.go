package moveroot

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
)

// write 在数据根里造一个文件（含父目录）。
func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("建目录 %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("写 %s: %v", path, err)
	}
}

// read 读回文件内容，读不到就让测试失败。
func read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 %s: %v", path, err)
	}
	return string(data)
}

// 迁移把数据根的内容整份搬到新位置，切换状态记录后重启回到新位置，旧位置原样保留。
func TestMigrateCopiesDataAndSwitchesRoot(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "appdata", "shell-state.json")
	source := filepath.Join(base, "data")
	target := filepath.Join(base, "D盘", "kacha-data")

	files := map[string]string{
		filepath.Join("画板", "未命名画板.ugcboard.json"):       `{"format_version":2}`,
		filepath.Join("画板", "归档", "旧画板.ugcboard.json"):   `{"format_version":2,"title":"旧"}`,
		filepath.Join("2026-09-16", "t1", "result.png"):  "PNG-BYTES",
		filepath.Join("2026-09-16", "t1", "record.json"): `{"task_id":"t1"}`,
		filepath.Join("导入参考图", "abc.png"):                "REF-BYTES",
		filepath.Join(".kacha", "settings.json"):         `{"format_version":1,"base_url":"http://lzxsvn:3001"}`,
		"api-key.protected":                              "DPAPI-BLOB",
	}
	for rel, body := range files {
		write(t, filepath.Join(source, rel), body)
	}
	// 状态文件先记着旧位置：迁移要把它改成新位置。
	if _, err := dataroot.Resolve(statePath, source); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	report, err := Migrate(source, target, statePath, nil)
	if err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if report.Files != len(files) {
		t.Fatalf("迁移文件数 = %d, want %d", report.Files, len(files))
	}

	// 重启：状态记录指向新位置，于是启动读到的是新位置。
	got, err := dataroot.Resolve(statePath, filepath.Join(base, "默认位置"))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != target {
		t.Fatalf("重启后的数据根 = %q, want %q", got, target)
	}

	// 新位置里每个文件逐字节一致。
	for rel, want := range files {
		if body := read(t, filepath.Join(target, rel)); body != want {
			t.Fatalf("%s = %q, want %q", rel, body, want)
		}
	}

	// 旧位置仍可用：内容没被搬走也没被删。
	for rel, want := range files {
		if body := read(t, filepath.Join(source, rel)); body != want {
			t.Fatalf("旧位置 %s = %q, want %q", rel, body, want)
		}
	}
}

// 目标已有内容时拒绝迁移：不覆盖目标里的任何东西，状态记录与两端内容都不动。
func TestMigrateRefusesNonEmptyTarget(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "appdata", "shell-state.json")
	source := filepath.Join(base, "data")
	target := filepath.Join(base, "已用过的位置")
	write(t, filepath.Join(source, "画板", "a.ugcboard.json"), "A")
	write(t, filepath.Join(target, "别人的文件.txt"), "别人的内容")
	if _, err := dataroot.Resolve(statePath, source); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	_, err := Migrate(source, target, statePath, nil)
	if err == nil {
		t.Fatal("目标非空时应当拒绝迁移")
	}
	if got := KindOf(err); got != KindNotEmpty {
		t.Fatalf("失败类别 = %q, want %q（%v）", got, KindNotEmpty, err)
	}
	if body := read(t, filepath.Join(target, "别人的文件.txt")); body != "别人的内容" {
		t.Fatalf("目标里的内容被改动了：%q", body)
	}
	if _, statErr := os.Stat(filepath.Join(target, "画板", "a.ugcboard.json")); statErr == nil {
		t.Fatal("被拒绝的迁移不应往目标里写任何东西")
	}
	assertRootStill(t, statePath, source)
}

// 目标就是当前数据根、或与它互相包含时拒绝：搬进去会把自己也搬走。
func TestMigrateRefusesNestedAndSameRoot(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "appdata", "shell-state.json")
	source := filepath.Join(base, "data")
	write(t, filepath.Join(source, "画板", "a.ugcboard.json"), "A")
	if _, err := dataroot.Resolve(statePath, source); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	for name, target := range map[string]string{
		"同一位置":   source,
		"源里的子目录": filepath.Join(source, "子目录"),
		"源的上级目录": base,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Migrate(source, target, statePath, nil)
			if err == nil {
				t.Fatalf("%s 应当被拒绝", name)
			}
			want := KindNested
			if name == "同一位置" {
				want = KindSameRoot
			}
			if got := KindOf(err); got != want {
				t.Fatalf("失败类别 = %q, want %q（%v）", got, want, err)
			}
			assertRootStill(t, statePath, source)
		})
	}
}

// 复制中途失败时旧位置仍是生效的数据根，目标不留下半份内容。
func TestMigrateFailureKeepsOldRoot(t *testing.T) {
	base := t.TempDir()
	statePath := filepath.Join(base, "appdata", "shell-state.json")
	source := filepath.Join(base, "data")
	target := filepath.Join(base, "新位置")
	write(t, filepath.Join(source, "画板", "a.ugcboard.json"), "A")
	write(t, filepath.Join(source, "导入参考图", "b.png"), "B")
	if _, err := dataroot.Resolve(statePath, source); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	// 用户在看到第一份复制完之后取消：这份已写进目标的内容要清掉。
	// 取消点必须落在复制之后，否则目标里从来没有过半份内容，清理分支也就没有任何证明。
	cancelled := false
	progresses := 0
	_, err := Migrate(source, target, statePath, &Options{
		Progress: func(p Progress) {
			progresses++
			cancelled = p.Done == 1
		},
		Cancelled: func() bool { return cancelled },
	})
	if err == nil {
		t.Fatal("取消时应当返回失败")
	}
	if got := KindOf(err); got != KindCancelled {
		t.Fatalf("失败类别 = %q, want %q（%v）", got, KindCancelled, err)
	}
	if progresses != 1 {
		t.Fatalf("进度回调 %d 次，want 1：取消要发生在第 1 份复制完成之后", progresses)
	}
	assertRootStill(t, statePath, source)
	entries, readErr := os.ReadDir(target)
	if readErr != nil {
		t.Fatalf("取消后目标目录读不出来：%v", readErr)
	}
	if len(entries) != 0 {
		t.Fatalf("取消后目标里还留着 %d 项", len(entries))
	}
}

// assertRootStill 断言状态记录仍指向 want，且启动解析出来还是它。
func assertRootStill(t *testing.T, statePath, want string) {
	t.Helper()
	got, err := dataroot.Resolve(statePath, filepath.Join(filepath.Dir(statePath), "默认位置"))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != want {
		t.Fatalf("数据根 = %q, want %q", got, want)
	}
}
