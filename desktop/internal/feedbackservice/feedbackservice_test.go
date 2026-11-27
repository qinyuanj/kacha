package feedbackservice

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type giteaCapture struct {
	requests   []string
	auth       []string
	issueCalls int
	title      string
	body       string
	labels     []int64
	patched    string
	assets     map[string][]byte
}

func newFakeGitea(t *testing.T) (*httptest.Server, func() giteaCapture) {
	t.Helper()
	var mu sync.Mutex
	var captured giteaCapture
	captured.assets = map[string][]byte{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		captured.requests = append(captured.requests, r.Method+" "+r.URL.Path)
		captured.auth = append(captured.auth, r.Header.Get("Authorization"))
		mu.Unlock()

		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/repos/o/r/labels":
			_, _ = io.WriteString(w, `[{"id":1,"name":"type/bug"},{"id":2,"name":"type/feature"},{"id":3,"name":"type/suggestion"},{"id":4,"name":"type/other"},{"id":5,"name":"source/app"}]`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/repos/o/r/issues":
			var issue struct {
				Title  string  `json:"title"`
				Body   string  `json:"body"`
				Labels []int64 `json:"labels"`
			}
			if err := json.NewDecoder(r.Body).Decode(&issue); err != nil {
				t.Errorf("decode issue: %v", err)
			}
			mu.Lock()
			captured.issueCalls++
			number := captured.issueCalls
			captured.title, captured.body, captured.labels = issue.Title, issue.Body, issue.Labels
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"number": number, "html_url": "http://gitea.test/issues/" + strconv.Itoa(number)})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/assets"):
			if err := r.ParseMultipartForm(8 << 20); err != nil {
				t.Errorf("ParseMultipartForm: %v", err)
			}
			file, header, err := r.FormFile("attachment")
			if err != nil {
				t.Errorf("FormFile: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			data, readErr := io.ReadAll(file)
			_ = file.Close()
			if readErr != nil {
				t.Errorf("read attachment: %v", readErr)
			}
			mu.Lock()
			captured.assets[header.Filename] = data
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{"browser_download_url": "http://gitea.test/assets/" + header.Filename})
		case r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/api/v1/repos/o/r/issues/"):
			var patch map[string]string
			_ = json.NewDecoder(r.Body).Decode(&patch)
			mu.Lock()
			captured.patched = patch["body"]
			mu.Unlock()
			_, _ = io.WriteString(w, `{}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	return server, func() giteaCapture {
		mu.Lock()
		defer mu.Unlock()
		return captured
	}
}

func sampleSpec() Spec {
	return Spec{
		Title: "登录失败", Category: "bug", Body: "点登录后没有反应",
		Version: "1.7.3", Build: "20261126", OS: "Windows 11",
		BoardName: "战斗草稿", Contact: "artist@example.com",
	}
}

func TestSendDirectCreatesIssueUploadsAttachmentsAndRedacts(t *testing.T) {
	server, capture := newFakeGitea(t)
	defer server.Close()
	auth := &fakeAuth{token: "stored-oauth-token"}
	svc := New(Config{GiteaBase: server.URL, OwnerRepo: "o/r", Auth: auth})
	spec := sampleSpec()
	spec.Title = `草稿 C:\Users\me\draft.md 上的错误 ` + bareHexTokenFixture
	spec.Body = "api_key=hunter2 " + barePlaceholderFixture
	spec.Screenshots = []Attachment{
		{Name: "画面.png", ContentType: "image/png", Data: []byte{0x89, 'P', 'N', 'G', 1}},
		{Name: "另一张.jpg", ContentType: "image/jpeg", Data: []byte{0xff, 0xd8, 0xff, 1}},
	}
	spec.DiagnosticsPack = &Attachment{Name: "diagnostics.zip", ContentType: "application/zip", Data: []byte{'P', 'K', 3, 4}}

	out := svc.Send(spec)
	if !out.OK || out.Kind != KindOK || out.Number != 1 {
		t.Fatalf("Send() = %+v", out)
	}
	got := capture()
	if got.issueCalls != 1 || !reflect.DeepEqual(got.labels, []int64{1, 5}) {
		t.Fatalf("issue calls=%d labels=%v", got.issueCalls, got.labels)
	}
	for _, secret := range []string{"hunter2", bareHexTokenFixture, barePlaceholderFixture, `C:\Users\me`} {
		if strings.Contains(got.title+got.body, secret) {
			t.Fatalf("issue still contains secret/path %q: title=%q body=%q", secret, got.title, got.body)
		}
	}
	if !strings.Contains(got.body, "[REDACTED]") || !strings.Contains(got.body, "_由 Kacha 直接提交_") {
		t.Fatalf("issue body missing redaction/direct marker: %q", got.body)
	}
	for name, want := range map[string][]byte{
		"画面.png": {0x89, 'P', 'N', 'G', 1}, "另一张.jpg": {0xff, 0xd8, 0xff, 1}, "diagnostics.zip": {'P', 'K', 3, 4},
	} {
		if data := got.assets[name]; !reflect.DeepEqual(data, want) {
			t.Fatalf("asset %q = %v, want %v", name, data, want)
		}
	}
	for _, link := range []string{"![画面.png]", "![另一张.jpg]", "[diagnostics.zip]"} {
		if !strings.Contains(got.patched, link) {
			t.Fatalf("patched body missing %q: %q", link, got.patched)
		}
	}
	for _, request := range got.requests {
		if strings.Contains(request, "/api/feedback") {
			t.Fatalf("request still targets relay: %q", request)
		}
	}
}

func TestCategoryCodesBecomeChineseTitlesAndLabels(t *testing.T) {
	cases := []struct {
		code  string
		label string
		id    int64
	}{{"bug", "缺陷", 1}, {"feature", "需求", 2}, {"suggestion", "建议", 3}, {"other", "其他", 4}}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			server, capture := newFakeGitea(t)
			defer server.Close()
			spec := sampleSpec()
			spec.Title, spec.Category = "", tc.code
			out := New(Config{GiteaBase: server.URL, OwnerRepo: "o/r", Auth: &fakeAuth{token: "token"}}).Send(spec)
			if !out.OK {
				t.Fatalf("Send() = %+v", out)
			}
			got := capture()
			if !strings.HasPrefix(got.title, "["+tc.label+"]") || !reflect.DeepEqual(got.labels, []int64{tc.id, 5}) {
				t.Fatalf("title=%q labels=%v", got.title, got.labels)
			}
		})
	}
}

func TestSendRejectsInvalidInputBeforeNetwork(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*Spec)
		want Outcome
	}{
		{name: "body", mut: func(s *Spec) { s.Body = " " }, want: Outcome{Kind: KindInvalid, Message: MessageInvalid}},
		{name: "category", mut: func(s *Spec) { s.Category = "unknown" }, want: Outcome{Kind: KindInvalid, Message: MessageInvalid}},
		{name: "format", mut: func(s *Spec) {
			s.Screenshots = []Attachment{{Name: "说明.txt", ContentType: "text/plain", Data: []byte("x")}}
		}, want: Outcome{Kind: KindInvalid, Message: MessageFormat}},
		{name: "size", mut: func(s *Spec) {
			s.Screenshots = []Attachment{{Name: "很大.png", ContentType: "image/png", Data: make([]byte, MaxScreenshotBytes+1)}}
		}, want: Outcome{Kind: KindTooLarge, Message: MessageBigShot}},
		{name: "count", mut: func(s *Spec) {
			for i := 0; i <= MaxScreenshots; i++ {
				s.Screenshots = append(s.Screenshots, Attachment{Name: "shot.png", ContentType: "image/png"})
			}
		}, want: Outcome{Kind: KindInvalid, Message: MessageTooMany}},
		{name: "diagnostics", mut: func(s *Spec) {
			s.DiagnosticsPack = &Attachment{Name: "diagnostics.zip", ContentType: "application/zip", Data: make([]byte, maxDiagnosticsPackBytes+1)}
		}, want: Outcome{Kind: KindTooLarge, Message: MessageBigPack}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, capture := newFakeGitea(t)
			defer server.Close()
			spec := sampleSpec()
			tc.mut(&spec)
			got := New(Config{GiteaBase: server.URL, OwnerRepo: "o/r", Auth: &fakeAuth{token: "token"}}).Send(spec)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Send() = %+v, want %+v", got, tc.want)
			}
			if len(capture().requests) != 0 {
				t.Fatalf("invalid input reached Gitea: %v", capture().requests)
			}
		})
	}
}

func TestSendMapsGiteaFailures(t *testing.T) {
	cases := []struct {
		status int
		want   Outcome
	}{
		{http.StatusUnauthorized, Outcome{Kind: KindUnauthorized, Message: MessageUnauthorized}},
		{http.StatusForbidden, Outcome{Kind: KindUnauthorized, Message: MessageUnauthorized}},
		{http.StatusBadRequest, Outcome{Kind: KindInvalid, Message: MessageInvalid}},
		{http.StatusUnprocessableEntity, Outcome{Kind: KindInvalid, Message: MessageInvalid}},
		{http.StatusRequestEntityTooLarge, Outcome{Kind: KindTooLarge, Message: MessageTooLarge}},
		{http.StatusInternalServerError, Outcome{Kind: KindRejected, Message: MessageRejected}},
	}
	for _, tc := range cases {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/repos/o/r/labels" {
					_, _ = io.WriteString(w, `[]`)
					return
				}
				w.WriteHeader(tc.status)
			}))
			defer server.Close()
			got := New(Config{GiteaBase: server.URL, OwnerRepo: "o/r", Auth: &fakeAuth{token: "token"}}).Send(sampleSpec())
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Send() = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestSendUnreachableGiteaIsStable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	address := server.URL
	server.Close()
	got := New(Config{GiteaBase: address, OwnerRepo: "o/r", Auth: &fakeAuth{token: "token"}}).Send(sampleSpec())
	want := Outcome{Kind: KindUnreachable, Message: MessageUnreachable}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Send() = %+v, want %+v", got, want)
	}
}

func TestSendDeduplicatesByTokenAndContentForTwoMinutes(t *testing.T) {
	server, capture := newFakeGitea(t)
	defer server.Close()
	auth := &fakeAuth{token: "alice"}
	svc := New(Config{GiteaBase: server.URL, OwnerRepo: "o/r", Auth: auth})
	now := time.Now()
	svc.now = func() time.Time { return now }

	first := svc.Send(sampleSpec())
	second := svc.Send(sampleSpec())
	if !first.OK || second.Kind != KindDuplicate || second.Number != first.Number || capture().issueCalls != 1 {
		t.Fatalf("first=%+v second=%+v issue calls=%d", first, second, capture().issueCalls)
	}
	changed := sampleSpec()
	changed.Body = "改过的正文"
	if out := svc.Send(changed); out.Kind != KindOK || capture().issueCalls != 2 {
		t.Fatalf("changed content: %+v, issue calls=%d", out, capture().issueCalls)
	}
	auth.token = "bob"
	if out := svc.Send(sampleSpec()); out.Kind != KindOK || capture().issueCalls != 3 {
		t.Fatalf("different token: %+v, issue calls=%d", out, capture().issueCalls)
	}
	now = now.Add(dedupWindow + time.Second)
	if out := svc.Send(sampleSpec()); out.Kind != KindOK || capture().issueCalls != 4 {
		t.Fatalf("after dedup window: %+v, issue calls=%d", out, capture().issueCalls)
	}
}

// 裸凭据夹具：与 redaction 包同一组值，两端都不许漏。
const (
	bareHexTokenFixture    = "0123456789abcdef0123456789abcdef01234567"
	barePlaceholderFixture = "{{SECRET" + "_fixture}}"
)
