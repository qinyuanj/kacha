package clipboard

import (
	"encoding/json"
	"testing"
)

// 剪贴板快照的线键是页面约定（client/src/shell/desktop.ts 的 DesktopClipboardSnapshot）：
// 键名变了前端就静默读不到 kind，只会按「读不到」退回 paste 事件（#232 从全文件 grep
// 迁到最强边界：直接 marshal Snapshot，改掉任一 json tag 都会失败）。
func TestSnapshotJSONKeys(t *testing.T) {
	data, err := json.Marshal(Snapshot{})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	for _, key := range []string{"kind", "text", "images", "reason", "formats"} {
		if _, ok := got[key]; !ok {
			t.Fatalf("Snapshot 缺少 %q：%s", key, data)
		}
	}
	if len(got) != 5 {
		t.Fatalf("Snapshot 键数 = %d, want 5: %s", len(got), data)
	}
}
