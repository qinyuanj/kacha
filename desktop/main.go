// Command kacha-desktop 是 Kacha 的桌面壳：MyGo 开一个窗口，加载内嵌的 React 画板工作台，
// 数据根由 internal/dataroot 决定（本机唯一一份），画板保存在其中的 画板 目录。
package main

import (
	"log"
	"path/filepath"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
	"github.com/qinyuanj/kacha/desktop/internal/shellapp"
)

// devVersion 是未经打包（go run / go test）时的版本占位。
const devVersion = "dev"

func main() {
	mygo.App.SetName("Kacha")

	// 一台电脑只开一个实例：后来的启动把焦点交回已有窗口，自己退出。
	if !mygo.App.RequestSingleInstanceLock() {
		return
	}
	var win *mygo.Window
	mygo.App.OnSecondInstance(func([]string, string) {
		if win == nil {
			return
		}
		if win.IsMinimized() {
			win.Restore()
		}
		win.Show()
		win.Focus()
	})

	root, err := userDataRoot()
	if err != nil {
		log.Fatalf("kacha: 数据根不可用: %v", err)
	}
	// 图片经自定义协议交给页面（WebView2 不允许 http 页面加载 file://）；协议要在建窗口前注册。
	if err := registerAssetProtocol(root); err != nil {
		log.Fatalf("kacha: 注册本机文件协议失败: %v", err)
	}
	shell := shellapp.New(version(), root)

	// 页面经这些服务读取壳信息、操作本地文件和系统剪贴板、导入画板包。
	bindServices(shell, root)

	mygo.App.WhenReady(func() {
		win = mygo.NewWindow(mygo.WindowOptions{
			URL:       "/",
			Title:     "Kacha",
			Width:     1440,
			Height:    900,
			MinWidth:  960,
			MinHeight: 640,
			StateKey:  "main",
		})
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatalf("kacha: %v", err)
	}
}

// version 是应用版本：打包后取自 mygo.config.ts 写进可执行文件的版本资源，源码里跑时退回 dev。
func version() string {
	if v := mygo.App.Version(); v != "" {
		return v
	}
	return devVersion
}

// userDataRoot 返回本机唯一一份数据根：默认在应用数据目录下的 data，
// 首次启动创建并记住，之后启动回到同一份（见 internal/dataroot）。
func userDataRoot() (string, error) {
	// PathUserData 是 %AppData%\\Kacha：状态文件放这里，画板数据放它下面的 data。
	userData, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return "", err
	}
	return dataroot.Resolve(dataroot.StatePath(userData), filepath.Join(userData, "data"))
}
