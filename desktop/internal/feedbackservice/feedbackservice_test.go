package feedbackservice

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/feedbackrelay"
)

type relayCapture struct {
	method          string
	path            string
	idempotencyKey  string
	fields          map[string]string
	files           map[string][]byte
	diagnosticNames []string
	calls           int
}

func newFakeRelay(t *testing.T, status int, outcome Outcome) (*httptest.Server, func() relayCapture) {
	t.Helper()
	var mu sync.Mutex
	var captured relayCapture
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			t.Errorf("ParseMultipartForm: %v", err)
		}
		fields := map[string]string{}
		for _, key := range []string{"title", "category", "body", "version", "build", "os", "board_name", "contact", "gitea_token"} {
			fields[key] = r.FormValue(key)
		}
		files := map[string][]byte{}
		var diagnosticNames []string
		for field, headers := range r.MultipartForm.File {
			for _, header := range headers {
				f, err := header.Open()
				if err == nil {
					data, readErr := io.ReadAll(f)
					_ = f.Close()
					if readErr == nil {
						files[header.Filename] = data
						if field == "diagnostics_pack" {
							diagnosticNames = append(diagnosticNames, header.Filename)
						}
					}
				}
			}
		}
		mu.Lock()
		captured = relayCapture{
			method:          r.Method,
			path:            r.URL.Path,
			idempotencyKey:  r.Header.Get("Idempotency-Key"),
			fields:          fields,
			files:           files,
			diagnosticNames: diagnosticNames,
			calls:           captured.calls + 1,
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(outcome)
	}))
	return server, func() relayCapture {
		mu.Lock()
		defer mu.Unlock()
		return captured
	}
}

func sampleSpec() Spec {
	return Spec{
		Title:      "登录失败",
		Category:   "bug",
		Body:       "点登录后没有反应",
		Version:    "1.6.8",
		Build:      "20261121",
		OS:         "Windows 11",
		BoardName:  "战斗草稿",
		Contact:    "artist@example.com",
		GiteaToken: "alice",
	}
}

func TestSendMapsFakeRelayOutcomesToStableKinds(t *testing.T) {
	cases := []struct {
		name   string
		status int
		relay  Outcome
		want   Outcome
	}{
		{
			name:   "ok",
			status: http.StatusOK,
			relay:  Outcome{OK: true, Kind: "created", Message: "已提交 #17", Number: 17, URL: "https://gitea.example/feedback/issues/17"},
			want:   Outcome{OK: true, Kind: "ok", Message: "已提交 #17", Number: 17, URL: "https://gitea.example/feedback/issues/17"},
		},
		{
			name:   "duplicate",
			status: http.StatusOK,
			relay:  Outcome{OK: true, Kind: "duplicate", Message: "刚刚已提交过 #17", Number: 17, URL: "https://gitea.example/feedback/issues/17"},
			want:   Outcome{OK: true, Kind: "duplicate", Message: "刚刚已提交过 #17", Number: 17, URL: "https://gitea.example/feedback/issues/17"},
		},
		{
			name:   "invalid",
			status: http.StatusBadRequest,
			relay:  Outcome{Kind: "invalid", Message: "不支持的分类"},
			want:   Outcome{Kind: "invalid", Message: "反馈内容不合法，请修改后重试"},
		},
		{
			name:   "too_large",
			status: http.StatusRequestEntityTooLarge,
			relay:  Outcome{Kind: "too_large", Message: "请求体过大"},
			want:   Outcome{Kind: "too_large", Message: "反馈内容过大，请精简后重试"},
		},
		{
			name:   "unauthorized",
			status: http.StatusUnauthorized,
			relay:  Outcome{Kind: "unauthorized", Message: "Gitea token 无效或权限不足"},
			want:   Outcome{Kind: "unauthorized", Message: "Gitea token 无效或权限不足"},
		},
		{
			name:   "rejected",
			status: http.StatusBadGateway,
			relay:  Outcome{Kind: "failed", Message: "创建 issue 失败：服务器无法写入 Gitea"},
			want:   Outcome{Kind: "rejected", Message: "反馈被中继拒绝，请稍后再试"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, captured := newFakeRelay(t, tc.status, tc.relay)
			defer server.Close()

			got := New(Config{RelayURL: server.URL}).Send(sampleSpec())
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Send outcome = %+v, want %+v", got, tc.want)
			}
			req := captured()
			if req.calls != 1 || req.method != http.MethodPost || req.path != "/api/feedback" {
				t.Fatalf("relay got %d requests, last %s %s", req.calls, req.method, req.path)
			}
			if req.idempotencyKey == "" {
				t.Fatal("relay did not receive an Idempotency-Key")
			}
		})
	}
}

func TestSendForwardsRequestGiteaToken(t *testing.T) {
	server, captured := newFakeRelay(t, http.StatusOK, Outcome{OK: true, Kind: "created", Message: "已提交 #1", Number: 1, URL: "http://fake/1"})
	defer server.Close()

	spec := sampleSpec()
	spec.GiteaToken = "alice"
	got := New(Config{RelayURL: server.URL}).Send(spec)
	if !got.OK || got.Kind != "ok" {
		t.Fatalf("Send outcome = %+v", got)
	}
	req := captured()
	if req.fields["gitea_token"] != "alice" {
		t.Fatalf("relay gitea_token = %q", req.fields["gitea_token"])
	}
	for key, value := range req.fields {
		if key != "gitea_token" && strings.Contains(value, "alice") {
			t.Fatalf("token leaked into field %s: %q", key, value)
		}
	}
}

func TestUnauthorizedThenRetryUsesFreshRequestToken(t *testing.T) {
	var calls int
	var tokens []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			t.Errorf("ParseMultipartForm: %v", err)
		}
		tokens = append(tokens, r.FormValue("gitea_token"))
		calls++
		w.Header().Set("Content-Type", "application/json")
		if calls == 1 {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"ok":false,"kind":"unauthorized","message":"Gitea token 无效或权限不足"}`)
			return
		}
		_, _ = io.WriteString(w, `{"ok":true,"kind":"created","message":"已提交 #18","number":18,"url":"https://example.test/18"}`)
	}))
	defer server.Close()

	svc := New(Config{RelayURL: server.URL})
	first := sampleSpec()
	first.GiteaToken = "expired-token"
	got := svc.Send(first)
	if got.Kind != KindUnauthorized || got.Message != MessageUnauthorized {
		t.Fatalf("first outcome = %+v, want unauthorized", got)
	}

	retry := first
	retry.GiteaToken = "fresh-token"
	got = svc.Send(retry)
	if !got.OK || got.Kind != KindOK || got.Number != 18 {
		t.Fatalf("retry outcome = %+v, want created #18", got)
	}
	if calls != 2 || len(tokens) != 2 || tokens[0] != "expired-token" || tokens[1] != "fresh-token" {
		t.Fatalf("relay calls=%d tokens=%v, want fresh per-request token on retry", calls, tokens)
	}
}

type captureTransport struct{ request *http.Request }

func (c *captureTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	c.request = r
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(`{"ok":true,"kind":"created","message":"已提交 #1","number":1,"url":"http://fake/1"}`)),
		Request:    r,
	}, nil
}

func TestDefaultRelayAddressIsLzxsvn3005(t *testing.T) {
	if DefaultRelayURL != "http://lzxsvn:3005" {
		t.Fatalf("DefaultRelayURL = %q", DefaultRelayURL)
	}
}

func TestSendUsesConfiguredDefaultWhenSpecOmitsOverride(t *testing.T) {
	trip := &captureTransport{}
	out := New(Config{RelayURL: DefaultRelayURL, Client: &http.Client{Transport: trip}}).Send(sampleSpec())
	if !out.OK {
		t.Fatalf("Send outcome = %+v", out)
	}
	if trip.request == nil || trip.request.URL.String() != "http://lzxsvn:3005/api/feedback" {
		t.Fatalf("request URL = %v", trip.request)
	}
}

func TestSendExplicitOverrideWorksWithBlankConfiguredRelay(t *testing.T) {
	server, captured := newFakeRelay(t, http.StatusOK, Outcome{OK: true, Kind: "created", Message: "已提交 #1", Number: 1})
	defer server.Close()
	spec := sampleSpec()
	spec.RelayURL = server.URL
	if out := New(Config{}).Send(spec); !out.OK {
		t.Fatalf("Send outcome = %+v", out)
	}
	if captured().calls != 1 {
		t.Fatalf("relay calls = %d", captured().calls)
	}
}

func TestSendWithoutRelayAddressIsExplicitlyUnavailable(t *testing.T) {
	got := New(Config{}).Send(sampleSpec())
	want := Outcome{Kind: "unavailable", Message: "反馈暂不可用：未配置中继地址"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Send outcome = %+v, want %+v", got, want)
	}
}

func TestSendUnreachableRelayIsStable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	address := server.URL
	server.Close()

	got := New(Config{RelayURL: address}).Send(sampleSpec())
	want := Outcome{Kind: "unreachable", Message: "反馈中继不可达，请稍后再试"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Send outcome = %+v, want %+v", got, want)
	}
}

func TestSendUploadsScreenshotsAndDiagnosticsPack(t *testing.T) {
	server, captured := newFakeRelay(t, http.StatusOK, Outcome{OK: true, Kind: "created", Message: "已提交 #1", Number: 1, URL: "https://example.test/1"})
	defer server.Close()

	spec := sampleSpec()
	spec.Screenshots = []Attachment{
		{Name: "画面.png", ContentType: "image/png", Data: []byte{0x89, 'P', 'N', 'G', 1}},
		{Name: "另一张.jpg", ContentType: "image/jpeg", Data: []byte{0xff, 0xd8, 0xff, 1}},
	}
	spec.DiagnosticsPack = &Attachment{Name: "diagnostics.zip", ContentType: "application/zip", Data: []byte{'P', 'K', 3, 4}}
	if out := New(Config{RelayURL: server.URL}).Send(spec); !out.OK {
		t.Fatalf("Send failed: %+v", out)
	}

	req := captured()
	for name, want := range map[string][]byte{
		"画面.png":          {0x89, 'P', 'N', 'G', 1},
		"另一张.jpg":         {0xff, 0xd8, 0xff, 1},
		"diagnostics.zip": {'P', 'K', 3, 4},
	} {
		got, ok := req.files[name]
		if !ok || !reflect.DeepEqual(got, want) {
			t.Fatalf("attachment %q = %v (present=%v), want %v", name, got, ok, want)
		}
	}
	if len(req.diagnosticNames) != 1 || req.diagnosticNames[0] != "diagnostics.zip" {
		t.Fatalf("diagnostics_pack files = %v", req.diagnosticNames)
	}
}

func TestChineseCategoryLabelReachesRelayAsStableCode(t *testing.T) {
	cases := []struct {
		label, code string
		id          int64
	}{
		{"缺陷", "bug", 1},
		{"需求", "feature", 2},
		{"建议", "suggestion", 3},
		{"其他", "other", 4},
	}
	for _, tc := range cases {
		t.Run(tc.label+"->"+tc.code, func(t *testing.T) {
			var issueTitle string
			var issueLabels []int64
			gitea := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/api/v1/repos/o/r/labels":
					_, _ = io.WriteString(w, `[{"id":1,"name":"type/bug"},{"id":2,"name":"type/feature"},{"id":3,"name":"type/suggestion"},{"id":4,"name":"type/other"},{"id":5,"name":"source/app"}]`)
				case r.Method == http.MethodPost && r.URL.Path == "/api/v1/repos/o/r/issues":
					var issue struct {
						Title  string  `json:"title"`
						Labels []int64 `json:"labels"`
					}
					_ = json.NewDecoder(r.Body).Decode(&issue)
					issueTitle, issueLabels = issue.Title, issue.Labels
					_, _ = io.WriteString(w, `{"number":7,"html_url":"http://gitea.test/issues/7"}`)
				case strings.HasSuffix(r.URL.Path, "/assets"):
					_, _ = io.WriteString(w, `{"browser_download_url":"http://gitea.test/assets/x"}`)
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer gitea.Close()

			relay := httptest.NewServer(feedbackrelay.New(feedbackrelay.Config{
				GiteaBase: gitea.URL,
				OwnerRepo: "o/r",
			}).Handler())
			defer relay.Close()

			spec := sampleSpec()
			spec.Category = tc.code
			spec.Title = "" // 中继生成的标题应使用对应的中文分类标签
			out := New(Config{RelayURL: relay.URL}).Send(spec)
			if !out.OK || out.Number != 7 {
				t.Fatalf("Send outcome = %+v", out)
			}
			if !strings.HasPrefix(issueTitle, "["+tc.label+"]") {
				t.Fatalf("issue title = %q, want label %q", issueTitle, tc.label)
			}
			if !reflect.DeepEqual(issueLabels, []int64{tc.id, 5}) {
				t.Fatalf("issue labels = %v, want [%d 5]", issueLabels, tc.id)
			}
		})
	}
}

func TestSendRejectsInvalidAttachmentsBeforeRelay(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*Spec)
		want Outcome
	}{
		{
			name: "format",
			mut: func(s *Spec) {
				s.Screenshots = []Attachment{{Name: "说明.txt", ContentType: "text/plain", Data: []byte("x")}}
			},
			want: Outcome{Kind: KindInvalid, Message: "截图只支持 PNG/JPG 格式，请转换后重试"},
		},
		{
			name: "size",
			mut: func(s *Spec) {
				s.Screenshots = []Attachment{{Name: "很大.png", ContentType: "image/png", Data: make([]byte, MaxScreenshotBytes+1)}}
			},
			want: Outcome{Kind: KindTooLarge, Message: "单张截图超过 10MB，请压缩后重试"},
		},
		{
			name: "count",
			mut: func(s *Spec) {
				for i := 0; i <= MaxScreenshots; i++ {
					s.Screenshots = append(s.Screenshots, Attachment{Name: "shot.png", ContentType: "image/png", Data: []byte("x")})
				}
			},
			want: Outcome{Kind: KindInvalid, Message: "截图最多 5 张，请删掉多余的再发送"},
		},
		{
			name: "diagnostics",
			mut: func(s *Spec) {
				s.DiagnosticsPack = &Attachment{Name: "diagnostics.zip", ContentType: "application/zip", Data: make([]byte, maxDiagnosticsPackBytes+1)}
			},
			want: Outcome{Kind: KindTooLarge, Message: "诊断包过大，请重新生成后再发送"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, captured := newFakeRelay(t, http.StatusOK, Outcome{OK: true, Kind: "created", Number: 1})
			defer server.Close()
			spec := sampleSpec()
			tc.mut(&spec)
			got := New(Config{RelayURL: server.URL}).Send(spec)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Send outcome = %+v, want %+v", got, tc.want)
			}
			if captured().calls != 0 {
				t.Fatalf("invalid attachment should not reach relay, got %d calls", captured().calls)
			}
		})
	}
}

// #229 的裸凭据夹具：与 redaction 包的测试同一组值，两端都不许漏。
// 占位符按片段拼出来，运行时得到的才是这段字面量，不会先被替换成别的值。
const (
	bareHexTokenFixture    = "0123456789abcdef0123456789abcdef01234567"
	barePlaceholderFixture = "{{SECRET" + "_fixture}}"
)

func TestSendRedactsSecretsAndLocalPaths(t *testing.T) {
	server, captured := newFakeRelay(t, http.StatusOK, Outcome{OK: true, Kind: "created", Message: "已提交 #1", Number: 1, URL: "https://example.test/1"})
	defer server.Close()

	spec := sampleSpec()
	spec.Title = "草稿 C:\\Users\\me\\draft.md 上的错误 " + bareHexTokenFixture
	spec.Body = "api_key=hunter2 gateway_key=gw-synthetic ghp_synthetic1234567890 ghp_synthetic1234567890 api_key=user-api-key-abc C:\\\\Users\\\\me\\\\secret\\\\board.md \\\\\\\\lzxsvn\\\\share\\\\draft.png 令牌 " + barePlaceholderFixture
	out := New(Config{RelayURL: server.URL}).Send(spec)
	if !out.OK {
		t.Fatalf("Send unexpectedly failed: %+v", out)
	}

	req := captured()
	for _, key := range []string{
		"hunter2", "gw-synthetic ghp_synthetic1234567890", "ghp_synthetic1234567890", "user-api-key-abc", "C:\\\\Users\\\\me", "\\\\lzxsvn\\\\share",
		// #229：没有 key= 前缀的裸 40 位 token 与裸占位符同样不许出现在发往中继的字段里。
		bareHexTokenFixture, barePlaceholderFixture,
	} {
		if strings.Contains(req.fields["body"], key) || strings.Contains(req.fields["title"], key) {
			t.Fatalf("redacted text still contains %q: title=%q body=%q", key, req.fields["title"], req.fields["body"])
		}
	}
	// 共享脱敏实现统一用 [REDACTED]（diagnostics 与 feedbackservice 同一语义，#216 项4）。
	if !strings.Contains(req.fields["body"], "[REDACTED]") {
		t.Fatalf("redaction placeholder missing: body=%q", req.fields["body"])
	}
	for _, key := range []string{"title", "category", "version", "build", "os", "board_name", "contact"} {
		if req.fields[key] == "" {
			t.Fatalf("multipart field %q missing", key)
		}
	}
}

func TestSendUsesStableContentIdempotencyKey(t *testing.T) {
	server, captured := newFakeRelay(t, http.StatusOK, Outcome{OK: true, Kind: "created", Message: "已提交 #1", Number: 1, URL: "https://example.test/1"})
	defer server.Close()
	svc := New(Config{RelayURL: server.URL})

	if out := svc.Send(sampleSpec()); !out.OK {
		t.Fatalf("first Send failed: %+v", out)
	}
	first := captured().idempotencyKey

	if out := svc.Send(sampleSpec()); !out.OK {
		t.Fatalf("second Send failed: %+v", out)
	}
	if again := captured().idempotencyKey; again != first {
		t.Fatalf("same content produced different keys: %q != %q", again, first)
	}

	changed := sampleSpec()
	changed.Body = "改过的正文"
	if out := svc.Send(changed); !out.OK {
		t.Fatalf("changed Send failed: %+v", out)
	}
	if key := captured().idempotencyKey; key == first {
		t.Fatalf("different content reused idempotency key %q", key)
	}

	overridden := sampleSpec()
	overridden.RelayURL = server.URL
	if out := svc.Send(overridden); !out.OK {
		t.Fatalf("override Send failed: %+v", out)
	}
	if key := captured().idempotencyKey; key != first {
		t.Fatalf("relay override changed content key: %q != %q", key, first)
	}
}

func TestSendRelayUrlOverridesConfiguredAddress(t *testing.T) {
	defaultServer, defaultCapture := newFakeRelay(t, http.StatusOK, Outcome{OK: true, Kind: "created", Message: "默认中继", Number: 1, URL: "https://example.test/1"})
	defer defaultServer.Close()
	overrideServer, overrideCapture := newFakeRelay(t, http.StatusOK, Outcome{OK: true, Kind: "created", Message: "覆盖中继", Number: 2, URL: "https://example.test/2"})
	defer overrideServer.Close()

	spec := sampleSpec()
	spec.RelayURL = overrideServer.URL
	got := New(Config{RelayURL: defaultServer.URL}).Send(spec)
	if !got.OK || got.Message != "覆盖中继" {
		t.Fatalf("Send outcome = %+v, want override response", got)
	}
	if defaultCapture().calls != 0 || overrideCapture().calls != 1 {
		t.Fatalf("calls: default=%d override=%d", defaultCapture().calls, overrideCapture().calls)
	}
}

func TestMultipartBodyIsFormEncoded(t *testing.T) {
	var contentType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contentType = r.Header.Get("Content-Type")
		_, _ = io.WriteString(w, "{}")
	}))
	defer server.Close()

	_ = New(Config{RelayURL: server.URL}).Send(sampleSpec())
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil || mediaType != "multipart/form-data" || params["boundary"] == "" {
		t.Fatalf("request Content-Type is not multipart: %q", contentType)
	}
}
