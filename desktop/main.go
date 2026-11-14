// Command kacha-desktop 是 Kacha 的桌面壳：MyGo 开一个窗口，加载内嵌的 React 画板工作台，
// 不连服务端、不要求密钥、没有登录。用户数据根由 internal/dataroot 决定（本机唯一一份），
// 画板落在其中的 画板 目录，与 Web 服务端的布局一致。
package main

import (
	"log"
	"path/filepath"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
	"github.com/qinyuanj/kacha/desktop/internal/localservice"
	"github.com/qinyuanj/kacha/desktop/internal/localstore"
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
		log.Fatalf("kacha: 用户数据根不可用: %v", err)
	}
	shell := shellapp.New(version(), root)

	// 页面只经这两个服务取壳信息与本地文件；其余能力（画板包、剪贴板）留给后续切片。
	mygo.BindAs("Shell", shellService{shell: shell})
	mygo.BindAs("Local", localservice.New(localstore.New(root)))

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

// userDataRoot 返回本机唯一一份用户数据根：默认在应用数据目录下的 data，
// 首次启动创建并记住，之后启动回到同一份（见 internal/dataroot）。
func userDataRoot() (string, error) {
	// PathUserData 是 %AppData%\\Kacha：状态文件放这里，画板数据放它下面的 data。
	userData, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return "", err
	}
	return dataroot.Resolve(dataroot.StatePath(userData), filepath.Join(userData, "data"))
}
