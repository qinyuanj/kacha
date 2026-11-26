package localservice

import (
	"github.com/egoist/mygo"

	"github.com/qinyuanj/kacha/desktop/internal/localstore"
	"github.com/qinyuanj/kacha/desktop/internal/resultsave"
)

// SaveResult 把一张结果（带图层时连图层一起）另存到用户选的本机位置。
// 字节由 Go 按路径读，目标由系统对话框选；取消不是失败，也不写文件。
func (s *Service) SaveResult(path string) (Outcome, error) {
	name := resultsave.SuggestedName(s.store.Root(), path)
	target, err := saveDialog(mygo.SaveDialogOptions{
		Title:       "保存结果",
		DefaultPath: name,
		Filters:     []mygo.FileFilter{{Name: "图片或结果包", Extensions: []string{"png", "jpg", "jpeg", "webp", "gif", "zip"}}},
	})
	if err != nil {
		return Outcome{}, err
	}
	if target == "" {
		return Outcome{Kind: "cancelled", Message: "已取消保存"}, nil
	}
	if failure := resultsave.SaveResult(s.store.Root(), path, target); failure != nil {
		return saveFailure(failure.Kind, failure.Message), nil
	}
	return Outcome{OK: true}, nil
}

// saveFailure 把结果保存的类别折成 Local 的结局类别；界面据此给出缺图 / 写失败的说明。
func saveFailure(kind, message string) Outcome {
	outcome := Outcome{OK: false, Kind: localstore.KindFailed, Message: message}
	switch kind {
	case resultsave.KindMissing:
		outcome.Kind = "missing"
	case resultsave.KindForbidden:
		outcome.Kind = localstore.KindInvalid
	}
	return outcome
}
