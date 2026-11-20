package gateway

import (
	"encoding/base64"
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
	// BodyBase64 承载二进制响应（结果图）：JSON 字符串不能保住任意图片字节。
	BodyBase64 string `json:"body_base64,omitempty"`
}

// requestTimeout 防止网关无响应时把界面卡住；超时按网络错误返回。
//
// 查询类请求（模型发现）保持短超时：几秒没响应就该报错，而不是让界面等着。
// 生成类请求是分钟级操作：5.5 带参考图实测 11 秒起步，慢的时候远超 20 秒，
// 用查询的超时会把它误报成「网络不可达」（2026-11-20 真机验收踩到）。
const requestTimeout = 20 * time.Second

// generationTimeout 用于提交生成任务：上传参考图与等待模型出图都在这一次请求里。
const generationTimeout = 5 * time.Minute

// downloadTimeout 用于取回结果图：单张图通常几 MB，留出网络抖动余量。
const downloadTimeout = 2 * time.Minute

// timeoutFor 按请求性质选超时；不是查询就是生成，两者差别在数量级。
func timeoutFor(method string, url string) time.Duration {
	if method == http.MethodPost && strings.Contains(url, "/images/") {
		return generationTimeout
	}
	if method == http.MethodGet && !strings.Contains(url, "/models") {
		return downloadTimeout
	}
	return requestTimeout
}

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
	client := &http.Client{Timeout: timeoutFor(method, url)}
	resp, err := client.Do(req)
	if err != nil {
		return Response{}, fmt.Errorf("无法连接网关：%s", redact(err.Error(), headers))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return Response{}, fmt.Errorf("读取网关响应失败：%s", redact(err.Error(), headers))
	}
	result := Response{Status: resp.StatusCode, Headers: map[string]string{}}
	for name, values := range resp.Header {
		result.Headers[name] = strings.Join(values, ",")
	}
	if isTextResponse(result.Headers["Content-Type"]) {
		result.Body = redact(string(data), headers)
	} else {
		result.BodyBase64 = base64.StdEncoding.EncodeToString(data)
	}
	return result, nil
}

// isTextResponse 判断能否按 UTF-8 文本回传；结果图等二进制走 base64，未知类型按二进制保真。
func isTextResponse(contentType string) bool {
	c := strings.ToLower(contentType)
	if c == "" {
		return true
	}
	return strings.Contains(c, "json") || strings.Contains(c, "text/") || strings.Contains(c, "xml") || strings.Contains(c, "urlencoded")
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
