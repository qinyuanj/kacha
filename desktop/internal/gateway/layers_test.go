package gateway

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/localservice"
	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// 透明背景与图层拆分（#156）：同一份生成响应里的底图与每个图层都是独立二进制，
// 经 Go 网关按 body_base64 取回，再由本机服务只新建地写进任务目录。
// 任一层取不到时状态码原样交给页面，任务目录里没有那一层的文件——不完整的图层不会被当成完整结果。
func TestLayeredResultDownloadsThroughGatewayAndLocalService(t *testing.T) {
	basePNG := pngOf(t, 64, 64)
	layer1 := pngOf(t, 32, 32)
	layer2 := pngOf(t, 16, 16)
	missing := layer2[:]

	var failLayer2 bool
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/images/generations":
			raw, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			if body["layer_decomposition"] != true || body["size"] != "1K" {
				t.Errorf("图层请求不符合契约：%#v", body)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{
				map[string]any{"url": server.URL + "/base.png", "z_index": 0, "description": "合成底图"},
				map[string]any{"url": server.URL + "/layer-1.png", "z_index": 1, "bounding_box": map[string]any{"absolute": []int{0, 0, 32, 32}, "normalized": []int{0, 0, 500, 500}}, "name": "主体"},
				map[string]any{"url": server.URL + "/layer-2.png", "z_index": 2, "bounding_box": map[string]any{"absolute": []int{10, 10, 26, 26}, "normalized": []int{156, 156, 406, 406}}},
			}})
		case "/base.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(basePNG)
		case "/layer-1.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(layer1)
		case "/layer-2.png":
			if failLayer2 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(404)
				_, _ = io.WriteString(w, `{"error":{"message":"gone"}}`)
				return
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(layer2)
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	root := t.TempDir()
	gateway := New(filepath.Join(root, "api-key.protected"))
	local := localservice.New(localstore.New(root))
	headers := map[string]string{"Authorization": "Bearer " + syntheticKey, "Accept": "application/json", "Content-Type": "application/json"}
	requestBody := `{"model":"doubao-seedream-5-0-flash-260915","layer_decomposition":true,"size":"1K","image":["data:image/png;base64,AAAA"]}`

	generated, err := gateway.Request(server.URL+"/v1/images/generations", "POST", headers, requestBody)
	if err != nil || generated.Status != 200 {
		t.Fatalf("生成请求: %+v, %v", generated, err)
	}
	var payload struct {
		Data []struct {
			URL         string `json:"url"`
			ZIndex      int    `json:"z_index"`
			BoundingBox struct {
				Absolute []int `json:"absolute"`
			} `json:"bounding_box"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(generated.Body), &payload); err != nil {
		t.Fatalf("解析图层响应: %v", err)
	}
	if len(payload.Data) != 3 || payload.Data[0].ZIndex != 0 || payload.Data[1].ZIndex != 1 || payload.Data[2].ZIndex != 2 {
		t.Fatalf("图层次序不对：%#v", payload.Data)
	}
	if got := payload.Data[2].BoundingBox.Absolute; len(got) != 4 || got[2] != 26 {
		t.Fatalf("图层定位没带回来：%#v", got)
	}

	taskDir := filepath.Join(root, "2026-11-17", "20261117T000000Z-1234abcd")
	want := map[string][]byte{
		filepath.Join(taskDir, "result.png"):        basePNG,
		filepath.Join(taskDir, "layers", "01.png"): layer1,
		filepath.Join(taskDir, "layers", "02.png"): layer2,
	}
	for i, item := range payload.Data {
		image, err := gateway.Request(item.URL, "GET", map[string]string{"Accept": "image/*"}, "")
		if err != nil {
			t.Fatalf("下载第 %d 张: %v", i, err)
		}
		if image.Status != 200 || image.BodyBase64 == "" || image.Body != "" {
			t.Fatalf("第 %d 张不是二进制响应：%+v", i, image)
		}
		rel := filepath.Join("result.png")
		if i > 0 {
			rel = filepath.Join("layers", fmt.Sprintf("%02d.png", i))
		}
		outcome, err := local.WriteNewFileBase64(filepath.Join(taskDir, rel), image.BodyBase64)
		if err != nil || !outcome.OK {
			t.Fatalf("写第 %d 张: %+v, %v", i, outcome, err)
		}
		read, err := local.ReadFile(filepath.Join(taskDir, rel))
		if err != nil {
			t.Fatalf("读回第 %d 张: %v", i, err)
		}
		decoded, err := base64.StdEncoding.DecodeString(read)
		if err != nil || !bytes.Equal(decoded, want[filepath.Join(taskDir, rel)]) {
			t.Fatalf("第 %d 张字节不一致：%v", i, err)
		}
	}

	// 图层文件是带透明通道的 PNG；本机探测与页面用的是同一个服务。
	info, err := local.InspectImage(filepath.Join(taskDir, "layers", "01.png"))
	if err != nil || !info.HasAlpha || info.Width != 32 || info.Height != 32 {
		t.Fatalf("图层探测 = %+v, %v", info, err)
	}
	// 文件只写一次：重写同一层被拒，不覆盖已落盘内容。
	again, err := local.WriteNewFileBase64(filepath.Join(taskDir, "layers", "02.png"), base64.StdEncoding.EncodeToString(missing))
	if err != nil || again.OK || again.Kind != "alreadyExists" {
		t.Fatalf("重写图层应只新建拒绝：%+v, %v", again, err)
	}

	// 部分图层下载失败：状态码原样返回，失败层没有落盘。
	failLayer2 = true
	partial, err := gateway.Request(server.URL+"/layer-2.png", "GET", map[string]string{"Accept": "image/*"}, "")
	if err != nil {
		t.Fatalf("失败层请求: %v", err)
	}
	if partial.Status != 404 || partial.BodyBase64 != "" {
		t.Fatalf("失败层响应形状不对：%+v", partial)
	}
	if _, err := local.ReadFile(filepath.Join(taskDir, "layers", "03.png")); err == nil {
		t.Fatalf("不存在的图层不应读到内容")
	}
}

// pngOf 造一张带透明通道的纯色 PNG（图层必须保留 alpha）。
func pngOf(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.NRGBA{R: byte(x), G: byte(y), B: 128, A: 128})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	return buf.Bytes()
}
