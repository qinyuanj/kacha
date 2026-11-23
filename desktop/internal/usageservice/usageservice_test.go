package usageservice

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

func fixedClock(t time.Time) func() time.Time { return func() time.Time { return t } }

func writeAt(t *testing.T, path, data string, when time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%s): %v", path, err)
	}
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatalf("WriteFile(%s): %v", path, err)
	}
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatalf("Chtimes(%s): %v", path, err)
	}
}

func TestUsageReportsRealLocalBytesAndPersistedLimit(t *testing.T) {
	root := t.TempDir()
	when := time.Date(2026, 11, 17, 4, 5, 6, 0, time.UTC)
	board := `{"nodes":[]}`
	writeAt(t, filepath.Join(root, localstore.BoardsDir, "a.ugcboard.json"), board, when)
	writeAt(t, filepath.Join(root, "2026-11-01", "task1", "result.png"), "12345", when)
	writeAt(t, filepath.Join(root, "2026-11-01", "task1", "task.json"), "123", when)
	writeAt(t, filepath.Join(root, localstore.MetaDir, "settings.json"), "hello", when)

	svc := NewWithClock(localstore.New(root), fixedClock(when))
	u, err := svc.Usage()
	if err != nil {
		t.Fatalf("Usage: %v", err)
	}
	wantTotal := int64(len(board) + 5 + 3 + 5)
	if u.TotalBytes != wantTotal {
		t.Fatalf("total_bytes = %d, want %d", u.TotalBytes, wantTotal)
	}
	if u.BoardsBytes != int64(len(board)) {
		t.Fatalf("boards_bytes = %d, want %d", u.BoardsBytes, len(board))
	}
	if u.MetaBytes != 5 {
		t.Fatalf("meta_bytes = %d, want 5", u.MetaBytes)
	}
	if u.LastAccess != when.Unix() {
		t.Fatalf("last_access = %d, want %d", u.LastAccess, when.Unix())
	}
	if len(u.ByDate) != 1 || u.ByDate[0].Date != "2026-11-01" || u.ByDate[0].Bytes != 8 {
		t.Fatalf("by_date = %+v, want one date with 8 bytes", u.ByDate)
	}
	if u.LimitBytes != nil || u.LimitLevel != "" {
		t.Fatalf("默认不该有阈值提醒：%+v", u)
	}

	// 阈值写到本机元数据里，重启后的服务仍读得到；达到阈值只提醒，不改用量。
	if out := svc.SetLimit(wantTotal); !out.OK {
		t.Fatalf("SetLimit: %+v", out)
	}
	u, err = NewWithClock(localstore.New(root), fixedClock(when)).Usage()
	if err != nil {
		t.Fatalf("重开后 Usage: %v", err)
	}
	if u.LimitBytes == nil || *u.LimitBytes != wantTotal || u.LimitLevel != "alert" {
		t.Fatalf("达到阈值应为 alert：%+v", u)
	}
	limitData, err := os.ReadFile(filepath.Join(root, localstore.MetaDir, LimitMetaFile))
	if err != nil {
		t.Fatalf("读阈值文件: %v", err)
	}
	if u.TotalBytes != wantTotal+int64(len(limitData)) {
		t.Fatalf("用量应含阈值文件本身：%d", u.TotalBytes)
	}

	// 未到黄线不提醒；黄线按阈值的 80% 算。
	if out := svc.SetLimit(100); !out.OK {
		t.Fatalf("SetLimit(100): %+v", out)
	}
	u, _ = svc.Usage()
	if u.LimitLevel != "" {
		t.Fatalf("远低于阈值不该提醒：%q", u.LimitLevel)
	}
	if out := svc.SetLimit(50); !out.OK {
		t.Fatalf("SetLimit(50): %+v", out)
	}
	u, _ = svc.Usage()
	if u.LimitLevel != "warn" {
		t.Fatalf("达到 80%% 但未到阈值应为 warn：%q（total=%d）", u.LimitLevel, u.TotalBytes)
	}

	// 清除阈值：留空即不提醒。
	if out := svc.SetLimit(0); !out.OK {
		t.Fatalf("SetLimit(0): %+v", out)
	}
	u, _ = svc.Usage()
	if u.LimitBytes != nil || u.LimitLevel != "" {
		t.Fatalf("清除后不该提醒：%+v", u)
	}
}
func TestUsageScansEditableAndArchivedBoardReferences(t *testing.T) {
	root := t.TempDir()
	when := time.Date(2026, 11, 17, 4, 5, 6, 0, time.UTC)
	writeAt(t, filepath.Join(root, localstore.BoardsDir, "editable.ugcboard.json"),
		`{"nodes":[{"type":"result","path":"2026-11-01/task1/result.png"}]}`, when)
	archived := filepath.Join(root, localstore.BoardsDir, localstore.ArchiveDir, "old.ugcboard.json")
	writeAt(t, archived, `{"nodes":[{"last_submitted":{"task_id":"20261101T010000Z-00000002"}}]}`, when)
	for _, name := range []string{"task1", "20261101T010000Z-00000002", "orphan"} {
		writeAt(t, filepath.Join(root, "2026-11-01", name, "result.png"), "x", when)
	}
	svc := NewWithClock(localstore.New(root), fixedClock(when))
	u, err := svc.Usage()
	if err != nil {
		t.Fatalf("Usage: %v", err)
	}
	if len(u.Unreferenced) != 1 || u.Unreferenced[0].Dir != "2026-11-01/orphan" {
		t.Fatalf("可编辑与归档引用都应排除，只留真正未引用目录：%+v", u.Unreferenced)
	}

	// 任何相关画板不可靠读取：不生成候选，也拒绝执行清理。
	writeAt(t, archived, "{坏掉的画板", when)
	u, err = svc.Usage()
	if err != nil {
		t.Fatalf("Usage on unreadable: %v", err)
	}
	if u.Unreferenced != nil || u.UnreadableBoard == nil {
		t.Fatalf("不可读画板应给出阻断原因且不给候选：%+v", u)
	}
	if !strings.Contains(*u.UnreadableBoard, "old.ugcboard.json") {
		t.Fatalf("应指出不可读的画板：%q", *u.UnreadableBoard)
	}
	result := svc.Cleanup([]string{"2026-11-01/orphan"})
	if result.OK || result.Kind != "invalid" {
		t.Fatalf("不可读画板时清理应失败：%+v", result)
	}
	if _, err := os.Stat(filepath.Join(root, "2026-11-01", "orphan")); err != nil {
		t.Fatalf("拒绝清理时原目录必须还在：%v", err)
	}
}

func TestCleanupRechecksReferencesBeforeMoving(t *testing.T) {
	root := t.TempDir()
	when := time.Date(2026, 11, 17, 4, 5, 6, 0, time.UTC)
	dir := filepath.Join(root, "2026-11-01", "task1")
	writeAt(t, filepath.Join(dir, "result.png"), "x", when)
	board := filepath.Join(root, localstore.BoardsDir, "a.ugcboard.json")
	writeAt(t, board, `{"nodes":[]}`, when)
	svc := NewWithClock(localstore.New(root), fixedClock(when))

	preview, err := svc.Usage()
	if err != nil || len(preview.Unreferenced) != 1 {
		t.Fatalf("预览应看到未引用目录：%+v / %v", preview.Unreferenced, err)
	}
	// 预览之后画板新增了引用：确认执行时必须重新检查，不能照预览删。
	writeAt(t, board, `{"nodes":[{"path":"2026-11-01/task1/result.png"}]}`, when)
	result := svc.Cleanup([]string{"2026-11-01/task1"})
	if !result.OK || len(result.Moved) != 0 || len(result.Skipped) != 1 {
		t.Fatalf("新增引用后应跳过：%+v", result)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("被重新引用的目录不能移走：%v", err)
	}
}
func TestCleanupMovesToRecycleAndRestoreNeverOverwrites(t *testing.T) {
	root := t.TempDir()
	when := time.Date(2026, 11, 17, 4, 5, 6, 0, time.UTC)
	dir := "2026-11-01/task1"
	original := filepath.Join(root, filepath.FromSlash(dir))
	writeAt(t, filepath.Join(original, "result.png"), "original-bytes", when)
	writeAt(t, filepath.Join(root, localstore.BoardsDir, "a.ugcboard.json"), `{"nodes":[]}`, when)
	svc := NewWithClock(localstore.New(root), fixedClock(when))

	res := svc.Cleanup([]string{dir})
	if !res.OK || len(res.Moved) != 1 || res.Moved[0].Dir != dir {
		t.Fatalf("清理应把未引用目录移走：%+v", res)
	}
	if _, err := os.Stat(original); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("原位置不该再有该目录：%v", err)
	}
	entries := svc.Recycle()
	if len(entries) != 1 || entries[0].ID == "" || entries[0].Dir != dir || entries[0].CleanedAt != when.Unix() || entries[0].Expired {
		t.Fatalf("回收区应记录原位置与清理时间：%+v", entries)
	}
	movedFile := filepath.Join(root, filepath.FromSlash(entries[0].Location), "result.png")
	if got, err := os.ReadFile(movedFile); err != nil || string(got) != "original-bytes" {
		t.Fatalf("回收区应保留原内容：%q / %v", got, err)
	}

	// 预览之后原位置出现新内容：恢复必须报冲突，不覆盖。
	writeAt(t, filepath.Join(original, "result.png"), "new-bytes", when)
	conflict := svc.Restore(entries[0].ID)
	if conflict.OK || conflict.Kind != KindConflict {
		t.Fatalf("恢复冲突应明确拒绝：%+v", conflict)
	}
	if got, _ := os.ReadFile(filepath.Join(original, "result.png")); string(got) != "new-bytes" {
		t.Fatalf("恢复冲突不能覆盖原位置：%q", got)
	}
	if len(svc.Recycle()) != 1 {
		t.Fatalf("冲突后条目必须留在回收区，供用户处理")
	}

	// 让用户自己移走冲突内容后，恢复回到原位置。
	if err := os.RemoveAll(original); err != nil {
		t.Fatalf("移除冲突: %v", err)
	}
	if out := svc.Restore(entries[0].ID); !out.OK {
		t.Fatalf("恢复应成功：%+v", out)
	}
	if got, err := os.ReadFile(filepath.Join(original, "result.png")); err != nil || string(got) != "original-bytes" {
		t.Fatalf("恢复后内容应原样回来：%q / %v", got, err)
	}
	if len(svc.Recycle()) != 0 {
		t.Fatalf("恢复成功后条目应移出回收区")
	}
}

func TestRecycleRetentionAndPartialFailure(t *testing.T) {
	root := t.TempDir()
	when := time.Date(2026, 11, 17, 4, 5, 6, 0, time.UTC)
	archived := filepath.Join(root, localstore.BoardsDir, localstore.ArchiveDir, "old.ugcboard.json")
	writeAt(t, archived, `{"nodes":[]}`, when)
	writeAt(t, filepath.Join(root, localstore.BoardsDir, "a.ugcboard.json"), `{"nodes":[]}`, when)
	for _, name := range []string{"task1", "task2"} {
		writeAt(t, filepath.Join(root, "2026-11-01", name, "result.png"), name, when)
	}
	store := localstore.New(root)
	svc := NewWithClock(store, fixedClock(when))
	res := svc.Cleanup([]string{"2026-11-01/task1", "2026-11-01/task2"})
	if !res.OK || len(res.Moved) != 2 {
		t.Fatalf("清理两份应都进回收区：%+v", res)
	}
	entryBy := func(dir string) RecycleEntry {
		for _, e := range svc.Recycle() {
			if e.Dir == dir {
				return e
			}
		}
		t.Fatalf("回收区里没有 %s", dir)
		return RecycleEntry{}
	}
	e1, e2 := entryBy("2026-11-01/task1"), entryBy("2026-11-01/task2")

	// 第 13 天：还没到期，不能提前删，恢复仍可用。
	day13 := NewWithClock(store, fixedClock(when.Add(13*24*time.Hour)))
	if day13.Recycle()[0].Expired || day13.Recycle()[1].Expired {
		t.Fatalf("14 天内不应提前到期")
	}
	if out := day13.PurgeExpired(); !out.OK || len(day13.Recycle()) != 2 {
		t.Fatalf("14 天内期满清理不能删任何内容：%+v", out)
	}

	// 回收区里一份丢失：单份失败要报告并留痕，另一份仍可恢复。
	if err := os.RemoveAll(filepath.Join(root, filepath.FromSlash(e1.Location))); err != nil {
		t.Fatalf("模拟部分失败: %v", err)
	}
	if out := day13.Restore(e1.ID); out.OK || out.Kind != KindMissing {
		t.Fatalf("内容缺失应报失败：%+v", out)
	}
	// 失败的 e1 必须仍在回收区可追溯；仅检查「还有任意条目」会被 e2 满足而漏掉本缺陷（#232）。
	var e1StillTracked bool
	for _, e := range day13.Recycle() {
		if e.ID == e1.ID {
			e1StillTracked = true
			break
		}
	}
	if !e1StillTracked {
		t.Fatalf("部分失败后 e1 条目仍需可追溯：%s", e1.ID)
	}
	if out := day13.Restore(e2.ID); !out.OK {
		t.Fatalf("另一份应能恢复：%+v", out)
	}

	// 第 14 天整：到期、拒绝恢复、按用户明确操作清理；归档画板不按时间删除。
	writeAt(t, filepath.Join(root, "2026-11-01", "task3", "result.png"), "x", when)
	if out := svc.Cleanup([]string{"2026-11-01/task3"}); !out.OK {
		t.Fatalf("清理任务 3: %+v", out)
	}
	day14 := NewWithClock(store, fixedClock(when.Add(14*24*time.Hour)))
	var e3 RecycleEntry
	for _, e := range day14.Recycle() {
		if e.Dir == "2026-11-01/task3" {
			e3 = e
		}
	}
	if e3.ID == "" || !e3.Expired {
		t.Fatalf("满 14 天应标记期满：%+v", e3)
	}
	if out := day14.Restore(e3.ID); out.OK {
		t.Fatalf("期满后不应再恢复：%+v", out)
	}
	if out := day14.PurgeExpired(); !out.OK {
		t.Fatalf("期满清理: %+v", out)
	}
	if len(day14.Recycle()) != 0 {
		t.Fatalf("期满项应被清理：%+v", day14.Recycle())
	}
	if _, err := os.Stat(archived); err != nil {
		t.Fatalf("归档画板不参与按时间删除：%v", err)
	}
}

