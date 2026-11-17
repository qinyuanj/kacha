package localservice

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
)

// PickedImage 是用户在本机选中、由 Go 读成 base64 的一张图片。
//
// 读字节这一步必须在 Go 侧做：桌面壳的 File 没有本机路径（#129 起本机选图就卡在这里），
// 页面拿不到用户选中的文件内容，只能由拿得到路径的这一侧读。
type PickedImage struct {
	Name string `json:"name"`
	// Data 是图片原始字节的 base64：跨 IPC 的字节一律走 base64（JSON 里 []byte 才是 base64）。
	Data string `json:"data"`
}

// imageExtensions 是选图对话框里的候选后缀，与页面的 IMAGE_EXTENSIONS 一致。
var imageExtensions = []string{"png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "heic", "heif"}

// pickImagesDialog 弹系统选图对话框；测试替换掉，不弹窗。
var pickImagesDialog = func(opts mygo.OpenDialogOptions) ([]string, error) { return mygo.Dialog.Open(opts) }

// PickImages 让用户在本机选图片，返回文件名与原始字节（base64）；取消返回空切片。
//
// 同一批里有一张读不出来就整批失败：宁可让用户重选，也不静默少给一张参考图。
func (s *Service) PickImages(multiple bool) ([]PickedImage, error) {
	paths, err := pickImagesDialog(mygo.OpenDialogOptions{
		Title:    "选择参考图",
		Filters:  []mygo.FileFilter{{Name: "图片", Extensions: imageExtensions}},
		Multiple: multiple,
	})
	if err != nil {
		return nil, err
	}
	picked := make([]PickedImage, 0, len(paths))
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("读取选中的图片失败：%w", err)
		}
		picked = append(picked, PickedImage{Name: filepath.Base(path), Data: base64.StdEncoding.EncodeToString(data)})
	}
	return picked, nil
}
