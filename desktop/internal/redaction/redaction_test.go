package redaction

import "testing"

// #216 项4：共享脱敏的行为契约。diagnostics 与 feedbackservice 都调用同一实现，
// 这里用独立写死的期望值锁定同一组模式与同一替换语义，防止再次漂移。
func TestRedactUniformPatterns(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"api_key assignment", "api_key=hunter2", "api_key=[REDACTED]"},
		{"quoted token assignment", "token: 'fixture-secret'", "token=[REDACTED]"},
		{"gateway_key stops at comma", "gateway_key=abc,more", "gateway_key=[REDACTED],more"},
		{"openai key", "key sk-fixture-abcdef here", "key [REDACTED] here"},
		{"github token", "ghp_0123456789abcdef0123", "[REDACTED]"},
		{"aws example key", "AKIAEXAMPLE123456789", "[REDACTED]"},
		{"bearer header", "Bearer topsecretvalue", "Bearer [REDACTED]"},
		{"windows path", "C:\\Users\\me\\board.md", "[REDACTED]"},
		{"unc path", "\\\\server\\share\\draft.png", "[REDACTED]"},
		{"unix path keeps prefix whitespace", "in /home/me/board.kacha ok", "in [REDACTED] ok"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Redact(tc.in); got != tc.want {
				t.Fatalf("Redact(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
