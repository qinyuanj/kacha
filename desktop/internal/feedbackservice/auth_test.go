package feedbackservice

import (
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

func TestSendUsesStoredAuthToken(t *testing.T) {
	server, capture := newFakeRelay(t, 200, Outcome{OK: true, Kind: "created", Message: "已提交"})
	defer server.Close()
	auth := &fakeAuth{token: "stored-oauth-token"}
	svc := New(Config{RelayURL: server.URL, Auth: auth})
	spec := sampleSpec()
	spec.GiteaToken = "manual-token-must-be-overridden"

	outcome := svc.Send(spec)
	if !outcome.OK {
		t.Fatalf("Send() = %+v", outcome)
	}
	if got := capture().fields["gitea_token"]; got != "stored-oauth-token" {
		t.Fatalf("relay got token %q", got)
	}
}

func TestSendWithoutAuthorizationReturnsUnauthorized(t *testing.T) {
	server, capture := newFakeRelay(t, 200, Outcome{OK: true, Kind: "created", Message: "ok"})
	defer server.Close()
	svc := New(Config{RelayURL: server.URL, Auth: &fakeAuth{}})
	spec := sampleSpec()
	spec.GiteaToken = ""

	outcome := svc.Send(spec)
	if outcome.Kind != KindUnauthorized {
		t.Fatalf("Kind = %q", outcome.Kind)
	}
	if capture().calls != 0 {
		t.Fatal("relay was called without authorization")
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
