// Package feedbackrelay 是部署在服务端的反馈中继：接收客户端提交的文字与截图，
// 用服务器侧的 Gitea token 在 kacha-feedback 仓库创建 issue 并把截图挂成附件。
//
// 它是可选的联网能力（ADR 0027）：不鉴权（局域网内部工具），只做 per-IP 限流、
// 体积上限与只写一个仓库；写 token 只在服务端，客户端二进制不含，核心画板能力与它无关。
package feedbackrelay

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"sync"
	"time"
)

// validCategories 是可接受的分类；与 Gitea 的 label 一一对应（type/<category>）。
var validCategories = map[string]bool{"bug": true, "feature": true, "suggestion": true, "other": true}

// categoryLabel 是给 issue 标题用的中文分类名。
var categoryLabel = map[string]string{"bug": "缺陷", "feature": "需求", "suggestion": "建议", "other": "反馈"}

// Config 是中继的运行参数，来自环境变量；零值由 New 补默认。
type Config struct {
	GiteaBase          string
	OwnerRepo          string
	Token              string
	Address            string
	RatePerMinute      int
	MaxRequestBytes    int64
	MaxScreenshots     int
	MaxScreenshotBytes int64
	DedupWindow        time.Duration
}

// Outcome 是处理一条反馈的结局；调用方只按 Kind 分支。
type Outcome struct {
	OK      bool   `json:"ok"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Number  int    `json:"number,omitempty"`
	URL     string `json:"url,omitempty"`
}

type dedupEntry struct {
	number int
	url    string
	at     time.Time
}

type rateBucket struct {
	count int
	start time.Time
}

// Service 持有配置、HTTP 客户端与限流/去重/标签缓存状态；并发安全。
type Service struct {
	cfg    Config
	client *http.Client
	now    func() time.Time

	mu      sync.Mutex
	dedup   map[string]dedupEntry
	labels  map[string]int64
	labelAt time.Time
	rates   map[string]*rateBucket
}

// New 造一个中继服务并补齐默认值。
func New(cfg Config) *Service {
	if cfg.RatePerMinute <= 0 {
		cfg.RatePerMinute = 10
	}
	if cfg.MaxRequestBytes <= 0 {
		cfg.MaxRequestBytes = 20 << 20
	}
	if cfg.MaxScreenshots <= 0 {
		cfg.MaxScreenshots = 5
	}
	if cfg.MaxScreenshotBytes <= 0 {
		cfg.MaxScreenshotBytes = 10 << 20
	}
	if cfg.DedupWindow <= 0 {
		cfg.DedupWindow = 2 * time.Minute
	}
	return &Service{
		cfg:    cfg,
		client: &http.Client{Timeout: 30 * time.Second},
		now:    time.Now,
		dedup:  map[string]dedupEntry{},
		rates:  map[string]*rateBucket{},
	}
}

// Handler 返回中继的 HTTP 路由：POST /api/feedback 与 GET /healthz。
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	})
	mux.HandleFunc("/api/feedback", s.handleFeedback)
	return mux
}

// upload 是一张待上传的附件。
type upload struct {
	name        string
	data        []byte
	contentType string
}

// handleFeedback 处理一条反馈：限流 → 解析 → 校验 → 去重 → 建 issue → 传附件 → 回执。
func (s *Service) handleFeedback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOutcome(w, http.StatusMethodNotAllowed, Outcome{Kind: "invalid", Message: "只接受 POST"})
		return
	}
	if !s.allow(clientIP(r)) {
		writeOutcome(w, http.StatusTooManyRequests, Outcome{Kind: "rate_limited", Message: "请求过于频繁，请稍后再试"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxRequestBytes)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeOutcome(w, http.StatusBadRequest, Outcome{Kind: "too_large", Message: "请求体过大或不是 multipart/form-data"})
		return
	}

	category := strings.TrimSpace(r.FormValue("category"))
	if !validCategories[category] {
		category = "other"
	}
	body := strings.TrimSpace(r.FormValue("body"))
	if body == "" {
		writeOutcome(w, http.StatusBadRequest, Outcome{Kind: "invalid", Message: "正文不能为空"})
		return
	}

	shots, oc := s.collectFiles(r, "screenshots", s.cfg.MaxScreenshots, s.cfg.MaxScreenshotBytes, true)
	if oc != nil {
		writeOutcome(w, oc.status, oc.outcome)
		return
	}
	packs, oc := s.collectFiles(r, "diagnostics_pack", 1, s.cfg.MaxRequestBytes, false)
	if oc != nil {
		writeOutcome(w, oc.status, oc.outcome)
		return
	}

	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" {
		key = contentKey(body, shots)
	}
	if e, ok := s.lookupDup(key); ok {
		writeOutcome(w, http.StatusOK, Outcome{OK: true, Kind: "duplicate", Message: fmt.Sprintf("刚刚已提交过 #%d", e.number), Number: e.number, URL: e.url})
		return
	}

	title := strings.TrimSpace(r.FormValue("title"))
	if title == "" {
		title = "[" + categoryLabel[category] + "] " + firstRunes(body, 40)
	}
	issueBody := composeBody(body, metadata{
		version:   strings.TrimSpace(r.FormValue("version")),
		build:     strings.TrimSpace(r.FormValue("build")),
		os:        strings.TrimSpace(r.FormValue("os")),
		boardName: strings.TrimSpace(r.FormValue("board_name")),
		contact:   strings.TrimSpace(r.FormValue("contact")),
	})

	created, err := s.createIssue(title, issueBody, category)
	if err != nil {
		writeOutcome(w, http.StatusBadGateway, Outcome{Kind: "failed", Message: "创建 issue 失败：服务器无法写入 Gitea"})
		return
	}

	var links []string
	for _, u := range append(shots, packs...) {
		assetURL, uerr := s.uploadAsset(created.Number, u.name, u.data, u.contentType)
		if uerr != nil {
			continue
		}
		if strings.HasPrefix(u.contentType, "image/") {
			links = append(links, fmt.Sprintf("![%s](%s)", u.name, assetURL))
		} else {
			links = append(links, fmt.Sprintf("[%s](%s)", u.name, assetURL))
		}
	}
	if len(links) > 0 {
		_ = s.patchIssue(created.Number, issueBody+"\n\n---\n\n"+strings.Join(links, "\n\n"))
	}

	s.remember(key, dedupEntry{number: created.Number, url: created.HTMLURL, at: s.now()})
	writeOutcome(w, http.StatusOK, Outcome{OK: true, Kind: "created", Message: fmt.Sprintf("已提交 #%d", created.Number), Number: created.Number, URL: created.HTMLURL})
}

// collectResult 是文件校验失败的结局。
type collectResult struct {
	status  int
	outcome Outcome
}

// collectFiles 校验并读取某字段的文件：张数、单文件体积、图片格式（仅图片时）。
func (s *Service) collectFiles(r *http.Request, field string, maxCount int, maxBytes int64, imageOnly bool) ([]upload, *collectResult) {
	if r.MultipartForm == nil {
		return nil, nil
	}
	fhs := r.MultipartForm.File[field]
	if len(fhs) == 0 {
		return nil, nil
	}
	if len(fhs) > maxCount {
		return nil, &collectResult{status: http.StatusBadRequest, outcome: Outcome{Kind: "too_large", Message: fmt.Sprintf("%s 最多 %d 个", field, maxCount)}}
	}
	var out []upload
	for _, fh := range fhs {
		if fh.Size > maxBytes {
			return nil, &collectResult{status: http.StatusBadRequest, outcome: Outcome{Kind: "too_large", Message: fmt.Sprintf("附件 %s 超过 %d 字节上限", fh.Filename, maxBytes)}}
		}
		f, err := fh.Open()
		if err != nil {
			return nil, &collectResult{status: http.StatusBadRequest, outcome: Outcome{Kind: "invalid", Message: "读取附件失败"}}
		}
		data, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
		_ = f.Close()
		if err != nil {
			return nil, &collectResult{status: http.StatusBadRequest, outcome: Outcome{Kind: "invalid", Message: "读取附件失败"}}
		}
		if int64(len(data)) > maxBytes {
			return nil, &collectResult{status: http.StatusBadRequest, outcome: Outcome{Kind: "too_large", Message: fmt.Sprintf("附件 %s 超过 %d 字节上限", fh.Filename, maxBytes)}}
		}
		ct := http.DetectContentType(data)
		if imageOnly && !strings.HasPrefix(ct, "image/png") && !strings.HasPrefix(ct, "image/jpeg") {
			return nil, &collectResult{status: http.StatusBadRequest, outcome: Outcome{Kind: "invalid", Message: fmt.Sprintf("附件 %s 不是支持的图片（png/jpg）", fh.Filename)}}
		}
		out = append(out, upload{name: fh.Filename, data: data, contentType: ct})
	}
	return out, nil
}

// metadata 是写进 issue 正文的上下文。
type metadata struct {
	version   string
	build     string
	os        string
	boardName string
	contact   string
}

// composeBody 把用户正文与上下文拼成 issue 正文；不写任何密钥。
func composeBody(body string, m metadata) string {
	var b strings.Builder
	b.WriteString(body)
	b.WriteString("\n\n---\n\n")
	if m.version != "" {
		b.WriteString("- 版本：" + m.version)
		if m.build != "" {
			b.WriteString(" (" + m.build + ")")
		}
		b.WriteString("\n")
	}
	if m.os != "" {
		b.WriteString("- 系统：" + m.os + "\n")
	}
	if m.boardName != "" {
		b.WriteString("- 画板：" + m.boardName + "\n")
	}
	if m.contact != "" {
		b.WriteString("- 提交者：" + m.contact + "\n")
	} else {
		b.WriteString("- 提交者：匿名\n")
	}
	b.WriteString("\n_经反馈中继提交_")
	return b.String()
}

// ---- Gitea 客户端 ----

type createdIssue struct {
	Number  int    `json:"number"`
	HTMLURL string `json:"html_url"`
}

func (s *Service) apiURL(path string) string {
	return strings.TrimRight(s.cfg.GiteaBase, "/") + "/api/v1" + path
}

func (s *Service) doJSON(method, path string, in any, out any) error {
	var rdr io.Reader
	if in != nil {
		raw, _ := json.Marshal(in)
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, s.apiURL(path), rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "token "+s.cfg.Token)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("请求 Gitea 失败：%w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Gitea 返回 %d", resp.StatusCode)
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("解析 Gitea 响应失败：%w", err)
		}
	}
	return nil
}

func (s *Service) createIssue(title, body, category string) (createdIssue, error) {
	opt := map[string]any{"title": title, "body": body}
	if ids := s.labelIDs(category); len(ids) > 0 {
		opt["labels"] = ids
	}
	var out createdIssue
	err := s.doJSON(http.MethodPost, fmt.Sprintf("/repos/%s/issues", s.cfg.OwnerRepo), opt, &out)
	return out, err
}

func (s *Service) patchIssue(number int, body string) error {
	return s.doJSON(http.MethodPatch, fmt.Sprintf("/repos/%s/issues/%d", s.cfg.OwnerRepo, number), map[string]string{"body": body}, nil)
}

// labelIDs 取该分类要打的 label 的数据库 ID；标签缓存失败时返回空（issue 仍建成，只是没标签）。
func (s *Service) labelIDs(category string) []int64 {
	m := s.labelMap()
	var ids []int64
	for _, name := range []string{"type/" + category, "source/app"} {
		if id, ok := m[name]; ok && id != 0 {
			ids = append(ids, id)
		}
	}
	return ids
}

func (s *Service) labelMap() map[string]int64 {
	s.mu.Lock()
	if s.labels != nil && s.now().Sub(s.labelAt) < 10*time.Minute {
		m := s.labels
		s.mu.Unlock()
		return m
	}
	s.mu.Unlock()

	var rows []struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	m := map[string]int64{}
	if err := s.doJSON(http.MethodGet, fmt.Sprintf("/repos/%s/labels?limit=50", s.cfg.OwnerRepo), nil, &rows); err == nil {
		for _, r := range rows {
			m[r.Name] = r.ID
		}
	}
	s.mu.Lock()
	s.labels = m
	s.labelAt = s.now()
	s.mu.Unlock()
	return m
}

// uploadAsset 把一张附件挂到 issue 上；字段名是 Gitea 的 attachment，文件名走 query name。
func (s *Service) uploadAsset(number int, name string, data []byte, contentType string) (string, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf("form-data; name=%q; filename=%q", "attachment", name))
	h.Set("Content-Type", contentType)
	part, err := mw.CreatePart(h)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(data); err != nil {
		return "", err
	}
	_ = mw.Close()

	u := s.apiURL(fmt.Sprintf("/repos/%s/issues/%d/assets", s.cfg.OwnerRepo, number)) + "?name=" + url.QueryEscape(name)
	req, err := http.NewRequest(http.MethodPost, u, &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "token "+s.cfg.Token)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := s.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("上传附件失败：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("上传附件 Gitea 返回 %d", resp.StatusCode)
	}
	var out struct {
		BrowserDownloadURL string `json:"browser_download_url"`
	}
	_ = json.Unmarshal(raw, &out)
	return out.BrowserDownloadURL, nil
}

// ---- 限流 / 去重 / 工具 ----

func (s *Service) allow(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	b := s.rates[ip]
	if b == nil || now.Sub(b.start) >= time.Minute {
		b = &rateBucket{start: now}
		s.rates[ip] = b
	}
	b.count++
	if len(s.rates) > 4096 {
		for k, v := range s.rates {
			if now.Sub(v.start) >= time.Minute {
				delete(s.rates, k)
			}
		}
	}
	return b.count <= s.cfg.RatePerMinute
}

func (s *Service) lookupDup(key string) (dedupEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.dedup[key]
	if !ok {
		return dedupEntry{}, false
	}
	if s.now().Sub(e.at) > s.cfg.DedupWindow {
		delete(s.dedup, key)
		return dedupEntry{}, false
	}
	return e, true
}

func (s *Service) remember(key string, e dedupEntry) {
	s.mu.Lock()
	s.dedup[key] = e
	s.mu.Unlock()
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func contentKey(body string, shots []upload) string {
	h := sha256.New()
	h.Write([]byte(body))
	for _, u := range shots {
		sum := sha256.Sum256(u.data)
		h.Write(sum[:])
	}
	return hex.EncodeToString(h.Sum(nil))
}

func firstRunes(s string, n int) string {
	s = strings.TrimSpace(strings.SplitN(s, "\n", 2)[0])
	r := []rune(s)
	if len(r) > n {
		r = r[:n]
	}
	if len(r) == 0 {
		return "反馈"
	}
	return string(r)
}

func writeOutcome(w http.ResponseWriter, status int, o Outcome) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(o)
}
