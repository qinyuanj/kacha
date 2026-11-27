package feedbackservice

import (
	"strings"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/feedbackauth"
)

type fakeAuth struct {
	token  string
	err    error
	status feedbackauth.Status
	start  feedbackauth.Start
	reset  int
}

func (f *fakeAuth) Token() (string, error)      { return f.token, f.err }
func (f *fakeAuth) Status() feedbackauth.Status { return f.status }
func (f *fakeAuth) Start() feedbackauth.Start   { return f.start }
func (f *fakeAuth) Reset() error                { f.reset++; return nil }

func TestSendUsesStoredAuthTokenOnlyInGiteaAuthorization(t *testing.T) {
	server, capture := newFakeGitea(t)
	defer server.Close()
	auth := &fakeAuth{token: "stored-oauth-token"}
	svc := New(Config{GiteaBase: server.URL, OwnerRepo: "o/r", Auth: auth})

	outcome := svc.Send(sampleSpec())
	if !outcome.OK {
		t.Fatalf("Send() = %+v", outcome)
	}
	got := capture()
	if len(got.auth) == 0 {
		t.Fatal("Gitea was not called")
	}
	for _, header := range got.auth {
		if header != "token stored-oauth-token" {
			t.Fatalf("Authorization = %q", header)
		}
	}
	if strings.Contains(got.title+got.body+got.patched, auth.token) {
		t.Fatal("token leaked into issue content")
	}
}

func TestSendWithoutAuthorizationReturnsUnauthorized(t *testing.T) {
	server, capture := newFakeGitea(t)
	defer server.Close()
	svc := New(Config{GiteaBase: server.URL, OwnerRepo: "o/r", Auth: &fakeAuth{}})

	outcome := svc.Send(sampleSpec())
	if outcome.Kind != KindUnauthorized {
		t.Fatalf("Kind = %q", outcome.Kind)
	}
	if len(capture().requests) != 0 {
		t.Fatal("Gitea was called without authorization")
	}
}

func TestAuthMethodsAreExposed(t *testing.T) {
	auth := &fakeAuth{
		status: feedbackauth.Status{Authorized: true, Message: "ok"},
		start:  feedbackauth.Start{OK: true, URL: "http://example.test/auth"},
	}
	svc := New(Config{Auth: auth})
	if got := svc.AuthStatus(); !got.Authorized {
		t.Fatalf("AuthStatus() = %+v", got)
	}
	if got := svc.AuthStart(); !got.OK || got.URL != "http://example.test/auth" {
		t.Fatalf("AuthStart() = %+v", got)
	}
	if err := svc.AuthReset(); err != nil || auth.reset != 1 {
		t.Fatalf("AuthReset() = %v, reset=%d", err, auth.reset)
	}
}
