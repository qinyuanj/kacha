package packexport

import "github.com/qinyuanj/kacha/desktop/internal/packimport"

// importInto 用既有导入器读回导出包：往返判据来自真正的导入实现，不另造一套。
func importInto(root, pack string) (packimport.Report, error) {
	return packimport.New(root).Import(pack)
}
