// Package packservice 是绑定给页面的画板包服务：选包、导入、进度与结局。
//
// 逻辑在 internal/packimport；这里只做界面需要的三件事：用系统对话框选包、把导入跑在后台
// goroutine 里（大包不会卡住窗口）、把进度与结局存成可轮询的快照。进度是快照而不是推送：
// 页面每 200ms 取一次，不需要 Go 侧的事件通道。
package packservice

import (
	"os"
	"sync"
	"sync/atomic"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
	"github.com/qinyuanj/kacha/desktop/internal/packimport"
)

// Progress 是一次导入的进度快照（与 packimport.Progress 同形，页面按它画进度条）。
type Progress struct {
	// Step 是当前步骤：check / extract / restore / merge / boards / done。
	Step string `json:"step"`
	// Done 与 Total 是本步已做与总数。
	Done  int `json:"done"`
	Total int `json:"total"`
	// Detail 是正在处理的条目或说明。
	Detail string `json:"detail"`
	// BytesDone 与 BytesTotal 是字节进度：界面按它画进度条。
	BytesDone  int64 `json:"bytes_done"`
	BytesTotal int64 `json:"bytes_total"`
}

// Outcome 是一次导入的结局：成功时带报告，失败时带类别、步骤与原因。
type Outcome struct {
	// OK 表示导入成功。
	OK bool `json:"ok"`
	// Kind 是失败类别：corrupt / newer / invalid / conflict / failed / cancelled / busy。
	Kind string `json:"kind"`
	// Step 是卡在哪一步。
	Step string `json:"step"`
	// Message 是给用户看的说法。
	Message string `json:"message"`
	// Report 是成功时的报告。
	Report *packimport.Report `json:"report,omitempty"`
}

// Snapshot 是当前（或最近一次）导入的状态：页面轮询它。
type Snapshot struct {
	// Running 表示有导入在跑。
	Running bool `json:"running"`
	// Progress 是进度；没有导入过时为零值。
	Progress Progress `json:"progress"`
	// Outcome 是最近一次导入的结局；还没结束时为 null。
	Outcome *Outcome `json:"outcome"`
}

// Service 是绑定给页面的画板包服务。
type Service struct {
	root string
	// roots 是可切换的数据根（迁移 #161）：装了它，导入与导出都跟着走。
	roots *dataroot.Roots

	// export 是画板包导出的独立状态：与导入互不阻塞，也各自有取消标记。
	export exportState

	mu       sync.Mutex
	running  bool
	progress Progress
	outcome  *Outcome
	// generation 每开始一次导入加一：被取消的旧导入不会再改快照。
	generation atomic.Int64
}

// New 造一个以 root 为数据根的服务。
func New(root string) *Service {
	return &Service{root: root}
}

// NewFollowing 造一个跟着共享数据根走的服务：迁移切换后导入与导出都落到新位置。
func NewFollowing(roots *dataroot.Roots) *Service {
	return &Service{roots: roots}
}

// Root 返回当前数据根。
func (s *Service) Root() string {
	if s.roots != nil {
		return s.roots.Current()
	}
	return s.root
}

// Pick 让用户选一个画板包，返回它的绝对路径；取消时返回空串。
//
// 选包必须在 Go 侧做：页面拿不到本机文件的绝对路径（桌面壳的 File 没有路径信息）。
func (s *Service) Pick() (string, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Title:   "导入画板包",
		Filters: []mygo.FileFilter{{Name: "画板包", Extensions: []string{"ugcpack", "zip"}}},
	})
	if err != nil {
		return "", err
	}
	if len(paths) == 0 {
		return "", nil
	}
	return paths[0], nil
}

// Start 开始导入 packPath：立刻返回，进度与结局由 Snapshot 取。
//
// 已有导入在跑时拒绝再开一份（kind = busy），免得两次导入互相踩。
func (s *Service) Start(packPath string) Outcome {
	if packPath == "" {
		return Outcome{Kind: "invalid", Step: packimport.StepCheck, Message: "没有选中画板包"}
	}
	if info, err := os.Stat(packPath); err != nil || info.IsDir() {
		return Outcome{Kind: "invalid", Step: packimport.StepCheck, Message: "选中的画板包读不出来：" + packPath}
	}
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return Outcome{Kind: "busy", Message: "已有导入在进行，请等它结束"}
	}
	s.running = true
	s.progress = Progress{Step: packimport.StepCheck, Detail: "正在检查画板包"}
	s.outcome = nil
	generation := s.generation.Add(1)
	s.mu.Unlock()

	go s.run(packPath, generation)
	return Outcome{OK: true}
}

// Snapshot 返回当前（或最近一次）导入的状态。
func (s *Service) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Snapshot{Running: s.running, Progress: s.progress, Outcome: s.outcome}
}

// Cancel 取消当前导入：已移入的任务目录保留，画板不再写入。
func (s *Service) Cancel() {
	s.mu.Lock()
	running := s.running
	s.mu.Unlock()
	if running {
		s.generation.Add(1)
	}
}

// run 在后台跑一次导入，把进度与结局写回快照。
func (s *Service) run(packPath string, generation int64) {
	// stale 报告这次导入是否已经被取消（或已被新的一次顶掉）。
	stale := func() bool { return s.generation.Load() != generation }

	importer := packimport.New(s.Root())
	importer.OnCancel(stale)
	importer.OnProgress(func(p packimport.Progress) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if stale() {
			return
		}
		s.progress = Progress{Step: p.Step, Done: p.Done, Total: p.Total, Detail: p.Detail, BytesDone: p.BytesDone, BytesTotal: p.BytesTotal}
	})

	report, err := importer.Import(packPath)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.running = false
	if stale() {
		s.outcome = &Outcome{Kind: packimport.KindCancelled, Step: s.progress.Step, Message: "已取消导入；已移入的任务目录保留"}
		return
	}
	if err != nil {
		failure := &packimport.Error{Kind: packimport.KindFailed, Step: s.progress.Step, Message: err.Error()}
		var typed *packimport.Error
		if errorsAs(err, &typed) {
			failure = typed
		}
		s.outcome = &Outcome{Kind: failure.Kind, Step: failure.Step, Message: failure.Message}
		return
	}
	s.outcome = &Outcome{OK: true, Report: &report}
}
