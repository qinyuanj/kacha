package packservice

import (
	"sync"
	"sync/atomic"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/packexport"
)

// exportSaveDialog 选导出目标；测试替换掉，不弹窗。
var exportSaveDialog = func(opts mygo.SaveDialogOptions) (string, error) { return mygo.Dialog.Save(opts) }

// ExportOutcome 是一次导出的结局：成功带计数，失败带类别与步骤。
type ExportOutcome struct {
	OK      bool `json:"ok"`
	Kind    string `json:"kind"`
	Step    string `json:"step"`
	Message string `json:"message"`
	Result  *packexport.Result `json:"result,omitempty"`
}

// ExportSnapshot 是当前（或最近一次）导出的状态：页面轮询它。
type ExportSnapshot struct {
	Running  bool `json:"running"`
	Progress Progress `json:"progress"`
	Outcome  *ExportOutcome `json:"outcome"`
}

// exportState 与导入状态分开：两边可以同时有各自的进度与取消标记。
type exportState struct {
	mu         sync.Mutex
	running    bool
	progress   Progress
	outcome    *ExportOutcome
	generation atomic.Int64
}

// PickExport 让用户选导出目标（本机绝对位置），取消时返回空串。
func (s *Service) PickExport(name string) (string, error) {
	paths, err := exportSaveDialog(mygo.SaveDialogOptions{
		Title:       "导出画板包",
		DefaultPath: name,
		Filters:     []mygo.FileFilter{{Name: "画板包", Extensions: []string{"ugcpack"}}},
	})
	if err != nil || len(paths) > 0 {
		return paths, err
	}
	return "", err
}

// Facts 算包内每个文件的长度与 sha256，供页面按既有规则去重与预估大小。
func (s *Service) Facts(spec packexport.Spec) ([]packexport.Fact, error) {
	facts, failure := packexport.Facts(s.Root(), spec)
	if failure != nil {
		return nil, failure
	}
	return facts, nil
}

// Export 开始导出：立刻返回；真实进度与结局由 ExportSnapshot 取。
func (s *Service) Export(target string, spec packexport.Spec) ExportOutcome {
	if s.moving() {
		return ExportOutcome{Kind: KindMoving, Step: packexport.StepCheck, Message: "正在迁移数据位置，完成前不能导出画板包"}
	}
	st := &s.export
	st.mu.Lock()
	if st.running {
		st.mu.Unlock()
		return ExportOutcome{Kind: "busy", Message: "已有导出在进行，请等它结束"}
	}
	st.running = true
	st.progress = Progress{Step: packexport.StepCheck, Detail: "正在检查"}
	st.outcome = nil
	generation := st.generation.Add(1)
	st.mu.Unlock()
	go s.runExport(target, spec, generation)
	return ExportOutcome{OK: true}
}

// ExportSnapshot 返回当前（或最近一次）导出的状态。
func (s *Service) ExportSnapshot() ExportSnapshot {
	st := &s.export
	st.mu.Lock()
	defer st.mu.Unlock()
	return ExportSnapshot{Running: st.running, Progress: st.progress, Outcome: st.outcome}
}

// CancelExport 取消当前导出：未提交的目标不会留下，临时产物由打包器清理。
func (s *Service) CancelExport() {
	st := &s.export
	st.mu.Lock()
	running := st.running
	st.mu.Unlock()
	if running {
		st.generation.Add(1)
	}
}

// runExport 在后台打包，把进度与结局写回快照。
func (s *Service) runExport(target string, spec packexport.Spec, generation int64) {
	st := &s.export
	stale := func() bool { return st.generation.Load() != generation }
	result, err := packexport.Export(s.Root(), target, spec, func(p packexport.Progress) {
		st.mu.Lock()
		defer st.mu.Unlock()
		if stale() {
			return
		}
		st.progress = Progress{Step: p.Step, Done: p.Done, Total: p.Total, Detail: p.Detail, BytesDone: p.BytesDone, BytesTotal: p.BytesTotal}
	}, stale)

	st.mu.Lock()
	defer st.mu.Unlock()
	st.running = false
	if stale() || (err != nil && err.Kind == packexport.KindCancelled) {
		st.outcome = &ExportOutcome{Kind: packexport.KindCancelled, Step: packexport.StepPack, Message: "已取消导出"}
		return
	}
	if err != nil {
		st.outcome = &ExportOutcome{Kind: err.Kind, Step: err.Step, Message: err.Message}
		return
	}
	st.outcome = &ExportOutcome{OK: true, Result: &result}
}
