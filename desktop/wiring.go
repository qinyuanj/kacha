package main

import (
	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/clipboard"
	"github.com/qinyuanj/kacha/desktop/internal/localservice"
	"github.com/qinyuanj/kacha/desktop/internal/localstore"
	"github.com/qinyuanj/kacha/desktop/internal/shellapp"
)

// bindServices 绑定页面能调到的全部服务：壳信息、本地文件、系统剪贴板。
//
// 单独成函数是为了能在没有窗口的测试里验「该绑的都绑了」：少绑一个服务时页面调用会
// 落到 notBound，前端只会静默退回 paste 事件——原生粘贴那条路就白做了（#129）。
func bindServices(shell *shellapp.Shell, root string) {
	mygo.BindAs("Shell", shellService{shell: shell})
	mygo.BindAs("Local", localservice.New(localstore.New(root)))
	// Clipboard 读系统剪贴板（#129）：粘贴截图不必先存成文件。
	mygo.BindAs("Clipboard", clipboard.Service{})
}
