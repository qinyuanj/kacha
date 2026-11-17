// Package pathguard 判「这个路径还在数据根里吗」。
//
// 桌面壳把用户数据放在一个可切换的数据根里（dataroot.Roots），存储、导入导出、结果保存与
// 迁移都要回答同一个问题。各处自己写一遍前缀判断时，最容易漏的是三件事：
//
//   - 前缀必须按分隔符对齐：C:\\data 与 C:\\data2 不是一回事；
//   - Windows 盘符与目录名大小写不敏感，比较要忽略大小写；
//   - 「等于根」算不算在根里，取决于调用方，所以拆成 Inside 与 InsideOrSame。
//
// 这里只做词法判定。符号链接的真实位置另算：localstore 会在词法检查之后再按真实路径核对
// （checkRealContainment），因为它要防的是根内一条链接指向根外。
package pathguard

import (
	"os"
	"path/filepath"
	"strings"
)

// Inside 报告 path 是否在 root 之下；root 自己不算在里面。
//
// 两个参数都会先取绝对路径，所以相对路径按当前工作目录解释。
func Inside(root, path string) bool {
	root, path, ok := absolutize(root, path)
	if !ok {
		return false
	}
	return strings.HasPrefix(strings.ToLower(path), prefix(root))
}

// InsideOrSame 报告 path 是否等于 root 或在 root 之下。
func InsideOrSame(root, path string) bool {
	return Same(root, path) || Inside(root, path)
}

// Same 报告两个路径是否指同一处（大小写不敏感，Windows）。
func Same(a, b string) bool {
	absA, err := filepath.Abs(a)
	if err != nil {
		return false
	}
	absB, err := filepath.Abs(b)
	if err != nil {
		return false
	}
	return strings.EqualFold(filepath.Clean(absA), filepath.Clean(absB))
}

// absolutize 取两个参数清理后的绝对路径；读不出来时调用方按「不在根里」处理。
func absolutize(root, path string) (string, string, bool) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", "", false
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", "", false
	}
	return filepath.Clean(absRoot), filepath.Clean(absPath), true
}

// prefix 是「在根里」的小写前缀：根加一个分隔符。
//
// 根本身以分隔符结尾时（例如盘符根 C:\\）不能再补一个，否则 C:\\data 判不出来。
func prefix(root string) string {
	lowered := strings.ToLower(root)
	if strings.HasSuffix(lowered, string(os.PathSeparator)) {
		return lowered
	}
	return lowered + string(os.PathSeparator)
}
