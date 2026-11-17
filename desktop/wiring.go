package main

import (
	"os"
	"path/filepath"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/clipboard"
	"github.com/qinyuanj/kacha/desktop/internal/diagnostics"
	"github.com/qinyuanj/kacha/desktop/internal/gateway"
	"github.com/qinyuanj/kacha/desktop/internal/localservice"
	"github.com/qinyuanj/kacha/desktop/internal/localstore"
	"github.com/qinyuanj/kacha/desktop/internal/packservice"
	"github.com/qinyuanj/kacha/desktop/internal/shellapp"
)

// bindServices 绑定页面能调到的全部服务：壳信息、本地文件、系统剪贴板、画板包导入。
//
// 单独成函数是为了能在没有窗口的测试里验「该绑的都绑了」：少绑一个服务时页面调用会
// 落到 notBound，前端只会静默退回 paste 事件——原生粘贴那条路就白做了（#129）。
func bindServices(shell *shellapp.Shell, root string) {
	store := localstore.New(root)
	mygo.BindAs("Shell", shellService{shell: shell})
	mygo.BindAs("Local", localservice.New(store))
	// Clipboard 读写系统剪贴板（#129 / #130）：粘贴截图不必先存成文件，画板上的图也能交给别的软件。
	// 复制按路径读数据根里的字节（localstore 自带越界拒绝），界面不把整张图搬过 IPC。
	mygo.BindAs("Clipboard", clipboard.NewBound(store.ReadFile))
	// Pack 选包并导入（#131）：包在本机解压合并，全程不出数据根。
	mygo.BindAs("Pack", packservice.New(root))
	// Gateway 在本机发网关请求并把密钥交给 Windows 系统保护（#152）：
	// 密钥文件落在同一份数据根，不按凭据分身份。
	gw := gateway.New(filepath.Join(root, "api-key.protected"))
	mygo.BindAs("Gateway", gw)
	// Diagnostics 只从 Gateway 读「当前有没有密钥」用于脱敏（#162）：
	// 它拿到的只是临时字符串，用于把同值从日志与包里替换掉，不缓存、不写出。
	mygo.BindAs("Diagnostics", diagnostics.New(shell.Version(), root, func() []string {
		key, err := gw.ReadApiKey()
		if err != nil || key == "" {
			return nil
		}
		return []string{key}
	}))
}

// assetScheme 是页面读数据根里本机文件（图片）用的自定义协议。
//
// WebView2 的页面来自 http://mygo.localhost（MyGo 把内嵌前端挂在 mygo:// 自定义协议上），
// 浏览器不允许这种 http 页面加载 file:// 子资源（<img src="file:///..."> 会报错、节点显示「图片缺失」）。
// 所以把数据根经 mygo.Protocol 挂到 kacha://，页面用 http://kacha.localhost/<相对路径> 取图。
// 协议必须在建窗口前注册；页面侧地址见 client/src/shell/desktopStores.ts 的 servedFileUrl。
const assetScheme = "kacha"

// registerAssetProtocol 把数据根挂到 assetScheme 下，供页面读图片等本机文件。
func registerAssetProtocol(root string) error {
	return mygo.Protocol.Handle(assetScheme, mygo.FileServer(os.DirFS(root)))
}
