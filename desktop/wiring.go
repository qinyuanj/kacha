package main

import (
	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/clipboard"
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
	// 复制按路径读用户数据根里的字节（localstore 自带越界拒绝），界面不把整张图搬过 IPC。
	mygo.BindAs("Clipboard", clipboard.NewBound(store.ReadFile))
	// Pack 选包并导入（#131）：包在本机解压合并，全程不出用户数据根。
	mygo.BindAs("Pack", packservice.New(root))
}
