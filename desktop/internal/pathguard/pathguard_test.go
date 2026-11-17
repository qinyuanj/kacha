package pathguard_test

import (
	"path/filepath"
	"runtime"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/pathguard"
)

// 数据根下的一层与根外的一层要分得清：前缀相同不等于在根里。
func TestInsideRequiresADirectoryBoundary(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data")
	cases := []struct {
		name string
		path string
		want bool
	}{
		{"根内的文件", filepath.Join(root, "2026-01-01", "20260101T000000Z-aaaaaaaa", "board.json"), true},
		{"根内的直接子项", filepath.Join(root, "board.json"), true},
		{"根自己不算在里面", root, false},
		{"前缀相同的兄弟目录", root + "2" + string(filepath.Separator) + "board.json", false},
		{"根的上级", filepath.Dir(root), false},
		{"借 .. 爬出去", filepath.Join(root, "..", "other", "board.json"), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := pathguard.Inside(root, c.path); got != c.want {
				t.Fatalf("Inside(%q, %q) = %v，想要 %v", root, c.path, got, c.want)
			}
		})
	}
}

// InsideOrSame 把「等于根」也算在根内：迁移目标、数据根状态这类比较要用它。
func TestInsideOrSameCountsTheRootItself(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data")
	if !pathguard.InsideOrSame(root, root) {
		t.Fatalf("根与它自己必须是同一处")
	}
	if pathguard.Inside(root, root) {
		t.Fatalf("Inside 不把根自己算在内")
	}
	if !pathguard.InsideOrSame(root, filepath.Join(root, "a")) {
		t.Fatalf("根内的路径必须算在根内")
	}
	// 末尾多一个分隔符不该改变结论。
	if !pathguard.Inside(root+string(filepath.Separator), filepath.Join(root, "a")) {
		t.Fatalf("根末尾带分隔符时也要判对")
	}
}

// Same 只判两个路径是不是同一处。
func TestSame(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data")
	if !pathguard.Same(root, filepath.Join(root, ".")) {
		t.Fatalf("同一处必须判同一处")
	}
	if pathguard.Same(root, filepath.Join(root, "a")) {
		t.Fatalf("不同路径不能判同一处")
	}
}

// Windows 盘符与目录名大小写不敏感：同一个根的大小写写法不能判成根外。
func TestCaseInsensitiveOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("只有 Windows 的路径大小写不敏感")
	}
	root := filepath.Join(t.TempDir(), "data")
	upper := filepath.Join(filepath.Dir(root), "DATA", "Board.json")
	_ = upper
	if !pathguard.Inside(filepath.Join(filepath.Dir(root), "DATA"), filepath.Join(filepath.Dir(root), "data", "board.json")) {
		t.Fatalf("大小写不同仍是同一处根")
	}
	if !pathguard.Same(root, filepath.Join(filepath.Dir(root), "DATA")) {
		t.Fatalf("Same 也必须大小写不敏感")
	}
}
