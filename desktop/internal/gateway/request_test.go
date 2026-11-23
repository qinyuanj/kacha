package gateway

import (
	"bytes"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 连接测试与模型发现都经 Go 发真实 HTTP：Authorization、方法与响应原文按网关契约走。
func TestRequestExecutesGatewayModelsCall(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotAccept string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotAuth, gotAccept = r.Header.Get("Authorization"), r.Header.Get("Accept")
		w.Header().Set("X-Oneapi-Request-Id", "req-152")
		_, _ = io.WriteString(w, "{\"data\":[{\"id\":\"m1\"}]}")
	}))
	defer server.Close()

	svc := New(t.TempDir() + "/api-key.protected")
	res, err := svc.Request(server.URL+"/v1/models", "GET", map[string]string{"Authorization": "Bearer " + syntheticKey, "Accept": "application/json"}, "")
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	if gotMethod != "GET" || gotPath != "/v1/models" {
		t.Fatalf("请求 = %s %s", gotMethod, gotPath)
	}
	if gotAuth != "Bearer "+syntheticKey || gotAccept != "application/json" {
		t.Fatalf("请求头不对：Authorization=%q Accept=%q", gotAuth, gotAccept)
	}
	if res.Status != 200 || !strings.Contains(res.Body, "\"m1\"") {
		t.Fatalf("响应 = %d %s", res.Status, res.Body)
	}
	if res.Headers["X-Oneapi-Request-Id"] != "req-152" {
		t.Fatalf("请求 ID 没有回传：%#v", res.Headers)
	}
}

// 网关回显密钥时也不能把它带回页面；网络错误不能把请求头打进消息。
func TestRequestRedactsSecretAndFailsNetworkCleanly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(401)
		_, _ = io.WriteString(w, "{\"error\":{\"message\":\"bad token "+syntheticKey+"\"}}")
	}))
	headers := map[string]string{"Authorization": "Bearer " + syntheticKey}
	svc := New(t.TempDir() + "/api-key.protected")
	res, err := svc.Request(server.URL+"/v1/models", "GET", headers, "")
	server.Close()
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	if res.Status != 401 || strings.Contains(res.Body, syntheticKey) || !strings.Contains(res.Body, "[REDACTED]") {
		t.Fatalf("响应没有脱敏：%d %s", res.Status, res.Body)
	}

	_, err = svc.Request(server.URL+"/v1/models", "GET", headers, "")
	if err == nil {
		t.Fatal("已关闭的网关应报网络错误")
	}
	if strings.Contains(err.Error(), syntheticKey) {
		t.Fatalf("网络错误泄露了密钥：%v", err)
	}
}

// 通用请求也承载 POST 文本：后续生成复用同一条原生通道，不为每个接口加绑定。
func TestRequestCarriesPostBody(t *testing.T) {
	var got string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		_, _ = io.WriteString(w, "{}")
	}))
	defer server.Close()
	svc := New(t.TempDir() + "/api-key.protected")
	if _, err := svc.Request(server.URL+"/v1/images/generations", "POST", map[string]string{}, "{\"prompt\":\"x\"}"); err != nil {
		t.Fatalf("Request: %v", err)
	}
	if got != "{\"prompt\":\"x\"}" {
		t.Fatalf("POST 正文 = %q", got)
	}
}

// 生成是分钟级操作，查询不是：两者共用 20 秒会把慢一点的出图误报成「网络不可达」。
func TestTimeoutForSeparatesGenerationFromQueries(t *testing.T) {
	cases := []struct {
		name   string
		method string
		url    string
		want   time.Duration
	}{
		{"模型发现用短超时", http.MethodGet, "http://gateway/v1/models", requestTimeout},
		{"文生图用生成超时", http.MethodPost, "http://gateway/v1/images/generations", generationTimeout},
		{"参考图编辑同样用生成超时", http.MethodPost, "http://gateway/v1/images/generations", generationTimeout},
		{"取结果图用下载超时", http.MethodGet, "https://bucket.example.com/a.png", downloadTimeout},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := timeoutFor(c.method, c.url); got != c.want {
				t.Fatalf("timeoutFor(%s, %s) = %v, want %v", c.method, c.url, got, c.want)
			}
		})
	}
	// 生成超时必须比查询宽松一个数量级，否则这次修复等于没做。
	if generationTimeout < 10*requestTimeout {
		t.Fatalf("生成超时 %v 与查询超时 %v 太接近", generationTimeout, requestTimeout)
	}
}

// binaryOf 造一段覆盖全部字节值的二进制，长度按需要伸缩：截断或按 UTF-8 改写都会看得出来。
func binaryOf(size int) []byte {
	data := make([]byte, size)
	for i := range data {
		data[i] = byte(i * 7)
	}
	return data
}

// 结果图是二进制且可能超过旧的 2 MiB 固定读数：真实请求边界上必须完整往返。
func TestRequestRoundTripsBinaryLargerThanTwoMiB(t *testing.T) {
	data := binaryOf(3<<20 + 5)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(data)
	}))
	defer server.Close()

	svc := New(t.TempDir() + "/api-key.protected")
	res, err := svc.Request(server.URL+"/files/result.png", "GET", map[string]string{"Accept": "image/*"}, "")
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	got, decodeErr := base64.StdEncoding.DecodeString(res.BodyBase64)
	if decodeErr != nil {
		t.Fatalf("body_base64 解不开：%v", decodeErr)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("二进制响应不完整：收到 %d 字节，要 %d 字节", len(got), len(data))
	}
}

// 超过能力表声明的单图上限：整次请求失败，不把截断的字节当成功的结果图交回页面。
func TestRequestRejectsResponseOverDeclaredLimit(t *testing.T) {
	data := binaryOf(maxResponseBytes + 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(data)
	}))
	defer server.Close()

	svc := New(t.TempDir() + "/api-key.protected")
	res, err := svc.Request(server.URL+"/files/result.png", "GET", map[string]string{"Accept": "image/*"}, "")
	if err == nil {
		t.Fatalf("超过上限仍当成功返回：%d 字节的 body_base64", len(res.BodyBase64))
	}
	if !strings.Contains(err.Error(), strconv.Itoa(maxResponseBytes)) {
		t.Fatalf("失败原因没说清上限：%v", err)
	}
	if res.BodyBase64 != "" || res.Body != "" {
		t.Fatalf("超过上限不该留下可被当作图片的字节：%q", res.BodyBase64)
	}
}
