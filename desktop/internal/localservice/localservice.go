// Package localservice 是绑定给页面的本地能力：画板、用户数据根里的文件、元数据。
//
// 方法只做转发与形状转换：文件语义在 internal/localstore，界面语义在 client/src/shell/desktopPort.ts。
// 失败一律返回类型化的结局（kind = conflict / missing / alreadyExists / invalid / failed），
// 界面按类别分支，不看文案。
package localservice

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"strings"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
)

// maxScanPixels 是探测 alpha 时最多看的像素数：整张图太大时抽样看，避免卡住界面。
const maxScanPixels = 1 << 20

// Service 是页面能调用的本地能力。
type Service struct {
	store *localstore.Store
}

// New 造一个以 store 为底的服务。
func New(store *localstore.Store) *Service {
	return &Service{store: store}
}

// Outcome 是写操作的结局：成功时 Kind 为空，失败时 Message 说明原因。
type Outcome struct {
	OK      bool   `json:"ok"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Version string `json:"version"`
}

// BoardTexts 是画板的主文件、备份与内容版本。
type BoardTexts struct {
	Main    *string `json:"main"`
	Bak     *string `json:"bak"`
	Version *string `json:"version"`
}

// BoardWriteOptions 是写画板的约定：version 非空表示内容版本已变则拒绝，create_only 表示只新建。
type BoardWriteOptions struct {
	Version    string `json:"version"`
	CreateOnly bool   `json:"create_only"`
}

// BoardEntry 是画板列表的一行。
type BoardEntry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Archived bool   `json:"archived"`
	Bytes    *int64 `json:"bytes"`
}

// Slots 是画板位：已用与总数。
type Slots struct {
	Used  int `json:"used"`
	Total int `json:"total"`
}

// SizeLines 是体量提醒线（字节）。
type SizeLines struct {
	Warn  int64 `json:"warn"`
	Alert int64 `json:"alert"`
}

// BoardListing 是画板列表。
type BoardListing struct {
	Boards    []BoardEntry `json:"boards"`
	Slots     Slots        `json:"slots"`
	SizeLines SizeLines    `json:"size_lines"`
}

// DirEntry 是目录里的一项。
type DirEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"is_dir"`
}

// ImageInfo 是图片的探测结果：格式、尺寸与是否有透明通道。
type ImageInfo struct {
	SHA256   string `json:"sha256"`
	Bytes    int64  `json:"bytes"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	Format   string `json:"format"`
	HasAlpha bool   `json:"has_alpha"`
}

// ReadBoard 读画板的主文件、备份与内容版本；画板不存在时返回空值。
func (s *Service) ReadBoard(path string) (BoardTexts, error) {
	texts, err := s.store.ReadBoard(path)
	if err != nil {
		return BoardTexts{}, err
	}
	return BoardTexts{Main: texts.Main, Bak: texts.Bak, Version: texts.Version}, nil
}

// WriteBoard 写画板：原子落盘，覆盖前留 .bak。
func (s *Service) WriteBoard(path, text string, options BoardWriteOptions) Outcome {
	result := s.store.WriteBoard(path, text, localstore.WriteOptions{Version: options.Version, CreateOnly: options.CreateOnly})
	return Outcome{OK: result.OK, Kind: result.Kind, Message: result.Message, Version: result.Version}
}

// BoardCreated 是新建画板的结局：成功时带画板路径与内容版本。
type BoardCreated struct {
	Outcome
	Path string `json:"path"`
}

// CreateBoard 在本机画板目录里新建一块画板：文件名由标题派生（重名加 (2)），
// 只新建不覆盖已有画板。失败时结局带类别与原因。
func (s *Service) CreateBoard(title, text string) BoardCreated {
	path, result := s.store.CreateBoard(title, text)
	if !result.OK {
		return BoardCreated{Outcome: Outcome{OK: false, Kind: result.Kind, Message: result.Message}, Path: path}
	}
	return BoardCreated{Outcome: Outcome{OK: true, Version: result.Version}, Path: path}
}

// ListBoardNames 列出目录里的画板文件名。
func (s *Service) ListBoardNames(dir string) ([]string, error) {
	return s.store.ListBoardNames(dir)
}

// ListBoards 列出画板目录与归档目录里的画板，以及画板位与体量提醒线。
func (s *Service) ListBoards() (BoardListing, error) {
	listing, err := s.store.List()
	if err != nil {
		return BoardListing{}, err
	}
	boards := make([]BoardEntry, 0, len(listing.Boards))
	for _, b := range listing.Boards {
		boards = append(boards, BoardEntry{Name: b.Name, Path: b.Path, Archived: b.Archived, Bytes: b.Bytes})
	}
	return BoardListing{
		Boards:    boards,
		Slots:     Slots{Used: listing.Slots.Used, Total: listing.Slots.Total},
		SizeLines: SizeLines{Warn: listing.SizeLines.Warn, Alert: listing.SizeLines.Alert},
	}, nil
}

// RenameBoard 改画板名：主文件与 .bak 一起搬。带版本时内容已变就拒绝。
func (s *Service) RenameBoard(from, to string, version string) Outcome {
	result := s.store.RenameBoard(from, to, version)
	return Outcome{OK: result.OK, Kind: result.Kind, Message: result.Message, Version: result.Version}
}

// DeleteBoard 删画板：主文件与 .bak 移进回收区。带版本时内容已变就拒绝。
func (s *Service) DeleteBoard(path string, version string) Outcome {
	result := s.store.RemoveBoard(path, version)
	return Outcome{OK: result.OK, Kind: result.Kind, Message: result.Message, Version: result.Version}
}

// ReadFile 读用户数据根里的文件字节（base64 传给页面）。
func (s *Service) ReadFile(path string) (string, error) {
	data, err := s.store.ReadFile(path)
	if err != nil {
		return "", err
	}
	return base64Encode(data), nil
}

// WriteNewFile 写新文件：目标已存在就拒绝。
func (s *Service) WriteNewFile(path string, data []byte) Outcome {
	result := s.store.WriteNewFile(path, data)
	return Outcome{OK: result.OK, Kind: result.Kind, Message: result.Message, Version: result.Version}
}

// IsFile 报告路径是不是一个文件。
func (s *Service) IsFile(path string) bool {
	return s.store.IsFile(path)
}

// ListDir 列目录里的项。
func (s *Service) ListDir(path string) ([]DirEntry, error) {
	entries, err := s.store.ListDir(path)
	if err != nil {
		return nil, err
	}
	out := make([]DirEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, DirEntry{Name: e.Name, IsDir: e.IsDir})
	}
	return out, nil
}

// FileSha256 返回文件的 sha256（小写十六进制）。
func (s *Service) FileSha256(path string) (string, error) {
	return s.store.Sha256(path)
}

// InspectImage 探测图片：格式、尺寸与是否有透明通道。
func (s *Service) InspectImage(path string) (ImageInfo, error) {
	data, err := s.store.ReadFile(path)
	if err != nil {
		return ImageInfo{}, err
	}
	sum, err := s.store.Sha256(path)
	if err != nil {
		return ImageInfo{}, err
	}
	cfg, format, err := image.DecodeConfig(strings.NewReader(string(data)))
	if err != nil {
		return ImageInfo{}, fmt.Errorf("图片读不出来：%w", err)
	}
	hasAlpha := format == "png" && pngHasTransparentPixel(data)
	return ImageInfo{
		SHA256:   sum,
		Bytes:    int64(len(data)),
		Width:    cfg.Width,
		Height:   cfg.Height,
		Format:   format,
		HasAlpha: hasAlpha,
	}, nil
}

// ReadSettings 读 settings.json 原文；文件不存在返回空串。
func (s *Service) ReadSettings() (string, error) {
	return s.store.ReadMeta("settings.json")
}

// WriteSettings 写 settings.json。
func (s *Service) WriteSettings(text string) Outcome {
	result := s.store.WriteMeta("settings.json", text)
	return Outcome{OK: result.OK, Kind: result.Kind, Message: result.Message, Version: result.Version}
}

// ReadUiState 读 ui-state.json 原文。
func (s *Service) ReadUiState() (string, error) {
	return s.store.ReadMeta("ui-state.json")
}

// WriteUiState 写 ui-state.json。
func (s *Service) WriteUiState(text string) Outcome {
	result := s.store.WriteMeta("ui-state.json", text)
	return Outcome{OK: result.OK, Kind: result.Kind, Message: result.Message, Version: result.Version}
}

// ReadModelsCache 读 models-cache.json 原文。
func (s *Service) ReadModelsCache() (string, error) {
	return s.store.ReadMeta("models-cache.json")
}

// WriteModelsCache 写 models-cache.json。
func (s *Service) WriteModelsCache(text string) Outcome {
	result := s.store.WriteMeta("models-cache.json", text)
	return Outcome{OK: result.OK, Kind: result.Kind, Message: result.Message, Version: result.Version}
}

// ReadCapabilityOverride 读能力表覆盖文件原文。
func (s *Service) ReadCapabilityOverride() (string, error) {
	return s.store.ReadMeta("capabilities.override.json")
}

// BoardsDir 返回画板目录的绝对路径（页面据此拼画板文件名）。
func (s *Service) BoardsDir() string {
	return s.store.BoardDir()
}

// UserDataRoot 返回用户数据根的绝对路径。
func (s *Service) UserDataRoot() string {
	return s.store.Root()
}

// pngHasTransparentPixel 看 PNG 里有没有半透明或全透明的像素（只看前 maxScanPixels 个像素）。
func pngHasTransparentPixel(data []byte) bool {
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return false
	}
	bounds := img.Bounds()
	step := 1
	if pixels := bounds.Dx() * bounds.Dy(); pixels > maxScanPixels {
		step = pixels / maxScanPixels
		if step < 1 {
			step = 1
		}
	}
	count := 0
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			if count%step == 0 {
				_, _, _, a := img.At(x, y).RGBA()
				if a < 0xffff {
					return true
				}
			}
			count++
		}
	}
	return false
}

// base64Encode 是字节的标准 base64（页面侧用 atob 还原）。
func base64Encode(data []byte) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var out strings.Builder
	for i := 0; i < len(data); i += 3 {
		var chunk [3]byte
		n := copy(chunk[:], data[i:])
		value := uint32(chunk[0])<<16 | uint32(chunk[1])<<8 | uint32(chunk[2])
		out.WriteByte(alphabet[(value>>18)&0x3F])
		out.WriteByte(alphabet[(value>>12)&0x3F])
		if n > 1 {
			out.WriteByte(alphabet[(value>>6)&0x3F])
		} else {
			out.WriteByte('=')
		}
		if n > 2 {
			out.WriteByte(alphabet[value&0x3F])
		} else {
			out.WriteByte('=')
		}
	}
	return out.String()
}

// ensure JSON 保持被引用（生成的 TS 客户端用反射读结构体字段）。
var _ = json.Marshal
