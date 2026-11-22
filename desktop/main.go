// Command kacha-desktop 是 Kacha 的桌面壳：MyGo 开一个窗口，加载内嵌的 React 画板工作台，
// 数据根由 internal/dataroot 决定（本机唯一一份），画板保存在其中的 画板 目录。
package main

import (
	"log"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
	"github.com/qinyuanj/kacha/desktop/internal/shellapp"
	"github.com/qinyuanj/kacha/desktop/internal/updateservice"
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
	// 进程内共享这一份数据根：迁移成功后切一次，绑定的服务与图片协议都跟着走（#161）。
	roots := dataroot.NewRoots(root)
	// 图片经自定义协议交给页面（WebView2 不允许 http 页面加载 file://）；协议要在建窗口前注册。
	if err := registerAssetProtocol(roots); err != nil {
		log.Fatalf("kacha: 注册本机文件协议失败: %v", err)
	}
	// 内置了发布者公钥的构建才能验证更新签名：能力开关据此决定更新入口是否开放。
	shell := shellapp.NewFollowing(version(), roots).WithPublisherKey(updateservice.PublisherKey() != "")

	// 冷启动外观（#221）：先按上次的档位设原生主题源，再建窗口——窗口底色与标题栏都跟着它走。
	// 读的只是 settings.json 里的 theme 字段（窗口外观的首帧缓存），真源在前端 core/settings.ts。
	mygo.Theme.SetSource(startupTheme(root))

	// 页面经这些服务读取壳信息、操作本地文件和系统剪贴板、导入画板包、迁移数据位置。
	bindServices(shell, roots)

	mygo.App.WhenReady(func() {
		win = mygo.NewWindow(mygo.WindowOptions{
			URL:       "/",
			Title:     "Kacha",
			Width:     1440,
			Height:    900,
			MinWidth:  960,
			MinHeight: 640,
			StateKey:  "main",
			// 冷启动窗口底色（#221）：页面首绘前不出现白底闪屏。
			// 两色与 client/src/styles/tokens.css 的 --app-bg 亮 / 暗一致。
			BackgroundColor: windowBackgroundColor,
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
// 迁移过的话这里读到的是迁移后的位置；新位置用不了就退回迁移前的旧位置。
func userDataRoot() (string, error) {
	// PathUserData 是 %AppData%\\Kacha：状态文件放这里，画板数据放它下面的 data。
	userData, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return "", err
	}
	return dataroot.Resolve(dataroot.StatePath(userData), defaultRoot(userData))
}
