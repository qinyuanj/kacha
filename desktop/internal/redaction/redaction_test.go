package redaction

import "testing"

// #216 项4：共享脱敏的行为契约。diagnostics 与 feedbackservice 都调用同一实现，
// 这里用独立写死的期望值锁定同一组模式与同一替换语义，防止再次漂移。
// #229 的裸凭据夹具：40 位十六进制裸 Gitea token 与裸占位符。
// 占位符按片段拼出来，运行时得到的才是这段字面量，不会先被替换成别的值。
const (
	bareHexTokenFixture    = "0123456789abcdef0123456789abcdef01234567"
	barePlaceholderFixture = "{{SECRET" + "_fixture}}"
)

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
		{"bare hex gitea token", "复制 " + bareHexTokenFixture + " 过来", "复制 [REDACTED] 过来"},
		{"bare secret placeholder", "残留 " + barePlaceholderFixture + " 值", "残留 [REDACTED] 值"},
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
