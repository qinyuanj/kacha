package packservice

import (
	"os"
	"sync"
	"sync/atomic"

	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/packexport"
)

// exportSaveDialog 选导出目标；测试替换掉，不弹窗。
var exportSaveDialog = func(opts mygo.SaveDialogOptions) (string, error) { return mygo.Dialog.Save(opts) }

// exportOverwriteDialog 问用户要不要覆盖已存在的目标；测试替换掉，不弹窗。
//
// 这个包级 var 是有意保留的测试接缝，不要为了「和 storage 对齐」删掉它：
//
//   - 覆盖确认有两条用户可见分支，必须能在单测里分别驱动。「确认覆盖」分支就是 #228 修掉的
//     缺陷（用户确认后导出仍然失败）；「取消/未确认」分支要求原文件一个字节都不动。这两条
//     契约只能在 PickExport 这一层观察，而系统对话框在测试里不会弹，所以需要一个可替换的
//     接缝——它替换的是「用户的回答」，不是被测逻辑本身。
//   - storage 的 Pick（选目标）没有对应分支契约：它只有「用户选了路径」与「用户取消」，
//     取消由返回空路径表达，测试可以直接用真实签名走到同一个结局，没有第二条要分辨的
//     用户意图。那里删掉 openDialog 之后，真实调用链反而更短。
//
// 判据是「有没有必须驱动、且无法用其它方式表达的分支」：有就留接缝，没有就直调。
// 新增对话框时按这条判断，不要按「与其它包保持一致」来取舍。
var exportOverwriteDialog = func(target string) (bool, error) {
	res, err := mygo.Dialog.Message(mygo.MessageOptions{
		Type:               mygo.MessageWarning,
		Title:              "导出画板包",
		Message:            "目标已存在，是否覆盖？",
		Detail:             target,
		Buttons:            []string{"覆盖", "取消"},
		DefaultButton:      1,
		CancelButton:       1,
		DestructiveButtons: []int{0},
	})
	if err != nil {
		return false, err
	}
	return res.Button == 0, nil
}

// ExportTarget 是选导出目标的结局：Path 为空表示取消；Overwrite 表示用户已明确确认覆盖已存在的目标。
type ExportTarget struct {
	Path      string `json:"path"`
	Overwrite bool   `json:"overwrite"`
}

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

// PickExport 让用户选导出目标（本机绝对位置），取消时返回空 Path。
// 目标已存在时在这里再问一次要不要覆盖：系统「另存为」提示过什么不作为依据，
// 覆盖许可由本机显式取得，导出侧只认这个许可。
func (s *Service) PickExport(name string) (ExportTarget, error) {
	path, err := exportSaveDialog(mygo.SaveDialogOptions{
		Title:       "导出画板包",
		DefaultPath: name,
		Filters:     []mygo.FileFilter{{Name: "画板包", Extensions: []string{"ugcpack"}}},
	})
	if err != nil || path == "" {
		return ExportTarget{}, err
	}
	if _, statErr := os.Stat(path); statErr != nil {
		return ExportTarget{Path: path}, nil
	}
	confirmed, confirmErr := exportOverwriteDialog(path)
	if confirmErr != nil {
		return ExportTarget{}, confirmErr
	}
	if !confirmed {
		// 用户没确认：按取消结束，原文件一个字节都不动。
		return ExportTarget{}, nil
	}
	return ExportTarget{Path: path, Overwrite: true}, nil
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
func (s *Service) Export(target string, spec packexport.Spec, overwrite bool) ExportOutcome {
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
	go s.runExport(target, spec, overwrite, generation)
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
func (s *Service) runExport(target string, spec packexport.Spec, overwrite bool, generation int64) {
	st := &s.export
	stale := func() bool { return st.generation.Load() != generation }
	result, err := packexport.Export(s.Root(), target, spec, overwrite, func(p packexport.Progress) {
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
