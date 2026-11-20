package gateway

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 受控网关替身（#153）：Go 服务按已记录契约发一次 POST，再按响应 URL 取图。
// 图片是二进制，必须走 body_base64 才能跨 JSON 绑定保真；密钥回显要在 Go 侧脱敏。
func TestGenerationRequestAndBinaryResultThroughGateway(t *testing.T) {
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 64}
	var gotMethod, gotPath, gotAuth, gotContentType string
	var gotBody map[string]any
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/images/generations":
			gotMethod, gotPath = r.Method, r.URL.Path
			gotAuth = r.Header.Get("Authorization")
			gotContentType = r.Header.Get("Content-Type")
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &gotBody)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"url": server.URL + "/result.png"}}})
		case "/result.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(png)
		case "/auth":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(401)
			_, _ = io.WriteString(w, "{\"error\":{\"message\":\"bad "+syntheticKey+"\"}}")
		case "/rate":
			w.WriteHeader(429)
			_, _ = io.WriteString(w, "{\"error\":{\"message\":\"slow down\"}}")
		case "/server":
			w.WriteHeader(500)
			_, _ = io.WriteString(w, "boom")
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	svc := New(t.TempDir() + "/api-key.protected")
	requestBody := `{"model":"qwen-image-3.0-pro","prompt":"一只橘猫","n":1,"size":"1024x1024"}`
	headers := map[string]string{"Authorization": "Bearer " + syntheticKey, "Accept": "application/json", "Content-Type": "application/json"}
	res, err := svc.Request(server.URL+"/v1/images/generations", "POST", headers, requestBody)
	if err != nil {
		t.Fatalf("生成请求: %v", err)
	}
	if res.Status != 200 || gotMethod != "POST" || gotPath != "/v1/images/generations" {
		t.Fatalf("生成请求 = %s %s, status %d", gotMethod, gotPath, res.Status)
	}
	if gotAuth != "Bearer "+syntheticKey || gotContentType != "application/json" {
		t.Fatalf("请求头不对：auth=%q content-type=%q", gotAuth, gotContentType)
	}
	if gotBody["model"] != "qwen-image-3.0-pro" || gotBody["prompt"] != "一只橘猫" || gotBody["n"] != float64(1) || gotBody["size"] != "1024x1024" {
		t.Fatalf("请求体不符合契约：%#v", gotBody)
	}
	if !bytes.Contains([]byte(res.Body), []byte("/result.png")) {
		t.Fatalf("响应没有结果地址：%s", res.Body)
	}

	image, err := svc.Request(server.URL+"/result.png", "GET", map[string]string{"Accept": "image/*"}, "")
	if err != nil {
		t.Fatalf("下载结果图: %v", err)
	}
	if image.Status != 200 || image.BodyBase64 == "" || image.Body != "" {
		t.Fatalf("图片响应形状不对：%#v", image)
	}
	decoded, err := base64.StdEncoding.DecodeString(image.BodyBase64)
	if err != nil || !bytes.Equal(decoded, png) {
		t.Fatalf("图片字节不一致：%v, %v", decoded, err)
	}

	for _, tc := range []struct {
		path     string
		status   int
		redacted bool
	}{
		{"/auth", 401, true},
		{"/rate", 429, false},
		{"/server", 500, false},
	} {
		out, err := svc.Request(server.URL+tc.path, "GET", headers, "")
		if err != nil {
			t.Fatalf("%s: %v", tc.path, err)
		}
		if out.Status != tc.status {
			t.Fatalf("%s status = %d, want %d", tc.path, out.Status, tc.status)
		}
		if tc.redacted && (bytes.Contains([]byte(out.Body), []byte(syntheticKey)) || !bytes.Contains([]byte(out.Body), []byte("[REDACTED]"))) {
			t.Fatalf("%s 没有脱敏：%s", tc.path, out.Body)
		}
	}
}
