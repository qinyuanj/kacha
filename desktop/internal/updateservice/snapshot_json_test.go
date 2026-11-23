package updateservice

import (
	"encoding/json"
	"testing"
)

// 更新快照的线键是页面约定（client/src/core/update.ts 的 UpdateSnapshot）：
// 少了 verified / installable，界面就只能靠 phase 猜能不能装（#232 从全文件 grep
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
	for _, key := range []string{"phase", "current", "version", "notes", "page_url", "downloaded", "total", "verified", "installable", "error", "checked_at"} {
		if _, ok := got[key]; !ok {
			t.Fatalf("Snapshot 缺少 %q：%s", key, data)
		}
	}
	if len(got) != 11 {
		t.Fatalf("Snapshot 键数 = %d, want 11: %s", len(got), data)
	}
}
