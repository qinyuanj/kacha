package shellapp

import (
	"encoding/json"
	"testing"
)

// Info 的 JSON 是页面的约定：client/src/shell/desktop.ts 的 DesktopInfo 按这些键读。
// 键名变了前端就静默读不到，所以在这里钉住（两边各自定义，靠这条测试对齐）。
func TestInfoJSONKeys(t *testing.T) {
	data, err := json.Marshal(Info{})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	for _, key := range []string{"version", "user_data_root", "board_root", "features"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("Info 的 JSON 缺少 %q：%s", key, data)
		}
	}

	data, err = json.Marshal(Features{})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	raw = nil
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	for _, key := range []string{"generation", "usage", "pack_export", "archive"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("Features 的 JSON 缺少 %q：%s", key, data)
		}
	}
}
