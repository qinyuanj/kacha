// Package feedbackservice 是桌面壳的反馈发送端：脱敏后使用本机授权直连 Gitea，
// 并把 HTTP 结局折成页面只按 kind 分支的稳定结果。
package feedbackservice

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/qinyuanj/kacha/desktop/internal/feedbackauth"
	"github.com/qinyuanj/kacha/desktop/internal/redaction"
)

const (
	// DefaultGiteaBase 与一键授权使用同一个 Gitea，避免授权和提交落到不同服务。
	DefaultGiteaBase = feedbackauth.DefaultGiteaBase
	DefaultOwnerRepo = "qinyuanj/kacha-feedback"
)

// 稳定结局类别：页面与端口替身共用同一组字符串。
const (
	KindOK           = "ok"
	KindDuplicate    = "duplicate"
	KindUnreachable  = "unreachable"
	KindRejected     = "rejected"
	KindInvalid      = "invalid"
	KindTooLarge     = "too_large"
	KindUnauthorized = "unauthorized"
	KindUnavailable  = "unavailable"
)

// 稳定文案：Gitea 的原始服务器错误不直接暴露给页面。
// 客户端同一批文案在 client/src/core/feedback.ts，由 test_feedback_contract_sync.py 逐字核对。
const (
	MessageUnavailable  = "反馈暂不可用"
	MessageUnreachable  = "Gitea 不可达，请稍后再试"
	MessageUnauthorized = "Gitea token 无效或权限不足"
	MessageRejected     = "Gitea 提交失败，请稍后再试"
	MessageInvalid      = "反馈内容不合法，请修改后重试"
	MessageTooLarge     = "反馈内容过大，请精简后重试"
	MessageTooMany      = "截图最多 5 张，请删掉多余的再发送"
	MessageFormat       = "截图只支持 PNG/JPG 格式，请转换后重试"
	MessageBigShot      = "单张截图超过 10MB，请压缩后重试"
	MessageBigPack      = "诊断包过大，请重新生成后再发送"
)

var validCategories = map[string]bool{"bug": true, "feature": true, "suggestion": true, "other": true}
var categoryLabel = map[string]string{"bug": "缺陷", "feature": "需求", "suggestion": "建议", "other": "其他"}

// Attachment 是页面经 base64 JSON 交来的附件；Go 侧直接以字节写 multipart。
type Attachment struct {
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Data        []byte `json:"data"`
}

const (
	MaxScreenshots          = 5
	MaxScreenshotBytes      = 10 << 20
	maxDiagnosticsPackBytes = 4 << 20
	dedupWindow             = 2 * time.Minute
)

// Spec 是 ShellPort.feedback.send(spec) 的 Go 侧形状。凭据只能来自本机 Auth；
// 刻意不提供 token 或中继地址字段，页面无法注入另一条发送路径。
type Spec struct {
	Title     string `json:"title"`
	Category  string `json:"category"`
	Body      string `json:"body"`
	Version   string `json:"version"`
	Build     string `json:"build"`
	OS        string `json:"os"`
	BoardName string `json:"board_name"`
	Contact   string `json:"contact,omitempty"`

	Screenshots     []Attachment `json:"screenshots,omitempty"`
	DiagnosticsPack *Attachment  `json:"diagnostics_pack,omitempty"`
}

// Outcome 与前端 FeedbackOutcome 同形。
type Outcome struct {
	OK      bool   `json:"ok"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Number  int    `json:"number,omitempty"`
	URL     string `json:"url,omitempty"`
}

// FeedbackAuth 是反馈发送需要的本机授权能力；接口让发送端契约可独立测试。
type FeedbackAuth interface {
	Token() (string, error)
	Status() feedbackauth.Status
	Start() feedbackauth.Start
	Reset() error
}

// Config 是服务的运行参数；空地址与仓库名使用与一键授权一致的默认值。
type Config struct {
	GiteaBase string
	OwnerRepo string
	Auth      FeedbackAuth
}

type dedupEntry struct {
	number int
	url    string
	at     time.Time
}

// Service 持有 HTTP 客户端与本机短期去重状态；token 只用于单次请求和内存指纹。
type Service struct {
	cfg    Config
	auth   FeedbackAuth
	client *http.Client
	now    func() time.Time

	mu    sync.Mutex
	dedup map[string]dedupEntry
}

// New 造一个直连 Gitea 的反馈服务。
func New(cfg Config) *Service {
	if strings.TrimSpace(cfg.GiteaBase) == "" {
		cfg.GiteaBase = DefaultGiteaBase
	}
	if strings.TrimSpace(cfg.OwnerRepo) == "" {
		cfg.OwnerRepo = DefaultOwnerRepo
	}
	return &Service{
		cfg: cfg, auth: cfg.Auth, client: &http.Client{Timeout: 30 * time.Second},
		now: time.Now, dedup: map[string]dedupEntry{},
	}
}

// redact 去掉正文中会泄露身份的绝对路径与常见凭据形态；主机名不主动采集。
func redact(text string) string {
	return strings.TrimSpace(redaction.Redact(text))
}

// contentFingerprint 把提交者与完整内容折成短期内存键；token 及其哈希不持久化。
func contentFingerprint(token string, spec Spec) string {
	payload, _ := json.Marshal(spec)
	h := sha256.New()
	_, _ = h.Write([]byte(token))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write(payload)
	return hex.EncodeToString(h.Sum(nil))
}

// AuthStatus 只返回授权状态，不返回 token 本身。
func (s *Service) AuthStatus() feedbackauth.Status {
	if s.auth == nil {
		return feedbackauth.Status{Message: feedbackauth.MessageUnauthorized}
	}
	return s.auth.Status()
}

// AuthStart 起一次 Gitea 授权；浏览器地址只用于没自动打开时的兜底。
func (s *Service) AuthStart() feedbackauth.Start {
	if s.auth == nil {
		return feedbackauth.Start{Message: feedbackauth.MessageFailed}
	}
	return s.auth.Start()
}

// AuthReset 清除本机 token 和短期去重记录，下一次反馈需要重新授权。
func (s *Service) AuthReset() error {
	s.mu.Lock()
	s.dedup = map[string]dedupEntry{}
	s.mu.Unlock()
	if s.auth == nil {
		return nil
	}
	return s.auth.Reset()
}

// Send 直接使用本机 token 在 Gitea 创建 issue、上传附件并回写附件链接。
func (s *Service) Send(spec Spec) Outcome {
	category := strings.TrimSpace(spec.Category)
	if category == "" {
		category = "other"
	}
	if !validCategories[category] || strings.TrimSpace(spec.Body) == "" {
		return Outcome{Kind: KindInvalid, Message: MessageInvalid}
	}
	if oc := validateAttachments(spec); oc != nil {
		return *oc
	}
	if s.auth == nil {
		return Outcome{Kind: KindUnauthorized, Message: MessageUnauthorized}
	}
	token, err := s.auth.Token()
	if err != nil || strings.TrimSpace(token) == "" {
		return Outcome{Kind: KindUnauthorized, Message: MessageUnauthorized}
	}
	token = strings.TrimSpace(token)

	safe := spec
	safe.Category = category
	safe.Title = redact(spec.Title)
	safe.Body = redact(spec.Body)
	fingerprint := contentFingerprint(token, safe)
	if out, ok := s.lookupDuplicate(fingerprint); ok {
		return out
	}

	title := strings.TrimSpace(safe.Title)
	if title == "" {
		title = "[" + categoryLabel[category] + "] " + firstRunes(safe.Body, 40)
	}
	issueBody := composeBody(safe.Body, metadata{
		version: strings.TrimSpace(spec.Version), build: strings.TrimSpace(spec.Build),
		os: strings.TrimSpace(spec.OS), boardName: strings.TrimSpace(spec.BoardName),
		contact: strings.TrimSpace(spec.Contact),
	})
	created, err := s.createIssue(title, issueBody, category, token)
	if err != nil {
		return outcomeForError(err)
	}

	uploads := make([]Attachment, 0, len(spec.Screenshots)+1)
	uploads = append(uploads, spec.Screenshots...)
	if spec.DiagnosticsPack != nil {
		uploads = append(uploads, *spec.DiagnosticsPack)
	}
	var links []string
	for _, attachment := range uploads {
		assetURL, uploadErr := s.uploadAsset(created.Number, attachment, token)
		if uploadErr != nil {
			return outcomeForError(uploadErr)
		}
		if strings.HasPrefix(attachment.ContentType, "image/") {
			links = append(links, fmt.Sprintf("![%s](%s)", attachment.Name, assetURL))
		} else {
			links = append(links, fmt.Sprintf("[%s](%s)", attachment.Name, assetURL))
		}
	}
	if len(links) > 0 {
		if err := s.patchIssue(created.Number, issueBody+"\n\n---\n\n"+strings.Join(links, "\n\n"), token); err != nil {
			return outcomeForError(err)
		}
	}

	s.remember(fingerprint, created)
	return Outcome{OK: true, Kind: KindOK, Message: fmt.Sprintf("已提交 #%d", created.Number), Number: created.Number, URL: created.HTMLURL}
}

// validateAttachments 在发请求前拦下不合规附件，给出可操作的稳定文案。
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

func (s *Service) lookupDuplicate(fingerprint string) (Outcome, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.dedup[fingerprint]
	if !ok {
		return Outcome{}, false
	}
	if s.now().Sub(entry.at) > dedupWindow {
		delete(s.dedup, fingerprint)
		return Outcome{}, false
	}
	return Outcome{OK: true, Kind: KindDuplicate, Message: fmt.Sprintf("刚刚已提交过 #%d", entry.number), Number: entry.number, URL: entry.url}, true
}

func (s *Service) remember(fingerprint string, issue createdIssue) {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, entry := range s.dedup {
		if now.Sub(entry.at) > dedupWindow {
			delete(s.dedup, key)
		}
	}
	s.dedup[fingerprint] = dedupEntry{number: issue.Number, url: issue.HTMLURL, at: now}
}

func firstRunes(text string, limit int) string {
	text = strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
	runes := []rune(text)
	if len(runes) > limit {
		runes = runes[:limit]
	}
	if len(runes) == 0 {
		return "反馈"
	}
	return string(runes)
}
