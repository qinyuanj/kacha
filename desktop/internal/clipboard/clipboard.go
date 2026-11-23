// Package clipboard 读系统剪贴板，给页面一份类型化快照。
//
// 分派语义在 ADR 0021：剪贴板里是本应用的节点标记就粘节点，是受支持的图片就经「导入参考图」
// 链路落成参考图，两者都没有就明确提示，不静默丢弃。判定要纯，所以拆成两部分：
//
//   - 本文件里的纯函数（分类、大小上限、去重命名）：go test 不需要 GUI 就能跑。
//   - service.go 里的 System：调 MyGo 的剪贴板 API（github.com/egoist/mygo v0.9.0）。
//
// 不写 Win32 代码：MyGo 已经把系统剪贴板包成 Clipboard.Read / ReadText / ReadImage，
// Windows 上优先读注册过的 PNG 格式（保 alpha），DIB 只是回落（可能丢 alpha）。
package clipboard

import (
	"bytes"
	"errors"
)

// Kind 是剪贴板快照的类别：页面按它分支，不看文案。
type Kind string

const (
	// KindMark 是本应用写的节点标记：粘节点。
	KindMark Kind = "mark"
	// KindImages 是受支持的图片（PNG 字节，按剪贴板里的顺序）。
	KindImages Kind = "images"
	// KindText 是普通文本：放行（粘到输入框里是浏览器的事）。
	KindText Kind = "text"
	// KindEmpty 是剪贴板里什么都没有。
	KindEmpty Kind = "empty"
	// KindUnsupported 是有内容但都不受支持：明确提示，不静默丢弃。
	KindUnsupported Kind = "unsupported"
	// KindBusy 是剪贴板正被其他程序占用：可重试的失败。
	KindBusy Kind = "busy"
)

// 失败原因码：界面按码取文案，不读 Go 侧的消息原文。
const (
	// ReasonFiles 是剪贴板里有文件（资源管理器里复制的）。
	ReasonFiles = "files"
	// ReasonFormat 是剪贴板里有别的格式（HEIC、TIFF 之类）。
	ReasonFormat = "format"
	// ReasonBusy 是剪贴板被别的程序占用。
	ReasonBusy = "busy"
	// ReasonChanged 是读取期间剪贴板换了主人。
	ReasonChanged = "changed"
	// ReasonTooLarge 是图片超过单张上限。
	ReasonTooLarge = "tooLarge"
	// ReasonFailed 是别的读失败。
	ReasonFailed = "failed"
)

// ErrUnsupported 是剪贴板里有内容但不受支持（HEIC、TIFF 之类）。
var ErrUnsupported = errors.New("剪贴板内容不受支持")

// PNGMagic 是 PNG 文件头的字节。
var PNGMagic = []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}

// IsPNG 判断一段字节是不是 PNG：只认文件头，不解码整个图。
func IsPNG(data []byte) bool {
	return bytes.HasPrefix(data, PNGMagic)
}

// Content 是读到的剪贴板内容（纯数据，不带 IO）。
type Content struct {
	// Text 是剪贴板里的纯文本。
	Text string
	// HasText 说明剪贴板确实提供了文本（空文本与没有文本要分得开）。
	HasText bool
	// Images 是图片字节，按剪贴板里的先后顺序。
	Images [][]byte
	// HasFiles 说明剪贴板里有文件（资源管理器里复制的）。
	HasFiles bool
	// OtherFormats 是既不是文本、也不是图片、也不是文件的格式名。
	OtherFormats []string
}

// Outcome 是剪贴板内容的分类结果。
type Outcome struct {
	// Kind 是内容类别。
	Kind Kind
	// Text 是剪贴板里的纯文本。
	Text string
	// Images 是图片字节，按剪贴板里的先后顺序。
	Images [][]byte
	// Reason 是失败原因码（Kind 为 unsupported / busy 时非空）。
	Reason string
}

// Classify 给一份剪贴板内容分类。
//
// 顺序即语义（ADR 0021）：节点标记优先于图片——复制节点后立刻粘贴粘出的是节点，
// 不会粘出旧截图；反过来截图后粘贴，剪贴板里没有标记，粘出的是图，不会粘出旧节点。
func Classify(c Content) Outcome {
	out := Outcome{Text: c.Text, Images: c.Images}
	switch {
	case c.HasText && IsMarkText(c.Text):
		out.Kind = KindMark
	case len(c.Images) > 0:
		out.Kind = KindImages
	case c.HasFiles:
		out.Kind = KindUnsupported
		out.Reason = ReasonFiles
	case c.HasText && c.Text != "":
		out.Kind = KindText
	case len(c.OtherFormats) > 0:
		out.Kind = KindUnsupported
		out.Reason = ReasonFormat
	default:
		out.Kind = KindEmpty
	}
	return out
}

// markPrefix 是节点标记的前缀，与前端 core/pageInput 的 NODE_MARKER_PREFIX 相同。
const markPrefix = "kacha:clip:v1:"

// IsMarkText 判断文本是不是本应用写的节点标记：前缀 + 从 1 起、不许多一位前导零的计数。
//
// 与前端 core/pageInput 的 isNodeMarker 同一套判定；两边各自定义，靠两边的同一张表对齐
// （改一处忘了另一处会在测试里现形）。
func IsMarkText(text string) bool {
	trimmed := trimSpace(text)
	if len(trimmed) <= len(markPrefix) || trimmed[:len(markPrefix)] != markPrefix {
		return false
	}
	digits := trimmed[len(markPrefix):]
	if digits[0] == '0' {
		return false
	}
	for _, c := range digits {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// trimSpace 去掉首尾空白（用户可能连空白一起粘上）。
func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && isSpace(s[start]) {
		start++
	}
	for end > start && isSpace(s[end-1]) {
		end--
	}
	return s[start:end]
}

// isSpace 判断是不是空白字符（ASCII 空白，与前端 trim 的范围一致）。
func isSpace(c byte) bool {
	switch c {
	case ' ', '\t', '\n', '\r', '\v', '\f':
		return true
	}
	return false
}
