package feedbackrelay

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// fakeGitea 是测试用的假 Gitea：记录创建 issue 与上传附件，可注入失败。
type fakeGitea struct {
	*httptest.Server
	mu         sync.Mutex
	issues     []map[string]any
	assets     []string
	failCreate bool
}

func newFakeGitea(t *testing.T) *fakeGitea {
	t.Helper()
	f := &fakeGitea{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/repos/{owner}/{repo}/labels", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `[{"id":1,"name":"type/bug"},{"id":2,"name":"type/feature"},{"id":5,"name":"source/app"}]`)
	})
	mux.HandleFunc("POST /api/v1/repos/{owner}/{repo}/issues", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		fail := f.failCreate
		f.mu.Unlock()
		if fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		f.mu.Lock()
		f.issues = append(f.issues, m)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"number":42,"html_url":"http://fake/issues/42"}`)
	})
	mux.HandleFunc("POST /api/v1/repos/{owner}/{repo}/issues/{index}/assets", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		f.mu.Lock()
		f.assets = append(f.assets, name)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"browser_download_url":"http://fake/assets/`+name+`"}`)
	})
	mux.HandleFunc("PATCH /api/v1/repos/{owner}/{repo}/issues/{index}", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "{}")
	})
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

func newSvc(f *fakeGitea, mutate func(*Config)) *Service {
	c := Config{GiteaBase: f.URL, OwnerRepo: "o/r", Token: "t"}
	if mutate != nil {
		mutate(&c)
	}
	return New(c)
}

func multipartBody(t *testing.T, fields map[string]string, files map[string][]byte) (io.Reader, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		_ = mw.WriteField(k, v)
	}
	for name, data := range files {
		fw, err := mw.CreateFormFile("screenshots", name)
		if err != nil {
			t.Fatalf("CreateFormFile: %v", err)
		}
		_, _ = fw.Write(data)
	}
	_ = mw.Close()
	return &buf, mw.FormDataContentType()
}

func pngBytes() []byte {
	return append([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}, bytes.Repeat([]byte{0}, 64)...)
}

func post(t *testing.T, url string, body io.Reader, ct, idem string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url+"/api/feedback", body)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", ct)
	if idem != "" {
		req.Header.Set("Idempotency-Key", idem)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	return resp
}

func decode(t *testing.T, resp *http.Response) Outcome {
	t.Helper()
	var o Outcome
	_ = json.NewDecoder(resp.Body).Decode(&o)
	_ = resp.Body.Close()
	return o
}

func TestFeedbackCreatesIssueAndAsset(t *testing.T) {
	f := newFakeGitea(t)
	srv := httptest.NewServer(newSvc(f, nil).Handler())
	defer srv.Close()

	body, ct := multipartBody(t,
		map[string]string{"category": "bug", "body": "第一行\n第二行", "version": "1.6.9", "os": "Windows"},
		map[string][]byte{"shot.png": pngBytes()})
	resp := post(t, srv.URL, body, ct, "")
	o := decode(t, resp)

	if resp.StatusCode != http.StatusOK || !o.OK || o.Number != 42 || o.URL != "http://fake/issues/42" {
		t.Fatalf("got status=%d outcome=%+v", resp.StatusCode, o)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.issues) != 1 {
		t.Fatalf("issues=%d", len(f.issues))
	}
	if len(f.assets) != 1 || f.assets[0] != "shot.png" {
		t.Fatalf("assets=%v", f.assets)
	}
	labels, _ := f.issues[0]["labels"].([]any)
	if len(labels) != 2 {
		t.Fatalf("labels=%v", labels)
	}
}

func TestRateLimit(t *testing.T) {
	f := newFakeGitea(t)
	srv := httptest.NewServer(newSvc(f, func(c *Config) { c.RatePerMinute = 1 }).Handler())
	defer srv.Close()
	body := func() (io.Reader, string) {
		return multipartBody(t, map[string]string{"category": "other", "body": "x"}, nil)
	}
	b1, c1 := body()
	if o := decode(t, post(t, srv.URL, b1, c1, "")); !o.OK {
		t.Fatalf("first should pass: %+v", o)
	}
	b2, c2 := body()
	resp := post(t, srv.URL, b2, c2, "")
	o := decode(t, resp)
	if resp.StatusCode != http.StatusTooManyRequests || o.Kind != "rate_limited" {
		t.Fatalf("expected rate_limited, got %d %+v", resp.StatusCode, o)
	}
}

func TestRejectBadImage(t *testing.T) {
	f := newFakeGitea(t)
	srv := httptest.NewServer(newSvc(f, nil).Handler())
	defer srv.Close()
	body, ct := multipartBody(t, map[string]string{"body": "x"}, map[string][]byte{"a.txt": []byte("hello")})
	resp := post(t, srv.URL, body, ct, "")
	o := decode(t, resp)
	if resp.StatusCode != http.StatusBadRequest || o.Kind != "invalid" {
		t.Fatalf("expected invalid, got %d %+v", resp.StatusCode, o)
	}
}

func TestDedup(t *testing.T) {
	f := newFakeGitea(t)
	srv := httptest.NewServer(newSvc(f, nil).Handler())
	defer srv.Close()
	body1, ct1 := multipartBody(t, map[string]string{"body": "dup"}, map[string][]byte{"a.png": pngBytes()})
	if o := decode(t, post(t, srv.URL, body1, ct1, "K1")); o.Kind != "created" {
		t.Fatalf("first: %+v", o)
	}
	body2, ct2 := multipartBody(t, map[string]string{"body": "dup"}, map[string][]byte{"a.png": pngBytes()})
	o := decode(t, post(t, srv.URL, body2, ct2, "K1"))
	if o.Kind != "duplicate" || o.Number != 42 {
		t.Fatalf("expected duplicate #42, got %+v", o)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.issues) != 1 {
		t.Fatalf("should create only once, got %d", len(f.issues))
	}
}

func TestGiteaFailure(t *testing.T) {
	f := newFakeGitea(t)
	f.failCreate = true
	srv := httptest.NewServer(newSvc(f, nil).Handler())
	defer srv.Close()
	body, ct := multipartBody(t, map[string]string{"body": "x"}, nil)
	resp := post(t, srv.URL, body, ct, "")
	o := decode(t, resp)
	if resp.StatusCode != http.StatusBadGateway || o.Kind != "failed" {
		t.Fatalf("expected failed, got %d %+v", resp.StatusCode, o)
	}
}

func TestHealthz(t *testing.T) {
	f := newFakeGitea(t)
	srv := httptest.NewServer(newSvc(f, nil).Handler())
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz=%d", resp.StatusCode)
	}
}
