package clipboard

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	// JPEG / GIF 只有解码器，注册进 image.Decode 才能把 JPEG 折成 PNG。
	_ "image/jpeg"
	"image/png"

	// WebP 只有解码器（标准库没有），注册进 image.Decode 才能把 WebP 折成 PNG。
	_ "golang.org/x/image/webp"
)

// 复制侧（#130）：画板上的图写进系统剪贴板。
//
// 约定与读取侧一致：系统剪贴板里的标准交换表示是 PNG（ADR 0023）。复制保证可见图像内容，
// 不承诺保留原始字节、容器格式或元数据，所以：
//
//   - 已经是 PNG 的字节原样写入（不重编码，透明通道不受损失，MyGo 的注册 "PNG" 格式是保 alpha 的那条）；
//   - JPEG / WebP 解码后重编码成 PNG（可见内容不变）；
//   - HEIC / TIFF 这类容器在复制侧明确失败，界面指向该节点已有的「另存为…」。

// Format 是页面给的格式提示（来自节点路径的扩展名或 imageInfo 的 format）。
//
// 只是提示：真正按字节判断容器（Sniff），提示写错不影响结果，只影响「认不出」时的错误文案。
type Format = string

// 页面会送来的格式提示。别的值（heic、tiff、gif……）一律交给 Sniff 按字节判断。
const (
	FormatPNG  Format = "png"
	FormatJPEG Format = "jpeg"
	FormatWebP Format = "webp"
)

// Container 是按文件头认出来的图片容器。
type Container string

const (
	// ContainerPNG 是 PNG：剪贴板的标准交换表示。
	ContainerPNG Container = "png"
	// ContainerJPEG 是 JPEG：可解码，折成 PNG 后写入。
	ContainerJPEG Container = "jpeg"
	// ContainerWebP 是 WebP：可解码，折成 PNG 后写入。
	ContainerWebP Container = "webp"
	// ContainerTIFF 是 TIFF：本切片不支持，复制侧明确失败。
	ContainerTIFF Container = "tiff"
	// ContainerHEIC 是 HEIC / HEIF / AVIF 一族（ISO BMFF 的 ftyp 品牌）：不支持，复制侧明确失败。
	ContainerHEIC Container = "heic"
	// ContainerUnknown 认不出来：当作内容坏掉，不是「容器不受支持」。
	ContainerUnknown Container = "unknown"
)

// 复制侧的两类失败哨兵：容器不受支持（换一种导出方式还有救）与内容坏掉（这张图本身就坏了）。
var (
	// ErrUnsupportedContainer 是容器不受支持（HEIC、TIFF 等）。
	ErrUnsupportedContainer = errors.New("图片容器不受支持")
	// ErrInvalidImage 是字节认不出或解不开。
	ErrInvalidImage = errors.New("图片内容无法识别")
)

// UnsupportedError 带上具体容器名：界面据此说清「哪种格式不行」。
type UnsupportedError struct {
	// Container 是认出来的容器。
	Container Container
}

func (e UnsupportedError) Error() string {
	return fmt.Sprintf("%v：%s", ErrUnsupportedContainer, e.Container)
}

// Is 让 errors.Is(err, ErrUnsupportedContainer) 对带容器名的错误也成立。
func (e UnsupportedError) Is(target error) bool { return target == ErrUnsupportedContainer }

// TIFF 的两个文件头：小端是 49 49 2a 00，大端是 4d 4d 00 2a。
var (
	tiffLittle = []byte{'I', 'I', 0x2a, 0x00}
	tiffBig    = []byte{'M', 'M', 0x00, 0x2a}
)

// heicBrands 是 ISO BMFF 里与 HEIC / HEIF / AVIF 有关的 ftyp 品牌。
// 这些容器都要专门解码器，本切片没有，复制侧明确失败而不是写一张坏图进剪贴板。
var heicBrands = map[string]bool{
	"heic": true, "heix": true, "hevc": true, "hevx": true,
	"heim": true, "heis": true, "hevm": true, "hevs": true,
	"mif1": true, "msf1": true, "avif": true, "avis": true,
}

// Sniff 按文件头认容器，不解码整张图。
func Sniff(data []byte) Container {
	switch {
	case IsPNG(data):
		return ContainerPNG
	case len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		return ContainerJPEG
	case isWebP(data):
		return ContainerWebP
	case bytes.HasPrefix(data, tiffLittle), bytes.HasPrefix(data, tiffBig):
		return ContainerTIFF
	case isHEIC(data):
		return ContainerHEIC
	default:
		return ContainerUnknown
	}
}

// isWebP 判断 RIFF 容器里的 WebP（"RIFF" + 4 字节长度 + "WEBP"）。
func isWebP(data []byte) bool {
	return len(data) >= 12 && bytes.HasPrefix(data, []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP"))
}

// isHEIC 判断 ISO BMFF 的 ftyp 盒，且主品牌属于 HEIC / HEIF / AVIF 一族。
// 布局：4 字节长度 + "ftyp" + 4 字节主品牌。
func isHEIC(data []byte) bool {
	return len(data) >= 12 && bytes.Equal(data[4:8], []byte("ftyp")) && heicBrands[string(data[8:12])]
}

// Normalize 把一张图片折成写进系统剪贴板的 PNG 字节。
//
// PNG 原样返回（不重编码）；JPEG / WebP 解码后重编码成 PNG；TIFF / HEIC 返回 UnsupportedError；
// 认不出或解不开的字节返回 ErrInvalidImage。format 只是提示，只用于「认不出」时的错误文案。
func Normalize(data []byte, format Format) ([]byte, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("%w：这张图没有内容（提示为 %q）", ErrInvalidImage, format)
	}
	container := Sniff(data)
	switch container {
	case ContainerPNG:
		// 只验配置能不能解：整张解码再重编码会改变字节，也可能丢透明信息。
		if _, err := png.DecodeConfig(bytes.NewReader(data)); err != nil {
			return nil, fmt.Errorf("%w：PNG 内容损坏（%v）", ErrInvalidImage, err)
		}
		return data, nil
	case ContainerJPEG, ContainerWebP:
		img, _, err := image.Decode(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("%w：%s 解不开（%v）", ErrInvalidImage, container, err)
		}
		var out bytes.Buffer
		if err := png.Encode(&out, img); err != nil {
			return nil, fmt.Errorf("%w：转成 PNG 失败（%v）", ErrInvalidImage, err)
		}
		return out.Bytes(), nil
	case ContainerTIFF, ContainerHEIC:
		return nil, UnsupportedError{Container: container}
	default:
		return nil, fmt.Errorf("%w：认不出图片格式（提示为 %q）", ErrInvalidImage, format)
	}
}
