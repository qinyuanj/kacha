package gateway

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Response 是交给页面的原生 HTTP 结局：状态码、响应头和正文都按原文回传，错误交调用方折叠。
type Response struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// requestTimeout 防止网关无响应时把界面卡住；超时按网络错误返回。
const requestTimeout = 20 * time.Second

// maxResponseBytes 防止异常大的响应把 IPC 撑爆；模型发现与生成结果都远小于它。
const maxResponseBytes = 2 << 20

// Request 经 Go 的 net/http 发真实请求。Authorization 等请求头只从这里进入，
// 不写日志；网关回显的密钥在正文里替换掉。
func (s *Service) Request(url string, method string, headers map[string]string, body string) (Response, error) {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return Response{}, fmt.Errorf("网关请求无效：%s", redact(err.Error(), headers))
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	client := &http.Client{Timeout: requestTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return Response{}, fmt.Errorf("无法连接网关：%s", redact(err.Error(), headers))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return Response{}, fmt.Errorf("读取网关响应失败：%s", redact(err.Error(), headers))
	}
	result := Response{Status: resp.StatusCode, Headers: map[string]string{}, Body: redact(string(data), headers)}
	for name, values := range resp.Header {
		result.Headers[name] = strings.Join(values, ",")
	}
	return result, nil
}

// redact 把请求头里的 Bearer 令牌从文本中去掉，避免网关原文回显密钥。
func redact(text string, headers map[string]string) string {
	for name, value := range headers {
		if !strings.EqualFold(name, "Authorization") {
			continue
		}
		token := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(value), "Bearer"))
		if token != "" {
			text = strings.ReplaceAll(text, token, "[REDACTED]")
		}
	}
	return text
}
