// Package redaction 是 diagnostics 与 feedbackservice 共用的脱敏实现：
// 同一组凭据/路径模式 + 同一替换语义，两处都只调用它，避免再各写一份而漂移（#216 项4）。
package redaction

import "regexp"

// Marker 是唯一的脱敏替换标记：凭据与本地路径都替换成它，
// 让 diagnostics（脱敏日志/诊断包）与 feedbackservice（反馈正文）产出完全一致。
const Marker = "[REDACTED]"

var (
	// StandaloneKey 是常见服务密钥的独立形态：OpenAI / GitHub / AWS / Google。
	StandaloneKey = regexp.MustCompile(`\b(sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b`)
	// CredentialAssignment 是 key=value / key: value 形式的凭据赋值；值可带引号。
	CredentialAssignment = regexp.MustCompile(`(?i)\b(api[_-]?key|gateway[_-]?key|token|secret|authorization|bearer)\s*[:=]\s*(?:"[^"]+"|'[^']+'|[^\s,;]+)`)
	// BearerToken 保证鉴权头里的 Bearer 串即便没命中字段名也被遮掉。
	BearerToken = regexp.MustCompile(`(?i)(bearer\s+)\S+`)
	// BareHexToken 是 Gitea token 的裸形态：40 位十六进制，没有 key= 前缀也要遮（#229）。
	BareHexToken = regexp.MustCompile(`(?i)\b[0-9a-f]{40}\b`)
	// SecretPlaceholder 是代表真实密钥的占位符形态；用户把它粘进正文时同样按秘密处理（#229）。
	SecretPlaceholder = regexp.MustCompile(`(?i)\{\{SECRET_[A-Za-z0-9_]+\}\}`)
	// 本机绝对路径：Windows 盘符、UNC、常见 unix 根；主机名不在此处理（diagnostics 另有主机名替换）。
	WindowsPath = regexp.MustCompile(`[A-Za-z]:[\\/][^\s，。；,;]+`)
	UncPath     = regexp.MustCompile(`\\\\[^\s，。；,;]+`)
	UnixPath    = regexp.MustCompile(`(^|[\s(（])(/(?:Users|home|tmp|var|mnt)/[^\s，。；,;]+)`)
)

// Redact 用同一组模式和同一替换语义对文本脱敏。
// 顺序：先遮 bearer、独立密钥、占位符与裸 40 位 token，再遮 key=value 凭据，
// 避免 "Bearer x" 被凭据赋值规则截断而漏值。
func Redact(text string) string {
	out := WindowsPath.ReplaceAllString(text, Marker)
	out = UncPath.ReplaceAllString(out, Marker)
	out = UnixPath.ReplaceAllString(out, "${1}"+Marker)
	out = BearerToken.ReplaceAllString(out, "${1}"+Marker)
	out = StandaloneKey.ReplaceAllString(out, Marker)
	out = SecretPlaceholder.ReplaceAllString(out, Marker)
	out = BareHexToken.ReplaceAllString(out, Marker)
	out = CredentialAssignment.ReplaceAllString(out, "$1="+Marker)
	return out
}
