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

// Service 读系统剪贴板（MyGo），把结果折成类型化快照。
//
// 失败不当作错误抛：剪贴板被占用是可重试的失败，页面要拿到「busy」这一类才能提示用户重试。
type Service struct{}

// Read 读一次系统剪贴板。
//
// 读不出受支持的图片时不静默丢弃：空剪贴板是 empty，有内容但都不支持是 unsupported，
// 被别的程序占用是 busy（可重试）。
func (Service) Read() Snapshot {
	formats := formatNames(mygo.Clipboard.Formats())
	data, err := mygo.Clipboard.Read(transfer.Text, transfer.PNG, transfer.FileList)
	if err != nil {
		// 读不动：被占用、读取期间换了主人、图片超上限，都有自己的原因码。
		return Snapshot{Kind: string(KindBusy), Reason: reasonOf(err), Formats: formats}
	}
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

// formatNames 把格式名列表换成字符串。
func formatNames(formats []transfer.Format) []string {
	names := make([]string, 0, len(formats))
	for _, f := range formats {
		names = append(names, string(f))
	}
	return names
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
