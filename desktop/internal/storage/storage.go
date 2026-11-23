// Package storage 是页面的「本机数据位置」能力（#161）：选目标、迁移、报告当前数据根。
//
// 迁移本身在 internal/moveroot 里（复制、校验、切状态记录）；这里只做页面能调到的接线，
// 并把切换结果同步到进程内共享的数据根，让已绑定的服务跟着换位置。
package storage

import (
	"sync"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
	"github.com/qinyuanj/kacha/desktop/internal/moveroot"
)

// Outcome 是一次迁移的结局：成功带新数据根，失败带类别与可显示的原因。
type Outcome struct {
	OK      bool   `json:"ok"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Root    string `json:"root"`
	Files   int    `json:"files"`
	Bytes   int64  `json:"bytes"`
}

// Status 是数据位置的当前状态：页面在迁移前读一次。
type Status struct {
	Root string `json:"root"`
	// Moving 表示正在迁移：期间拒绝新的迁移，页面也拦下会与迁移冲突的操作。
	Moving bool `json:"moving"`
	// Done 与 Total 是已复制完的文件数与总数；没在迁移时都为 0。
	Done  int `json:"done"`
	Total int `json:"total"`
}

// Service 持有共享数据根与状态文件位置；并发调用安全。
type Service struct {
	roots     *dataroot.Roots
	statePath string

	mu    sync.Mutex
	done  int
	total int
	// busy 报出别的在途操作（打包、导入、保存）；返回空串表示没有冲突。
	busy func() string
}

// NewWithBusy 用共享数据根与状态文件位置造服务，并装一个「有没有别的操作在跑」的检查：
// 返回非空原因就拒绝迁移。busy 可为 nil，表示没有在途操作。
//
// 检查是构造参数而不是导出的方法：绑定给页面的服务会暴露全部导出方法，
// 一个 func() string 的参数没法编码成 JSON，绑定时会直接 panic。
func NewWithBusy(roots *dataroot.Roots, statePath string, busy func() string) *Service {
	return &Service{roots: roots, statePath: statePath, busy: busy}
}

// Pick 让用户选一个新的数据位置；取消时返回空串。
func (s *Service) Pick() (string, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Title:             "选择本机数据位置",
		Directory:         true,
		CreateDirectories: true,
	})
	if err != nil || len(paths) == 0 {
		return "", err
	}
	return paths[0], nil
}

// Status 报告当前数据根与迁移进度。
func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	// 迁移中的标志只有一份（在共享数据根上）：状态、拒绝再开一次迁移、
	// 以及拦下会写数据根的操作，都看它。
	return Status{Root: s.roots.Current(), Moving: s.roots.Moving(), Done: s.done, Total: s.total}
}

// Move 把数据根迁到 target：复制并校验全部内容，成功后切状态记录与共享数据根。
//
// 失败时数据根不动，旧位置仍是唯一数据来源；目标里已写入的半份内容由 moveroot 清掉。
func (s *Service) Move(target string) Outcome {
	// 标记迁移中就发生在复制之前：这一段里写数据根的操作被拦下，
	// 免得写进马上要被换成「旧位置」的那一份（切换重载后就丢了）。
	if !s.roots.BeginMove() {
		return Outcome{Kind: "busy", Message: "已有迁移在进行，请等它结束"}
	}
	// 退出迁移状态与清掉进度在同一把锁里：Status 读到的 Moving 与 Done/Total 不会互相矛盾
	// （迁移结束后进度必须是 0/0，页面不会把上一次迁移的数字当成本次）。
	defer func() {
		s.mu.Lock()
		s.done, s.total = 0, 0
		s.roots.EndMove()
		s.mu.Unlock()
	}()
	if busy := s.busy; busy != nil {
		if reason := busy(); reason != "" {
			return Outcome{Kind: "busy", Message: reason}
		}
	}

	source := s.roots.Current()
	report, err := moveroot.Migrate(source, target, s.statePath, &moveroot.Options{
		Progress: func(p moveroot.Progress) {
			s.mu.Lock()
			s.done, s.total = p.Done, p.Total
			s.mu.Unlock()
		},
	})
	if err != nil {
		return Outcome{Kind: moveroot.KindOf(err), Message: err.Error()}
	}
	// 状态记录已经改好，现在才让进程内所有服务换到新位置。
	s.roots.Switch(report.Target)
	return Outcome{OK: true, Root: report.Target, Files: report.Files, Bytes: report.Bytes}
}
