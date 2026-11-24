package feedbackauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	// GiteaBase 与 ClientID 指向已在 lzxsvn 注册的 Kacha Feedback 公共 OAuth 应用。
	DefaultGiteaBase    = "http://lzxsvn:3000"
	DefaultRedirectURL  = "http://127.0.0.1:53682/callback"
	DefaultClientID     = "adfb6d0e-6651-4b06-af76-987c2eea9e69"
	DefaultScopes       = "read:repository write:issue"
	MessageAuthorized   = "已完成 Gitea 授权"
	MessagePending      = "正在浏览器里完成 Gitea 授权"
	MessageUnauthorized = "尚未完成 Gitea 授权"
	MessageBusy         = "授权窗口已经打开，请在浏览器里完成"
	MessageFailed       = "Gitea 授权失败，请重试"
)

var ErrUnsupported = errors.New("当前平台不支持本机凭据保护")

// Status 是页面能看到的授权状态；故意不含 token。
type Status struct {
	Authorized bool   `json:"authorized"`
	Pending    bool   `json:"pending"`
	Message    string `json:"message"`
}

// Start 是一键授权的起点：URL 用作浏览器没自动打开时的兜底入口。
type Start struct {
	OK      bool   `json:"ok"`
	URL     string `json:"url"`
	Message string `json:"message"`
}

// Config 是授权服务的运行参数；测试可替换 listener、浏览器与 HTTP 客户端。
type Config struct {
	GiteaBase   string
	RedirectURL string
	ClientID    string
	Scopes      string
	RootFunc    func() string
	Store       tokenStore
	Listen      func(network, address string) (net.Listener, error)
	OpenBrowser func(string) error
	HTTPClient  *http.Client
}

type pendingAuth struct {
	state    string
	verifier string
	authURL  string
	done     chan error
	finished bool
	err      error
}

// Service 用授权码加 PKCE 从 Gitea 换取 token，只把 token 交给本机受保护存储。
type Service struct {
	cfg     Config
	store   tokenStore
	mu      sync.Mutex
	pending *pendingAuth
}

// New 构造授权服务。RootFunc 给的是当前数据根，token 密文随数据根一起迁移。
func New(cfg Config) *Service {
	if cfg.GiteaBase == "" {
		cfg.GiteaBase = DefaultGiteaBase
	}
	if cfg.RedirectURL == "" {
		cfg.RedirectURL = DefaultRedirectURL
	}
	if cfg.ClientID == "" {
		cfg.ClientID = DefaultClientID
	}
	if cfg.Scopes == "" {
		cfg.Scopes = DefaultScopes
	}
	if cfg.Listen == nil {
		cfg.Listen = net.Listen
	}
	if cfg.OpenBrowser == nil {
		cfg.OpenBrowser = openBrowser
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 20 * time.Second}
	}
	store := cfg.Store
	if store == nil {
		root := ""
		if cfg.RootFunc != nil {
			root = cfg.RootFunc()
		}
		store = newTokenStore(root)
	}
	return &Service{cfg: cfg, store: store}
}

// Token 给反馈发送使用；token 不经过页面，只在 Go 内存中短暂存在。
func (s *Service) Token() (string, error) {
	return s.store.Load()
}

// Status 只读本机 token 是否存在与当前授权窗口状态，不返回 token 本身。
func (s *Service) Status() Status {
	if token, err := s.Token(); err == nil && token != "" {
		return Status{Authorized: true, Message: MessageAuthorized}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.pending; p != nil {
		if p.finished {
			if p.err != nil {
				return Status{Message: MessageFailed}
			}
			return Status{Authorized: true, Message: MessageAuthorized}
		}
		return Status{Pending: true, Message: MessagePending}
	}
	return Status{Message: MessageUnauthorized}
}

// Reset 清除本机 token 和进行中的授权，下一次反馈需要重新授权。
func (s *Service) Reset() error {
	s.mu.Lock()
	s.pending = nil
	s.mu.Unlock()
	return s.store.Delete()
}

// Start 起一次性本机回调服务、打开浏览器，并返回可复制的授权地址。
func (s *Service) Start() Start {
	if token, err := s.Token(); err == nil && token != "" {
		return Start{OK: true, Message: MessageAuthorized}
	}
	s.mu.Lock()
	if p := s.pending; p != nil && !p.finished {
		url := p.authURL
		s.mu.Unlock()
		return Start{OK: true, URL: url, Message: MessageBusy}
	}
	s.mu.Unlock()

	state, err := randomString()
	if err != nil {
		return Start{Message: MessageFailed}
	}
	verifier, err := randomString()
	if err != nil {
		return Start{Message: MessageFailed}
	}
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	authURL, err := s.authorizeURL(state, challenge)
	if err != nil {
		return Start{Message: MessageFailed}
	}
	address, err := callbackAddress(s.cfg.RedirectURL)
	if err != nil {
		return Start{Message: MessageFailed}
	}
	listener, err := s.cfg.Listen("tcp", address)
	if err != nil {
		return Start{Message: "授权回调端口不可用，请稍后重试"}
	}
	p := &pendingAuth{state: state, verifier: verifier, authURL: authURL, done: make(chan error, 1)}
	s.mu.Lock()
	s.pending = p
	s.mu.Unlock()
	go s.serveOnce(listener, p)
	_ = s.cfg.OpenBrowser(authURL)
	return Start{OK: true, URL: authURL, Message: MessagePending}
}

func (s *Service) authorizeURL(state, challenge string) (string, error) {
	u, err := url.Parse(strings.TrimRight(s.cfg.GiteaBase, "/") + "/login/oauth/authorize")
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", s.cfg.ClientID)
	q.Set("redirect_uri", s.cfg.RedirectURL)
	q.Set("scope", s.cfg.Scopes)
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func callbackAddress(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", errors.New("invalid redirect URL")
	}
	return u.Host, nil
}

func (s *Service) serveOnce(listener net.Listener, p *pendingAuth) {
	mux := http.NewServeMux()
	path := "/callback"
	if u, err := url.Parse(s.cfg.RedirectURL); err == nil && u.Path != "" {
		path = u.Path
	}
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) { s.callback(w, r, p) })
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = server.Serve(listener) }()
	select {
	case <-p.done:
	case <-time.After(5 * time.Minute):
		s.finish(p, errors.New("authorization timeout"))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}

func (s *Service) callback(w http.ResponseWriter, r *http.Request, p *pendingAuth) {
	state := r.URL.Query().Get("state")
	code := r.URL.Query().Get("code")
	if errText := r.URL.Query().Get("error"); errText != "" || code == "" {
		s.finish(p, errors.New("authorization rejected"))
		http.Error(w, "授权未完成，请关闭窗口后重试", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	current := s.pending
	verifier := p.verifier
	s.mu.Unlock()
	if current != p || state != p.state {
		http.Error(w, "授权状态不匹配", http.StatusBadRequest)
		return
	}
	token, err := s.exchange(code, verifier)
	if err != nil {
		s.finish(p, err)
		http.Error(w, "换取授权失败，请关闭窗口后重试", http.StatusBadGateway)
		return
	}
	if err := s.store.Save(token); err != nil {
		s.finish(p, err)
		http.Error(w, "保存本机授权失败", http.StatusInternalServerError)
		return
	}
	s.finish(p, nil)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, "<!doctype html><meta charset='utf-8'><title>Kacha 授权完成</title><p>Kacha 已完成 Gitea 授权，可以关闭这个窗口。</p>")
}

func (s *Service) exchange(code, verifier string) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("client_id", s.cfg.ClientID)
	form.Set("redirect_uri", s.cfg.RedirectURL)
	form.Set("code_verifier", verifier)
	endpoint := strings.TrimRight(s.cfg.GiteaBase, "/") + "/login/oauth/access_token"
	req, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := s.cfg.HTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", errors.New("token endpoint rejected code")
	}
	var jsonResponse struct {
		AccessToken string `json:"access_token"`
	}
	if json.Unmarshal(data, &jsonResponse) == nil && jsonResponse.AccessToken != "" {
		return jsonResponse.AccessToken, nil
	}
	formResponse, err := url.ParseQuery(string(data))
	if err == nil && formResponse.Get("access_token") != "" {
		return formResponse.Get("access_token"), nil
	}
	return "", errors.New("token endpoint returned no access token")
}

func (s *Service) finish(p *pendingAuth, err error) {
	s.mu.Lock()
	if s.pending == p {
		p.finished = true
		p.err = err
	}
	s.mu.Unlock()
	select {
	case p.done <- err:
	default:
	}
}

func randomString() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func openBrowser(raw string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", raw).Start()
	case "darwin":
		return exec.Command("open", raw).Start()
	default:
		return exec.Command("xdg-open", raw).Start()
	}
}
