package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
	"github.com/qinyuanj/kacha/desktop/internal/localstore"
	"github.com/qinyuanj/kacha/desktop/internal/shellapp"
	"github.com/qinyuanj/kacha/desktop/internal/storage"
)

// writeFile 在数据根里造一个文件（含父目录）。
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("建目录 %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("写 %s: %v", path, err)
	}
}

// 真实临时数据根上的一次完整迁移（#161）：画板、任务目录、导入参考图与设置整份搬走，
// 绑定给页面的服务跟着换到新位置；旧位置的内容不动，切换前它就是唯一数据来源。
func TestMigrationMovesRealDataAndServices(t *testing.T) {
	base := t.TempDir()
	userData := filepath.Join(base, "appdata")
	statePath := dataroot.StatePath(userData)
	source, err := dataroot.Resolve(statePath, defaultRoot(userData))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	writeFile(t, filepath.Join(source, "画板", "a.ugcboard.json"), `{"format_version":2,"title":"甲"}`)
	writeFile(t, filepath.Join(source, "画板", "归档", "b.ugcboard.json"), `{"format_version":2,"title":"乙"}`)
	writeFile(t, filepath.Join(source, "2026-09-16", "t1", "record.json"), `{"model":"m"}`)
	writeFile(t, filepath.Join(source, "导入参考图", "cat.png"), "PNG")
	writeFile(t, filepath.Join(source, ".kacha", "settings.json"), `{"format_version":1,"base_url":"http://gw:3001"}`)
	writeFile(t, filepath.Join(source, ".kacha", "ui-state.json"), `{"open_boards":["`+filepath.ToSlash(filepath.Join(source, "画板", "a.ugcboard.json"))+`"],"active_board":null}`)
	writeFile(t, filepath.Join(source, "api-key.protected"), "PROTECTED-BLOB")

	roots := dataroot.NewRoots(source)
	store := localstore.NewFollowing(roots)
	shell := shellapp.NewFollowing("1.6.0", roots)
	svc := storage.New(roots, statePath)
	target := filepath.Join(base, "新位置")

	out := svc.Move(target)
	if !out.OK {
		t.Fatalf("迁移失败：%+v", out)
	}
	// 7 份：两块画板、一份任务记录、一张导入参考图、两份元数据、一份受保护密钥。
	if out.Files != 7 {
		t.Fatalf("迁移文件数 = %d, want 7", out.Files)
	}

	// 服务跟着换位置：壳信息报新根，画板目录与元数据都落到新位置。
	info, err := shell.Info()
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if info.UserDataRoot != target {
		t.Fatalf("数据根 = %q, want %q", info.UserDataRoot, target)
	}
	if body, err := os.ReadFile(filepath.Join(target, ".kacha", "settings.json")); err != nil || string(body) == "" {
		t.Fatalf("设置没搬到新位置：%q, %v", body, err)
	}
	if store.Root() != target {
		t.Fatalf("本地存储还在 %q", store.Root())
	}
	// 凭据整份复制过去：同一份密钥文件，不因换位置而失效。
	if body, err := os.ReadFile(filepath.Join(target, "api-key.protected")); err != nil || string(body) != "PROTECTED-BLOB" {
		t.Fatalf("密钥文件 = %q, %v", body, err)
	}

	// 重启：状态记录指向新位置，启动解析读回同一份。
	restarted, err := dataroot.Resolve(statePath, defaultRoot(userData))
	if err != nil {
		t.Fatalf("重启 Resolve: %v", err)
	}
	if restarted != target {
		t.Fatalf("重启后数据根 = %q, want %q", restarted, target)
	}

	// 旧位置不是唯一数据来源，也不会被半份内容顶掉：旧位置整份还在。
	if body, err := os.ReadFile(filepath.Join(source, "画板", "a.ugcboard.json")); err != nil || string(body) == "" {
		t.Fatalf("旧位置的画板被动了：%q, %v", body, err)
	}
}

// 换根之后旧位置的绝对路径越界：页面不可能再把写入落到旧位置（#161 的路径边界）。
func TestMigrationRejectsWritesToOldRoot(t *testing.T) {
	base := t.TempDir()
	userData := filepath.Join(base, "appdata")
	statePath := dataroot.StatePath(userData)
	source, err := dataroot.Resolve(statePath, defaultRoot(userData))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	writeFile(t, filepath.Join(source, "画板", "a.ugcboard.json"), `{"format_version":2}`)
	roots := dataroot.NewRoots(source)
	store := localstore.NewFollowing(roots)
	target := filepath.Join(base, "新位置")
	if out := storage.New(roots, statePath).Move(target); !out.OK {
		t.Fatalf("迁移失败：%+v", out)
	}

	old := filepath.Join(source, "画板", "a.ugcboard.json")
	if _, err := store.Resolve(old); err == nil {
		t.Fatal("旧位置的路径应当越界")
	}
	if out := store.WriteBoard(old, "{}", localstore.WriteOptions{}); out.OK {
		t.Fatal("旧位置的画板不该还能写")
	}
}
