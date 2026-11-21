package feedbackrelay

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type issueRequest struct {
	Title  string  `json:"title"`
	Body   string  `json:"body"`
	Labels []int64 `json:"labels"`
}

type assetUpload struct {
	Name        string
	ContentType string
	Size        int
}

var labelIDNames = map[int64]string{
	1: "type/bug",
	2: "type/feature",
	3: "type/suggestion",
	4: "type/other",
	5: "source/app",
}

// fakeGitea 是测试用的假 Gitea：记录创建 issue、回写正文与附件上传，可注入创建失败。
type fakeGitea struct {
	*httptest.Server
	mu            sync.Mutex
	issues        []issueRequest
	patchedBodies []string
	assets        []assetUpload
	failStatus    int
}

func newFakeGitea(t *testing.T) *fakeGitea {
	t.Helper()
	f := &fakeGitea{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/repos/{owner}/{repo}/labels", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `[{"id":1,"name":"type/bug"},{"id":2,"name":"type/feature"},{"id":3,"name":"type/suggestion"},{"id":4,"name":"type/other"},{"id":5,"name":"source/app"}]`)
	})
	mux.HandleFunc("POST /api/v1/repos/{owner}/{repo}/issues", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		status := f.failStatus
		f.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		var issue issueRequest
		if err := json.NewDecoder(r.Body).Decode(&issue); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.issues = append(f.issues, issue)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"number":42,"html_url":"http://fake/issues/42"}`)
	})
	mux.HandleFunc("PATCH /api/v1/repos/{owner}/{repo}/issues/{index}", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.patchedBodies = append(f.patchedBodies, string(raw))
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "{}")
	})
	mux.HandleFunc("POST /api/v1/repos/{owner}/{repo}/issues/{index}/assets", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		raw, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.assets = append(f.assets, assetUpload{Name: name, ContentType: r.Header.Get("Content-Type"), Size: len(raw)})
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"browser_download_url":"http://fake/assets/`+name+`"}`)
	})
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

func (f *fakeGitea) snapshot() ([]issueRequest, []string, []assetUpload) {
	f.mu.Lock()
	defer f.mu.Unlock()
	issues := append([]issueRequest(nil), f.issues...)
	bodies := append([]string(nil), f.patchedBodies...)
	assets := append([]assetUpload(nil), f.assets...)
	return issues, bodies, assets
}

func (f *fakeGitea) setFailStatus(status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failStatus = status
}

func newSvc(f *fakeGitea, mutate func(*Config)) *Service {
	c := Config{GiteaBase: f.URL, OwnerRepo: "o/r", Token: "runtime-token"}
	if mutate != nil {
		mutate(&c)
	}
	return New(c)
}

func multipartBody(t *testing.T, fields map[string]string, screenshots map[string][]byte, diagnostics []byte) (io.Reader, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		_ = mw.WriteField(k, v)
	}
	for name, data := range screenshots {
		fw, err := mw.CreateFormFile("screenshots[]", name)
		if err != nil {
			t.Fatalf("CreateFormFile(%s): %v", name, err)
		}
		_, _ = fw.Write(data)
	}
	if diagnostics != nil {
		fw, err := mw.CreateFormFile("diagnostics_pack", "diagnostics.zip")
		if err != nil {
			t.Fatalf("CreateFormFile(diagnostics): %v", err)
		}
		_, _ = fw.Write(diagnostics)
	}
	_ = mw.Close()
	return bytes.NewReader(buf.Bytes()), mw.FormDataContentType()
}

func pngBytes() []byte {
	return append([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}, bytes.Repeat([]byte{0}, 64)...)
}

func postFeedback(t *testing.T, handler http.Handler, body io.Reader, ct, key, remoteAddr string) (int, Outcome) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/feedback", body)
	req.Header.Set("Content-Type", ct)
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	if remoteAddr != "" {
		req.RemoteAddr = remoteAddr
	}
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	resp := rr.Result()
	defer resp.Body.Close()
	var outcome Outcome
	if err := json.NewDecoder(resp.Body).Decode(&outcome); err != nil {
		t.Fatalf("decode outcome: %v (body %q)", err, rr.Body.String())
	}
	return resp.StatusCode, outcome
}

func labelNames(ids []int64) string {
	names := make([]string, 0, len(ids))
	for _, id := range ids {
		names = append(names, labelIDNames[id])
	}
	return strings.Join(names, ",")
}

func assetNames(assets []assetUpload) string {
	names := make([]string, 0, len(assets))
	for _, a := range assets {
		names = append(names, a.Name)
	}
	return strings.Join(names, ",")
}

func TestHealthz(t *testing.T) {
	h := newSvc(newFakeGitea(t), nil).Handler()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	resp := rr.Result()
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(raw)) != "ok" {
		t.Fatalf("healthz status=%d body=%q", resp.StatusCode, raw)
	}
}

func TestFeedbackCreatesIssueWithAllFieldsAndAttachments(t *testing.T) {
	f := newFakeGitea(t)
	diagnostics := append([]byte{'P', 'K', 3, 4}, []byte("diagnostics")...)
	body, ct := multipartBody(t, map[string]string{
		"title":      "自定义标题",
		"category":   "bug",
		"body":       "第一行\n第二行",
		"version":    "1.6.9",
		"build":      "42",
		"os":         "Windows 11",
		"board_name": "主画板",
		"contact":    "美术A",
	}, map[string][]byte{"shot.png": pngBytes()}, diagnostics)

	status, outcome := postFeedback(t, newSvc(f, nil).Handler(), body, ct, "all-fields", "")
	if status != http.StatusOK || !outcome.OK || outcome.Kind != "created" || outcome.Number != 42 || outcome.URL != "http://fake/issues/42" {
		t.Fatalf("status=%d outcome=%+v", status, outcome)
	}

	issues, patched, assets := f.snapshot()
	if len(issues) != 1 {
		t.Fatalf("issues=%d", len(issues))
	}
	if issues[0].Title != "自定义标题" {
		t.Fatalf("title=%q", issues[0].Title)
	}
	for _, want := range []string{"第一行\n第二行", "1.6.9", "42", "Windows 11", "主画板", "美术A"} {
		if !strings.Contains(issues[0].Body, want) {
			t.Fatalf("issue body missing %q: %q", want, issues[0].Body)
		}
	}
	if got := labelNames(issues[0].Labels); got != "type/bug,source/app" {
		t.Fatalf("labels=%s", got)
	}
	if got := assetNames(assets); got != "shot.png,diagnostics.zip" {
		t.Fatalf("assets=%s", got)
	}
	if len(patched) != 1 {
		t.Fatalf("patched bodies=%d", len(patched))
	}
	for _, link := range []string{
		"![shot.png](http://fake/assets/shot.png)",
		"[diagnostics.zip](http://fake/assets/diagnostics.zip)",
	} {
		if !strings.Contains(patched[0], link) {
			t.Fatalf("patched issue body missing %q: %s", link, patched[0])
		}
	}
}

func TestDefaultTitleAndAnonymousContact(t *testing.T) {
	f := newFakeGitea(t)
	body, ct := multipartBody(t, map[string]string{
		"category": "feature",
		"body":     "希望增加导出\n第二行",
	}, nil, nil)
	status, outcome := postFeedback(t, newSvc(f, nil).Handler(), body, ct, "default-title", "")
	if status != http.StatusOK || !outcome.OK {
		t.Fatalf("status=%d outcome=%+v", status, outcome)
	}
	issues, _, _ := f.snapshot()
	if len(issues) != 1 || issues[0].Title != "[需求] 希望增加导出" {
		t.Fatalf("issues=%+v", issues)
	}
	if !strings.Contains(issues[0].Body, "- 提交者：匿名") {
		t.Fatalf("missing anonymous contact: %q", issues[0].Body)
	}
	if got := labelNames(issues[0].Labels); got != "type/feature,source/app" {
		t.Fatalf("labels=%s", got)
	}
}

func TestCategoryLabels(t *testing.T) {
	f := newFakeGitea(t)
	h := newSvc(f, nil).Handler()
	cases := []struct{ category, label string }{
		{"bug", "type/bug"},
		{"feature", "type/feature"},
		{"suggestion", "type/suggestion"},
		{"other", "type/other"},
	}
	for _, tc := range cases {
		body, ct := multipartBody(t, map[string]string{"category": tc.category, "body": "分类 " + tc.category}, nil, nil)
		if status, outcome := postFeedback(t, h, body, ct, "cat-"+tc.category, ""); status != http.StatusOK || !outcome.OK {
			t.Fatalf("%s: status=%d outcome=%+v", tc.category, status, outcome)
		}
	}
	issues, _, _ := f.snapshot()
	if len(issues) != len(cases) {
		t.Fatalf("issues=%d", len(issues))
	}
	for i, tc := range cases {
		want := tc.label + ",source/app"
		if got := labelNames(issues[i].Labels); got != want {
			t.Fatalf("%s labels=%s want=%s", tc.category, got, want)
		}
	}
}

func TestMissingCategoryDefaultsToOther(t *testing.T) {
	f := newFakeGitea(t)
	body, ct := multipartBody(t, map[string]string{"body": "没有分类"}, nil, nil)
	if status, outcome := postFeedback(t, newSvc(f, nil).Handler(), body, ct, "no-category", ""); status != http.StatusOK || !outcome.OK {
		t.Fatalf("status=%d outcome=%+v", status, outcome)
	}
	issues, _, _ := f.snapshot()
	if len(issues) != 1 || labelNames(issues[0].Labels) != "type/other,source/app" {
		t.Fatalf("issues=%+v", issues)
	}
}

func TestInvalidCategoryRejected(t *testing.T) {
	f := newFakeGitea(t)
	body, ct := multipartBody(t, map[string]string{"category": "urgent", "body": "无效分类"}, nil, nil)
	status, outcome := postFeedback(t, newSvc(f, nil).Handler(), body, ct, "bad-category", "")
	if status != http.StatusBadRequest || outcome.Kind != "invalid" {
		t.Fatalf("status=%d outcome=%+v", status, outcome)
	}
	issues, _, _ := f.snapshot()
	if len(issues) != 0 {
		t.Fatalf("invalid category created issue: %+v", issues)
	}
}

func TestEmptyBodyRejected(t *testing.T) {
	f := newFakeGitea(t)
	body, ct := multipartBody(t, map[string]string{"category": "bug", "body": "   "}, nil, nil)
	status, outcome := postFeedback(t, newSvc(f, nil).Handler(), body, ct, "empty-body", "")
	if status != http.StatusBadRequest || outcome.Kind != "invalid" {
		t.Fatalf("status=%d outcome=%+v", status, outcome)
	}
}

func TestRejectsMoreThanFiveScreenshots(t *testing.T) {
	f := newFakeGitea(t)
	shots := map[string][]byte{}
	for i := 0; i < 6; i++ {
		shots[fmt.Sprintf("shot%d.png", i)] = pngBytes()
	}
	body, ct := multipartBody(t, map[string]string{"body": "六张截图"}, shots, nil)
	status, outcome := postFeedback(t, newSvc(f, nil).Handler(), body, ct, "six-shots", "")
	if status != http.StatusBadRequest || outcome.Kind != "too_large" {
		t.Fatalf("status=%d outcome=%+v", status, outcome)
	}
	issues, _, _ := f.snapshot()
	if len(issues) != 0 {
		t.Fatalf("too many screenshots created issue: %+v", issues)
	}
}

func TestRejectsOversizedScreenshot(t *testing.T) {
	f := newFakeGitea(t)
	h := newSvc(f, func(c *Config) { c.MaxScreenshotBytes = 32 }).Handler()
	shot := append(pngBytes(), bytes.Repeat([]byte{'x'}, 16)...)
	body, ct := multipartBody(t, map[string]string{"body": "大图"}, map[string][]byte{"big.png": shot}, nil)
	status, outcome := postFeedback(t, h, body, ct, "big-shot", "")
	if status != http.StatusRequestEntityTooLarge || outcome.Kind != "too_large" {
		t.Fatalf("status=%d outcome=%+v", status, outcome)
	}
}

func TestRejectsRequestOver20MB(t *testing.T) {
	f := newFakeGitea(t)
	body, ct := multipartBody(t, map[string]string{"body": strings.Repeat("x", (20<<20)+1024)}, nil, nil)
	status, outcome := postFeedback(t, newSvc(f, nil).Handler(), body, ct, "huge-body", "")
	if status != http.StatusRequestEntityTooLarge || outcome.Kind != "too_large" {
		t.Fatalf("status=%d outcome=%+v", status, outcome)
	}
	issues, _, _ := f.snapshot()
	if len(issues) != 0 {
		t.Fatalf("oversized request created issue: %+v", issues)
	}
}

func TestRateLimitIsPerIP(t *testing.T) {
	f := newFakeGitea(t)
	h := newSvc(f, func(c *Config) { c.RatePerMinute = 1 }).Handler()
	post := func(bodyText, key, addr string) (int, Outcome) {
		body, ct := multipartBody(t, map[string]string{"body": bodyText}, nil, nil)
		return postFeedback(t, h, body, ct, key, addr)
	}
	if status, outcome := post("first", "ip-1-a", "192.0.2.10:1000"); status != http.StatusOK || !outcome.OK {
		t.Fatalf("first: status=%d outcome=%+v", status, outcome)
	}
	if status, outcome := post("second", "ip-1-b", "192.0.2.10:1001"); status != http.StatusTooManyRequests || outcome.Kind != "rate_limited" {
		t.Fatalf("same IP: status=%d outcome=%+v", status, outcome)
	}
	if status, outcome := post("third", "ip-2-a", "192.0.2.11:1000"); status != http.StatusOK || !outcome.OK {
		t.Fatalf("other IP: status=%d outcome=%+v", status, outcome)
	}
	issues, _, _ := f.snapshot()
	if len(issues) != 2 {
		t.Fatalf("issues=%d", len(issues))
	}
}

func TestDedupWithinWindow(t *testing.T) {
	f := newFakeGitea(t)
	h := newSvc(f, nil).Handler()
	send := func() (int, Outcome) {
		body, ct := multipartBody(t, map[string]string{"body": "dup"}, map[string][]byte{"a.png": pngBytes()}, nil)
		return postFeedback(t, h, body, ct, "K1", "")
	}
	status, first := send()
	if status != http.StatusOK || first.Kind != "created" {
		t.Fatalf("first: status=%d outcome=%+v", status, first)
	}
	status, again := send()
	if status != http.StatusOK || again.Kind != "duplicate" || again.Number != 42 || again.URL != "http://fake/issues/42" {
		t.Fatalf("duplicate: status=%d outcome=%+v", status, again)
	}
	issues, _, assets := f.snapshot()
	if len(issues) != 1 || len(assets) != 1 {
		t.Fatalf("issues=%d assets=%d", len(issues), len(assets))
	}
}

func TestDedupWindowExpiry(t *testing.T) {
	f := newFakeGitea(t)
	h := newSvc(f, func(c *Config) { c.DedupWindow = 20 * time.Millisecond }).Handler()
	send := func() (int, Outcome) {
		body, ct := multipartBody(t, map[string]string{"body": "expire"}, nil, nil)
		return postFeedback(t, h, body, ct, "K2", "")
	}
	if status, outcome := send(); status != http.StatusOK || outcome.Kind != "created" {
		t.Fatalf("first: status=%d outcome=%+v", status, outcome)
	}
	time.Sleep(50 * time.Millisecond)
	if status, outcome := send(); status != http.StatusOK || outcome.Kind != "created" {
		t.Fatalf("after expiry: status=%d outcome=%+v", status, outcome)
	}
	issues, _, _ := f.snapshot()
	if len(issues) != 2 {
		t.Fatalf("issues=%d", len(issues))
	}
}

func TestDedupKeyReuseWithDifferentBodyRejected(t *testing.T) {
	f := newFakeGitea(t)
	h := newSvc(f, nil).Handler()
	send := func(text string) (int, Outcome) {
		body, ct := multipartBody(t, map[string]string{"body": text}, nil, nil)
		return postFeedback(t, h, body, ct, "K3", "")
	}
	if status, outcome := send("original"); status != http.StatusOK || outcome.Kind != "created" {
		t.Fatalf("first: status=%d outcome=%+v", status, outcome)
	}
	if status, outcome := send("different"); status != http.StatusConflict || outcome.Kind != "invalid" {
		t.Fatalf("reused key: status=%d outcome=%+v", status, outcome)
	}
	issues, _, _ := f.snapshot()
	if len(issues) != 1 {
		t.Fatalf("issues=%d", len(issues))
	}
}

func TestRejectsBadImage(t *testing.T) {
	f := newFakeGitea(t)
	body, ct := multipartBody(t, map[string]string{"body": "x"}, map[string][]byte{"a.txt": []byte("hello")}, nil)
	status, outcome := postFeedback(t, newSvc(f, nil).Handler(), body, ct, "bad-image", "")
	if status != http.StatusBadRequest || outcome.Kind != "invalid" {
		t.Fatalf("status=%d outcome=%+v", status, outcome)
	}
}

func TestGiteaCreateFailureReturnsTypedOutcome(t *testing.T) {
	f := newFakeGitea(t)
	f.setFailStatus(http.StatusInternalServerError)
	body, ct := multipartBody(t, map[string]string{"body": "x"}, nil, nil)
	status, outcome := postFeedback(t, newSvc(f, nil).Handler(), body, ct, "gitea-fail", "")
	if status != http.StatusBadGateway || outcome.Kind != "failed" || !strings.Contains(outcome.Message, "Gitea") {
		t.Fatalf("status=%d outcome=%+v", status, outcome)
	}
}

func TestGiteaUnreachableReturnsTypedOutcome(t *testing.T) {
	f := newFakeGitea(t)
	f.Close()
	body, ct := multipartBody(t, map[string]string{"body": "x"}, nil, nil)
	status, outcome := postFeedback(t, newSvc(f, nil).Handler(), body, ct, "gitea-down", "")
	if status != http.StatusBadGateway || outcome.Kind != "failed" || outcome.OK {
		t.Fatalf("status=%d outcome=%+v", status, outcome)
	}
}
