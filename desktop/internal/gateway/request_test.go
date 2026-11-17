package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
		t.Fatal(err)
	}
	if got != "{\"prompt\":\"x\"}" {
		t.Fatalf("请求体 = %q", got)
	}
}
