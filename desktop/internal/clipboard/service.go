package clipboard

import (
	"encoding/base64"
	"errors"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"
)

// Snapshot 是给页面的剪贴板快照：类型化，页面按 Kind 分支，不看文案。
type Snapshot struct {
	// Kind 是内容类别（mark / images / text / empty / unsupported / busy）。
	Kind string `json:"kind"`
	// Text 是剪贴板里的文本（Kind 为 mark / text 时非空）。
	Text string `json:"text"`
	// Images 是图片字节（base64 的 PNG，按剪贴板里的顺序）。
	Images []string `json:"images"`
	// Reason 是失败原因码（Kind 为 unsupported / busy 时非空）。
	Reason string `json:"reason"`
	// Formats 是剪贴板提供的格式名（诊断用；界面不据此分支）。
	Formats []string `json:"formats"`
}

// Writer 把一张 PNG 写进系统剪贴板：生产实现是 MyGo 的 Clipboard.WriteImage，测试用替身。
type Writer interface {
	WriteImage(png []byte) error
}

// mygoWriter 是生产实现：MyGo 会校验 PNG，并在 Windows 上同时提供注册的 "PNG" 格式与 CF_DIB 回落。
type mygoWriter struct{}

func (mygoWriter) WriteImage(png []byte) error { return mygo.Clipboard.WriteImage(png) }

// Service 读写系统剪贴板（MyGo），把结果折成类型化结局。
//
// 读的失败不当作错误抛：剪贴板被占用是可重试的失败，页面要拿到「busy」这一类才能提示用户重试。
// 写的失败同样折成结局（#130）：失败不能报成功，占用要说成可重试。
type Service struct {
	// Writer 是系统剪贴板的写入端；留空时用 MyGo。
	Writer Writer
}

// writer 返回写入端：没注入时用 MyGo。
func (s Service) writer() Writer {
	if s.Writer != nil {
		return s.Writer
	}
	return mygoWriter{}
}

// Read 读一次系统剪贴板。
//
// 读不出受支持的图片时不静默丢弃：空剪贴板是 empty，有内容但都不支持是 unsupported，
// 被别的程序占用是 busy（可重试）。
func (Service) Read() Snapshot {
	formats := formatNames(mygo.Clipboard.Formats())
	data, err := mygo.Clipboard.Read(transfer.Text, transfer.PNG, transfer.FileList)
	if err != nil && !isFormatMiss(err) {
		// 读不动：被占用、读取期间换了主人、图片超上限，都有自己的原因码。
		return Snapshot{Kind: string(KindBusy), Reason: reasonOf(err), Formats: formats}
	}
	// 一种请求的表示都没有（transfer.ErrFormat）时 data 是空值：往下走，Classify 会给 empty / unsupported。
	content := Content{}
	if text, err := data.Read(transfer.Text); err == nil {
		content.Text = string(text)
		content.HasText = true
	}
	// 图片按剪贴板里的顺序读：Data.Read 对 PNG 只取第一项，所以这里逐项读。
	for _, item := range data.Items() {
		bytes, err := item.Read(transfer.PNG)
		if err != nil || len(bytes) == 0 {
			continue
		}
		content.Images = append(content.Images, bytes)
	}
	if _, err := data.Read(transfer.FileList); err == nil {
		content.HasFiles = true
	}
	for _, f := range data.Formats() {
		if f == transfer.Text || f == transfer.PNG || f == transfer.FileList {
			continue
		}
		content.OtherFormats = append(content.OtherFormats, string(f))
	}
	outcome := Classify(content)
	snapshot := Snapshot{
		Kind:    string(outcome.Kind),
		Text:    outcome.Text,
		Reason:  outcome.Reason,
		Formats: formats,
		Images:  []string{},
	}
	for _, image := range outcome.Images {
		snapshot.Images = append(snapshot.Images, base64.StdEncoding.EncodeToString(image))
	}
	return snapshot
}

// 复制侧的结局类别（#130）：页面按类别取文案，不读 Go 的消息原文。
const (
	// ImageOK 是写进系统剪贴板成功。
	ImageOK = ""
	// ImageUnsupported 是容器不受支持（HEIC、TIFF 等）：换一种导出方式还有救。
	ImageUnsupported = "unsupported"
	// ImageInvalid 是内容坏掉：这张图本身解不开。
	ImageInvalid = "invalid"
	// ImageBusy 是剪贴板正被别的程序占用：可重试。
	ImageBusy = "busy"
	// ImageFailed 是别的写失败。
	ImageFailed = "failed"
)

// ImageCopyOutcome 是一次「把图片写进系统剪贴板」的结局：成功时 OK 为真，失败时带类别与给用户的话。
//
// 不返回 error：写失败是这次复制自己的事（不改画板、不抛到页面），页面要的是「成功 / 哪种失败」。
type ImageCopyOutcome struct {
	// OK 说明图已经写进系统剪贴板。
	OK bool `json:"ok"`
	// Kind 是失败类别（unsupported / invalid / busy / failed），成功时为空。
	Kind string `json:"kind"`
	// Message 是给用户看的一句话（已含替代动作），页面可以直接显示。
	Message string `json:"message"`
	// Container 是认出来的容器名（unsupported 时非空）：页面据此说「TIFF 不受支持」而不是笼统的「格式不受支持」。
	Container string `json:"container"`
	// Bytes 是实际写进剪贴板的 PNG 字节数（诊断用）。
	Bytes int `json:"bytes"`
}

// ErrClipboardBusy 是「系统剪贴板被别的程序占用」的哨兵：写入端可以返回它，
// 让 busy 判定走结构化错误而不是匹配文案（MyGo 改措辞也不会把可重试的失败降级）。
var ErrClipboardBusy = errors.New("系统剪贴板正被其他程序占用")

// Reader 按用户数据根里的路径读字节：生产实现是 localstore 的 ReadFile（自带越界拒绝）。
type Reader func(path string) ([]byte, error)

// Bound 是绑定给页面的剪贴板服务：读快照（#129）与把图片写进系统剪贴板（#130）。
//
// 页面只给路径与格式提示，字节由 Go 自己按用户数据根读：路径越界由 localstore 拒绝，
// 界面不把整张图搬过 IPC。
type Bound struct {
	// Service 是读写实现（Read 来自它）。
	Service
	read Reader
}

// NewBound 造一个绑定服务：read 是「按路径读用户数据根里的文件」。
func NewBound(read Reader) Bound {
	return Bound{Service: Service{}, read: read}
}

// CopyImage 把 path 指向的图片写进系统剪贴板（#130）。
//
// 读不到文件（已被移走、路径越界）时明确失败并指向该节点已有的「另存为…」，不碰系统剪贴板；
// 读到字节后按容器归一化：PNG 原样、JPEG / WebP 折成 PNG、HEIC / TIFF 明确失败。
func (b Bound) CopyImage(path, format string) ImageCopyOutcome {
	data, err := b.read(path)
	if err != nil {
		return ImageCopyOutcome{Kind: ImageInvalid, Message: "复制图片失败：读不到这张图（" + err.Error() + "），请用该节点的「另存为…」"}
	}
	return b.Service.CopyImage(data, format)
}

// CopyImage 把一张图写进系统剪贴板（#130）。
//
// format 只是页面给的格式提示：真正按字节判断容器。PNG 原样写入（保透明），JPEG / WebP 折成 PNG
// 保证可见内容，HEIC / TIFF 明确失败并指向该节点已有的「另存为…」，剪贴板被占用时给可重试的失败。
// 任何失败都不报成功。
func (s Service) CopyImage(data []byte, format Format) ImageCopyOutcome {
	normalized, err := Normalize(data, format)
	if err != nil {
		kind := kindOf(err)
		outcome := ImageCopyOutcome{Kind: kind, Message: copyMessage(kind, err, format)}
		var unsupported UnsupportedError
		if errors.As(err, &unsupported) {
			outcome.Container = string(unsupported.Container)
		}
		return outcome
	}
	if err := s.writer().WriteImage(normalized); err != nil {
		kind := ImageFailed
		if isBusy(err) {
			kind = ImageBusy
		}
		return ImageCopyOutcome{Kind: kind, Message: copyMessage(kind, err, format)}
	}
	return ImageCopyOutcome{OK: true, Kind: ImageOK, Bytes: len(normalized)}
}

// kindOf 把归一化的错误折成结局类别：容器不受支持与内容坏掉要分开，界面给的话不一样。
func kindOf(err error) string {
	if errors.Is(err, ErrUnsupportedContainer) {
		return ImageUnsupported
	}
	return ImageInvalid
}

// isBusy 判断写失败是不是「剪贴板被别的程序占用」。
//
// 先认结构化错误：本包的 ErrClipboardBusy，以及 MyGo 自己的 ErrClipboardChanged / ErrClipboardReentrant
// （读取期间换了主人、重入，同样可重试）。MyGo 没为「占用」导出专门的哨兵值，Windows 后端给的是
// 一句英文错误，所以最后才按文案兜底：认不出时按 failed 收，不伪装成 busy 让用户白重试。
func isBusy(err error) bool {
	if errors.Is(err, ErrClipboardBusy) || errors.Is(err, mygo.ErrClipboardChanged) || errors.Is(err, mygo.ErrClipboardReentrant) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "busy") || strings.Contains(msg, "cannot lock") || strings.Contains(msg, "reentrant")
}

// copyMessage 是失败时给用户的那句话：说清哪种失败，并指向该节点已有的「另存为…」。
//
// 不受支持时说的是**认出来的容器**而不是页面给的提示：提示来自扩展名，用户或导入都可能写错。
func copyMessage(kind string, err error, format Format) string {
	switch kind {
	case ImageUnsupported:
		name := string(format)
		var unsupported UnsupportedError
		if errors.As(err, &unsupported) {
			name = string(unsupported.Container)
		}
		return "复制图片失败：这张图的格式（" + name + "）不支持写入系统剪贴板，请用该节点的「另存为…」"
	case ImageBusy:
		return "复制图片失败：剪贴板正被其他程序占用，请稍后重试；也可以先用该节点的「另存为…」"
	case ImageInvalid:
		return "复制图片失败：这张图的内容无法识别，请用该节点的「另存为…」"
	default:
		return "复制图片失败：写入系统剪贴板失败，请重试；也可以先用该节点的「另存为…」"
	}
}

// formatNames 把格式名列表换成字符串。
func formatNames(formats []transfer.Format) []string {
	names := make([]string, 0, len(formats))
	for _, f := range formats {
		names = append(names, string(f))
	}
	return names
}

// isFormatMiss 报告错误是不是「请求的表示一个都没有」。
//
// MyGo 的 Read 按请求的格式读：剪贴板里只有图片而请求里带了文本时返回 transfer.ErrFormat。
// 那不是失败——内容仍然读到了，只是没有那一种表示，不能报成 busy 让用户白重试。
func isFormatMiss(err error) bool {
	return errors.Is(err, transfer.ErrFormat)
}

// reasonOf 把读取错误折成原因码。
//
// MyGo 没有为「剪贴板被占用」导出哨兵值（Windows 后端返回的是一句英文错误），
// 所以这里按消息认；读取期间换了主人有哨兵值（mygo.ErrClipboardChanged）。
func reasonOf(err error) string {
	switch {
	case errors.Is(err, mygo.ErrClipboardChanged):
		return ReasonChanged
	case strings.Contains(err.Error(), "busy"), strings.Contains(err.Error(), "cannot lock"):
		return ReasonBusy
	case strings.Contains(err.Error(), "exceeds 64 MiB"):
		return ReasonTooLarge
	default:
		return ReasonFailed
	}
}
