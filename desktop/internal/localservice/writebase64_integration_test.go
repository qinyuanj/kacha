package localservice

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 跨语言字节传输（#153）：页面把 Uint8Array 编成 base64 字符串，Go 的 []byte JSON 绑定按 base64 解码。
// 这条测试用真实服务与真实临时目录证明：读回字节一致、只写一次与路径边界仍由本机服务保证。
func TestWriteNewFileBase64CrossBindingRoundTrip(t *testing.T) {
	root := t.TempDir()
	svc := New(localstore.New(root))
	want := []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 64}
	dataB64 := base64.StdEncoding.EncodeToString(want)
	path := filepath.Join(root, "2026-11-17", "task-153", "result.png")

	// 与 MyGo 绑定收到的 JSON 同形：data 是 base64 字符串，不是 Uint8Array 对象。
	raw, err := json.Marshal(struct {
		Path string `json:"path"`
		Data string `json:"data"`
	}{Path: path, Data: dataB64})
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Path string `json:"path"`
		Data string `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	// Go 侧 []byte 的 JSON 绑定只认 base64 字符串；Uint8Array 序列化后的对象必须拒绝。
	var asBytes struct {
		Data []byte `json:"data"`
	}
	if err := json.Unmarshal(raw, &asBytes); err != nil || !bytes.Equal(asBytes.Data, want) {
		t.Fatalf("[]byte JSON 绑定未还原字节：%v, %v", asBytes.Data, err)
	}
	if err := json.Unmarshal([]byte(`{"data":{"0":137,"1":80}}`), &asBytes); err == nil {
		t.Fatal("Uint8Array 形态的对象不应解进 Go []byte")
	}

	outcome, err := svc.WriteNewFileBase64(payload.Path, payload.Data)
	if err != nil || !outcome.OK {
		t.Fatalf("WriteNewFileBase64: %+v, %v", outcome, err)
	}
	got, err := svc.ReadFile(payload.Path)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.DecodeString(got)
	if err != nil || !bytes.Equal(decoded, want) {
		t.Fatalf("读回字节 = %v, %v；期望 %v", decoded, err, want)
	}

	again, err := svc.WriteNewFileBase64(payload.Path, payload.Data)
	if err != nil || again.OK || again.Kind != "alreadyExists" {
		t.Fatalf("第二次写入应只新建拒绝：%+v, %v", again, err)
	}

	outside := filepath.Join(filepath.Dir(root), "outside.png")
	escaped, err := svc.WriteNewFileBase64(outside, payload.Data)
	if err != nil || escaped.OK {
		t.Fatalf("越界路径应拒绝：%+v, %v", escaped, err)
	}
}
