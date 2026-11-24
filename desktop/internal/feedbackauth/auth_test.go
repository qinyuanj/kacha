package feedbackauth

import (
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeStore struct {
	mu    sync.Mutex
	token string
}

func (s *fakeStore) Load() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.token, nil
}
func (s *fakeStore) Save(token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.token = token
	return nil
}
func (s *fakeStore) Delete() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.token = ""
	return nil
}

func waitAuthorized(t *testing.T, svc *Service) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if svc.Status().Authorized {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("authorization did not complete")
}

func newAuthService(t *testing.T, store tokenStore, tokenServer *httptest.Server, redirect string, listener net.Listener) (*Service, *[]string) {
	t.Helper()
	opened := []string{}
	return New(Config{
		GiteaBase:   tokenServer.URL,
		RedirectURL: redirect,
		ClientID:    "test-client",
		Store:       store,
		Listen:      func(string, string) (net.Listener, error) { return listener, nil },
		OpenBrowser: func(raw string) error { opened = append(opened, raw); return nil },
	}), &opened
}

func TestStartBuildsPKCEAuthorizationURL(t *testing.T) {
	store := &fakeStore{}
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer tokenServer.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	redirect := "http://" + listener.Addr().String() + "/callback"
	svc, opened := newAuthService(t, store, tokenServer, redirect, listener)

	start := svc.Start()
	if !start.OK {
		t.Fatalf("Start failed: %+v", start)
	}
	if len(*opened) != 1 || (*opened)[0] != start.URL {
		t.Fatalf("browser was not opened with authorization URL: %+v", opened)
	}
	u, err := url.Parse(start.URL)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	for key, want := range map[string]string{
		"response_type":         "code",
		"client_id":             "test-client",
		"redirect_uri":          redirect,
		"code_challenge_method": "S256",
	} {
		if got := q.Get(key); got != want {
			t.Fatalf("%s = %q, want %q", key, got, want)
		}
	}
	if q.Get("state") == "" || q.Get("code_challenge") == "" {
		t.Fatal("authorization URL lacks state or PKCE challenge")
	}
	if !strings.Contains(q.Get("scope"), "write:issue") {
		t.Fatalf("scope lacks write:issue: %q", q.Get("scope"))
	}
	svc.Reset()
}

func TestCallbackExchangesCodeAndSavesToken(t *testing.T) {
	store := &fakeStore{}
	var seen url.Values
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		seen = r.Form
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{\"access_token\":\"oauth-token\",\"token_type\":\"Bearer\"}"))
	}))
	defer tokenServer.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	redirect := "http://" + listener.Addr().String() + "/callback"
	svc, _ := newAuthService(t, store, tokenServer, redirect, listener)

	if status := svc.Status(); status.Authorized || status.Pending {
		t.Fatalf("unexpected initial status: %+v", status)
	}
	start := svc.Start()
	if !start.OK {
		t.Fatalf("Start failed: %+v", start)
	}
	svc.mu.Lock()
	state := svc.pending.state
	verifier := svc.pending.verifier
	svc.mu.Unlock()

	resp, err := http.Get(redirect + "?code=auth-code&state=" + url.QueryEscape(state))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	waitAuthorized(t, svc)

	if got := seen.Get("code"); got != "auth-code" {
		t.Fatalf("code = %q", got)
	}
	if got := seen.Get("code_verifier"); got != verifier {
		t.Fatalf("code_verifier does not match PKCE verifier")
	}
	if got := seen.Get("grant_type"); got != "authorization_code" {
		t.Fatalf("grant_type = %q", got)
	}
	token, err := svc.Token()
	if err != nil || token != "oauth-token" {
		t.Fatalf("Token() = %q, %v", token, err)
	}
	if status := svc.Status(); !status.Authorized {
		t.Fatalf("Status() = %+v", status)
	}
	if err := svc.Reset(); err != nil {
		t.Fatal(err)
	}
	if status := svc.Status(); status.Authorized {
		t.Fatal("Reset left token authorized")
	}
}

func TestCallbackRejectsMismatchedState(t *testing.T) {
	store := &fakeStore{}
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("token endpoint must not be called for mismatched state")
	}))
	defer tokenServer.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	redirect := "http://" + listener.Addr().String() + "/callback"
	svc, _ := newAuthService(t, store, tokenServer, redirect, listener)
	svc.Start()

	resp, err := http.Get(redirect + "?code=auth-code&state=wrong")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if token, _ := store.Load(); token != "" {
		t.Fatal("mismatched state saved a token")
	}
	svc.Reset()
}
