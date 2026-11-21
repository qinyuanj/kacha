// Package feedbackservice 是桌面壳的反馈发送端：把文字反馈脱敏后交给配置的中继，
// 并把 HTTP 结局折成页面只按 kind 分支的稳定结果（#205）。
package feedbackservice

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// DefaultRelayURL 是桌面壳内置的中继地址；高级设置覆盖由调用方通过 Spec.RelayURL 传入（#209）。
// 客户端常量在 client/src/core/feedback.ts；packaging/tests/test_feedback_contract_sync.py 防止两端漂移。
const DefaultRelayURL = "http://lzxsvn:3005"

// 稳定结局类别：页面与端口替身共用同一组字符串。
const (
	KindOK          = "ok"
	KindDuplicate   = "duplicate"
	KindUnreachable = "unreachable"
	KindRejected    = "rejected"
	KindInvalid     = "invalid"
	KindTooLarge    = "too_large"
	KindUnavailable = "unavailable"
)

// 稳定文案：中继的原始服务器错误不直接暴露给页面。
// 客户端同一批文案在 client/src/core/feedback.ts，由 test_feedback_contract_sync.py 逐字核对。
const (
	MessageUnavailable = "反馈暂不可用：未配置中继地址"
	MessageUnreachable = "反馈中继不可达，请稍后再试"
	MessageRejected    = "反馈被中继拒绝，请稍后再试"
	MessageInvalid     = "反馈内容不合法，请修改后重试"
	MessageTooLarge    = "反馈内容过大，请精简后重试"
	MessageTooMany     = "截图最多 5 张，请删掉多余的再发送"
	MessageFormat      = "截图只支持 PNG/JPG 格式，请转换后重试"
	MessageBigShot     = "单张截图超过 10MB，请压缩后重试"
	MessageBigPack     = "诊断包过大，请重新生成后再发送"
)

// Attachment 是页面经 base64 JSON 交来的附件；Go 侧直接以字节写 multipart。
type Attachment struct {
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Data        []byte `json:"data"`
}

// 附件上限与 relay 一致：0–5 张 PNG/JPG，单张 ≤10MB；诊断包复用允许清单的 4MB 上限。
// 客户端截图上限在 client/src/core/feedback.ts，由 test_feedback_contract_sync.py 核对。
const (
	MaxScreenshots          = 5
	MaxScreenshotBytes      = 10 << 20
	maxDiagnosticsPackBytes = 4 << 20
)

// Spec 是 ShellPort.feedback.send(spec) 的 Go 侧形状。
type Spec struct {
	Title     string `json:"title"`
	Category  string `json:"category"`
	Body      string `json:"body"`
	Version   string `json:"version"`
	Build     string `json:"build"`
	OS        string `json:"os"`
	BoardName string `json:"board_name"`
	Contact   string `json:"contact,omitempty"`
	// RelayURL 是可选的本次调用覆盖；空值使用 Config.RelayURL（界面只在显式非默认覆盖时填）。
	RelayURL string `json:"relay_url,omitempty"`
	// Screenshots 与 DiagnosticsPack 是 #207 的附件，字段名与前端 spec 一致。
	Screenshots     []Attachment `json:"screenshots,omitempty"`
	DiagnosticsPack *Attachment  `json:"diagnostics_pack,omitempty"`
}

// Outcome 与中继回执、前端 FeedbackOutcome 同形。
type Outcome struct {
	OK      bool   `json:"ok"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Number  int    `json:"number,omitempty"`
	URL     string `json:"url,omitempty"`
}

// Config 是服务的运行参数；RelayURL 为空且调用方也没有显式覆盖时，发送明确不可用。
type Config struct {
	RelayURL string
	Client   *http.Client
}

// Service 持有 HTTP 客户端与配置；无共享可变状态。
type Service struct {
	cfg    Config
	client *http.Client
}

// New 造一个反馈服务；不擅自填默认地址，是否配置由调用方说清楚。
func New(cfg Config) *Service {
	if cfg.Client == nil {
		cfg.Client = &http.Client{Timeout: 20 * time.Second}
	}
	return &Service{cfg: cfg, client: cfg.Client}
}

var (
	credentialAssignment = regexp.MustCompile(`(?i)\b(api[_-]?key|token|secret|authorization|bearer)\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;]+)`)
	standaloneKey        = regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{8,}\b`)
	windowsPath          = regexp.MustCompile(`[A-Za-z]:[\\/][^\s，。；,;]+`)
	uncPath              = regexp.MustCompile(`\\\\[^\s，。；,;]+`)
	unixPath             = regexp.MustCompile(`(^|[\s(（])(/(?:Users|home|tmp|var|mnt)/[^\s，。；,;]+)`)
)

// redact 去掉正文中会泄露身份的绝对路径与常见凭据形态；主机名不主动采集。
func redact(text string) string {
	out := credentialAssignment.ReplaceAllString(text, "$1=<凭据>")
	out = standaloneKey.ReplaceAllString(out, "<凭据>")
	out = windowsPath.ReplaceAllString(out, "<本地路径>")
	out = uncPath.ReplaceAllString(out, "<本地路径>")
	out = unixPath.ReplaceAllString(out, "$1<本地路径>")
	return strings.TrimSpace(out)
}

// idempotencyKey 按脱敏后的内容算稳定键：相同内容在去重窗口内只开一张 issue。
func idempotencyKey(spec Spec) string {
	payload, _ := json.Marshal(struct {
		Title           string       `json:"title"`
		Category        string       `json:"category"`
		Body            string       `json:"body"`
		Version         string       `json:"version"`
		Build           string       `json:"build"`
		OS              string       `json:"os"`
		BoardName       string       `json:"board_name"`
		Contact         string       `json:"contact,omitempty"`
		Screenshots     []Attachment `json:"screenshots,omitempty"`
		DiagnosticsPack *Attachment  `json:"diagnostics_pack,omitempty"`
	}{
		Title: spec.Title, Category: spec.Category, Body: spec.Body,
		Version: spec.Version, Build: spec.Build, OS: spec.OS,
		BoardName: spec.BoardName, Contact: spec.Contact,
		Screenshots: spec.Screenshots, DiagnosticsPack: spec.DiagnosticsPack,
	})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// Send 发送一条文字反馈；失败都返回类型化 Outcome，不把底层错误原文丢给页面。
func (s *Service) Send(spec Spec) Outcome {
	relay := strings.TrimSpace(spec.RelayURL)
	if relay == "" {
		relay = strings.TrimSpace(s.cfg.RelayURL)
	}
	if relay == "" {
		return Outcome{Kind: KindUnavailable, Message: MessageUnavailable}
	}

	if oc := validateAttachments(spec); oc != nil {
		return *oc
	}

	safe := spec
	safe.Title = redact(spec.Title)
	safe.Body = redact(spec.Body)
	safe.RelayURL = ""

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	fields := []struct{ name, value string }{
		{"title", safe.Title},
		{"category", strings.TrimSpace(spec.Category)},
		{"body", safe.Body},
		{"version", strings.TrimSpace(spec.Version)},
		{"build", strings.TrimSpace(spec.Build)},
		{"os", strings.TrimSpace(spec.OS)},
		{"board_name", strings.TrimSpace(spec.BoardName)},
		{"contact", strings.TrimSpace(spec.Contact)},
	}
	for _, field := range fields {
		if err := writer.WriteField(field.name, field.value); err != nil {
			return Outcome{Kind: KindRejected, Message: MessageRejected}
		}
	}
	for _, shot := range spec.Screenshots {
		if err := writeAttachment(writer, "screenshots[]", shot); err != nil {
			return Outcome{Kind: KindRejected, Message: MessageRejected}
		}
	}
	if spec.DiagnosticsPack != nil {
		if err := writeAttachment(writer, "diagnostics_pack", *spec.DiagnosticsPack); err != nil {
			return Outcome{Kind: KindRejected, Message: MessageRejected}
		}
	}
	if err := writer.Close(); err != nil {
		return Outcome{Kind: KindRejected, Message: MessageRejected}
	}

	address := strings.TrimRight(relay, "/") + "/api/feedback"
	req, err := http.NewRequest(http.MethodPost, address, &body)
	if err != nil {
		return Outcome{Kind: KindUnreachable, Message: MessageUnreachable}
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Idempotency-Key", idempotencyKey(safe))

	resp, err := s.client.Do(req)
	if err != nil {
		return Outcome{Kind: KindUnreachable, Message: MessageUnreachable}
	}
	defer resp.Body.Close()

	var relayOutcome Outcome
	if err := json.NewDecoder(resp.Body).Decode(&relayOutcome); err != nil {
		return Outcome{Kind: KindRejected, Message: MessageRejected}
	}
	return mapOutcome(resp.StatusCode, relayOutcome)
}

// validateAttachments 在发请求前拦下明显不合规的附件，给出可操作的稳定文案。
func validateAttachments(spec Spec) *Outcome {
	if len(spec.Screenshots) > MaxScreenshots {
		return &Outcome{Kind: KindInvalid, Message: MessageTooMany}
	}
	for _, shot := range spec.Screenshots {
		if !strings.EqualFold(shot.ContentType, "image/png") && !strings.EqualFold(shot.ContentType, "image/jpeg") {
			return &Outcome{Kind: KindInvalid, Message: MessageFormat}
		}
		if len(shot.Data) > MaxScreenshotBytes {
			return &Outcome{Kind: KindTooLarge, Message: MessageBigShot}
		}
	}
	if spec.DiagnosticsPack != nil && len(spec.DiagnosticsPack.Data) > maxDiagnosticsPackBytes {
		return &Outcome{Kind: KindTooLarge, Message: MessageBigPack}
	}
	return nil
}

func writeAttachment(writer *multipart.Writer, field string, attachment Attachment) error {
	name := attachment.Name
	if strings.TrimSpace(name) == "" {
		name = "attachment"
	}
	part, err := writer.CreateFormFile(field, name)
	if err != nil {
		return err
	}
	_, err = part.Write(attachment.Data)
	return err
}

func mapOutcome(status int, relay Outcome) Outcome {
	message := strings.TrimSpace(relay.Message)
	if status == http.StatusOK && relay.OK && relay.Kind == "created" {
		if message == "" {
			message = fmt.Sprintf("已提交 #%d", relay.Number)
		}
		return Outcome{OK: true, Kind: KindOK, Message: message, Number: relay.Number, URL: relay.URL}
	}
	if status == http.StatusOK && relay.OK && relay.Kind == "duplicate" {
		if message == "" {
			message = fmt.Sprintf("刚刚已提交过 #%d", relay.Number)
		}
		return Outcome{OK: true, Kind: KindDuplicate, Message: message, Number: relay.Number, URL: relay.URL}
	}
	if status == http.StatusBadRequest || relay.Kind == "invalid" {
		return Outcome{Kind: KindInvalid, Message: MessageInvalid}
	}
	if status == http.StatusRequestEntityTooLarge || relay.Kind == "too_large" {
		return Outcome{Kind: KindTooLarge, Message: MessageTooLarge}
	}
	return Outcome{Kind: KindRejected, Message: MessageRejected}
}
