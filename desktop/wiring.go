package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/clipboard"
	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
	"github.com/qinyuanj/kacha/desktop/internal/diagnostics"
	"github.com/qinyuanj/kacha/desktop/internal/feedbackauth"
	"github.com/qinyuanj/kacha/desktop/internal/feedbackservice"
	"github.com/qinyuanj/kacha/desktop/internal/gateway"
	"github.com/qinyuanj/kacha/desktop/internal/localservice"
	"github.com/qinyuanj/kacha/desktop/internal/localstore"
	"github.com/qinyuanj/kacha/desktop/internal/packservice"
	"github.com/qinyuanj/kacha/desktop/internal/shellapp"
	"github.com/qinyuanj/kacha/desktop/internal/storage"
	"github.com/qinyuanj/kacha/desktop/internal/updateservice"
	"github.com/qinyuanj/kacha/desktop/internal/usageservice"
)

// bindServices 绑定页面能调到的全部服务：壳信息、本地文件、本机用量、系统剪贴板、画板包导入。
//
// 单独成函数是为了能在没有窗口的测试里验「该绑的都绑了」：少绑一个服务时页面调用会
// 落到 notBound，前端只会静默退回 paste 事件——原生粘贴那条路就白做了（#129）。
//
// 服务拿的是可切换的共享数据根（#161）：迁移成功后它们自动读写新位置，不必重建或重启。
func bindServices(shell *shellapp.Shell, roots *dataroot.Roots) {
	store := localstore.NewFollowing(roots)
	mygo.BindAs("Shell", shellService{shell: shell})
	// Feedback（#205）：默认中继地址可被环境变量显式置空以关掉能力；高级设置覆盖走 Send(spec).relay_url。
	relayURL := feedbackservice.DefaultRelayURL
	if value, ok := os.LookupEnv("KACHA_FEEDBACK_RELAY_URL"); ok {
		relayURL = strings.TrimSpace(value)
	}
	shell.WithFeedbackRelay(relayURL)
	// 反馈授权（#242）：Gitea OAuth 授权码换来的 token 只落本机受保护存储，页面不持有凭据。
	feedbackAuth := feedbackauth.New(feedbackauth.Config{RootFunc: roots.Current})
	mygo.BindAs("Feedback", feedbackservice.New(feedbackservice.Config{RelayURL: relayURL, Auth: feedbackAuth}))
	mygo.BindAs("Local", localservice.New(store))
	// Usage 是本机用量、未引用清理与回收恢复（#159）：真实数据根扫描，不用前端替身。
	mygo.BindAs("Usage", usageservice.New(store))
	// Clipboard 读写系统剪贴板（#129 / #130）：粘贴截图不必先存成文件，画板上的图也能交给别的软件。
	// 复制按路径读数据根里的字节（localstore 自带越界拒绝），界面不把整张图搬过 IPC。
	mygo.BindAs("Clipboard", clipboard.NewBound(store.ReadFile))
	// Pack 选包并导入（#131）：包在本机解压合并，全程不出数据根。
	pack := packservice.NewFollowing(roots)
	mygo.BindAs("Pack", pack)
	// Gateway 在本机发网关请求并把密钥交给 Windows 系统保护（#152）：
	// 密钥文件落在同一份数据根，不按凭据分身份；迁移时和别的数据一起复制过去。
	gw := gateway.NewFollowing(roots)
	mygo.BindAs("Gateway", gw)
	// Diagnostics 只从 Gateway 读「当前有没有密钥」用于脱敏（#162）：
	// 它拿到的只是临时字符串，用于把同值从日志与包里替换掉，不缓存、不写出。
	// Update 检查、下载、验签并交给真实安装器（#164）：信任规则全在 Go 侧，
	// 页面只按快照分支。没有内置发布者公钥时服务仍是 disabled，入口明确不可用。
	// 下载目录跟着当前数据根走（RootFunc）：迁移之后不往旧位置写。
	updates := updateservice.New(updateservice.Options{
		Current:  shell.Version(),
		RootFunc: roots.Current,
		Quit:     mygo.App.Quit,
	})
	mygo.BindAs("Update", updates)
	mygo.BindAs("Diagnostics", diagnostics.NewFollowing(shell.Version(), roots, func() []string {
		key, err := gw.ReadApiKey()
		if err != nil || key == "" {
			return nil
		}
		return []string{key}
	}))
	// Storage 迁移本机数据位置（#161）：复制校验后原子切换数据根记录与共享数据根。
	// 迁移前先问一遍在途操作：打包 / 导入期间两边都在搬同一份文件，必须等它们结束。
	storageSvc := storage.NewWithBusy(roots, statePath(), func() string {
		if pack.Snapshot().Running {
			return "正在导入画板包，请等它结束再迁移数据位置"
		}
		if pack.ExportSnapshot().Running {
			return "正在导出画板包，请等它结束再迁移数据位置"
		}
		return ""
	})
	mygo.BindAs("Storage", storageSvc)
}

// statePath 返回数据根记录（shell-state.json）的位置：它在应用数据目录里，不在数据根里——
// 正是这份记录指出数据根在哪。
func statePath() string {
	userData, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return ""
	}
	return dataroot.StatePath(userData)
}

// assetScheme 是页面读数据根里本机文件（图片）用的自定义协议。
//
// WebView2 的页面来自 http://mygo.localhost（MyGo 把内嵌前端挂在 mygo:// 自定义协议上），
// 浏览器不允许这种 http 页面加载 file:// 子资源（<img src="file:///..."> 会报错、节点显示「图片缺失」）。
// 所以把数据根经 mygo.Protocol 挂到 kacha://，页面用 http://kacha.localhost/<相对路径> 取图。
// 协议必须在建窗口前注册；页面侧地址见 client/src/shell/desktopStores.ts 的 servedFileUrl。
const assetScheme = "kacha"

// registerAssetProtocol 把数据根挂到 assetScheme 下，供页面读图片等本机文件。
//
// 每次都按当前数据根取文件：迁移切换后同一批图片地址立刻指向新位置（#161），
// 页面不用改地址，也不必重启。
func registerAssetProtocol(roots *dataroot.Roots) error {
	return mygo.Protocol.Handle(assetScheme, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mygo.FileServer(os.DirFS(roots.Current())).ServeHTTP(w, r)
	}))
}

// defaultRoot 返回默认数据根：应用数据目录下的 data。
func defaultRoot(userData string) string { return filepath.Join(userData, "data") }
