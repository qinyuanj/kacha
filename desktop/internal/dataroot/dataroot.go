// Package dataroot 决定本机唯一一份数据根，并在状态文件里记住它。
//
// 一份安装只有一份数据：默认位置是 MyGo 的用户数据目录下的 data，首次启动创建并写进状态文件；
// 之后启动一律回到记下的位置，即使默认位置被改了也不搬数据。状态文件读不懂时退回默认位置并重写，
// 不让启动失败。
package dataroot

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// stateFile 是状态文件名，落在应用数据目录（不是数据根内部：数据根被删掉也要能重建）。
const stateFile = "shell-state.json"

type state struct {
	Root string `json:"root"`
	// Previous 是迁移前的数据根：新位置在启动时用不了就退回它，旧数据仍可访问。
	// 只有迁移会写这个字段；没有迁移过时为空，行为与以前一致（记住的位置被删掉就重建）。
	Previous string `json:"previous,omitempty"`
}

// StatePath 返回状态文件在应用数据目录里的位置。
func StatePath(appDataDir string) string {
	return filepath.Join(appDataDir, stateFile)
}

// Resolve 返回数据根：状态文件里记下的位置优先，否则用默认位置。返回前确保目录存在。
//
// 记下的位置在启动时用不了（迁移到的新位置被删掉、盘没挂上）时退回迁移前的旧位置：
// 半完成或作废的目标不能成为唯一数据来源（#161）。
func Resolve(statePath, defaultRoot string) (string, error) {
	root := defaultRoot
	previous := ""
	if saved, ok := readState(statePath); ok {
		if saved.Root != "" {
			root = filepath.FromSlash(saved.Root)
		}
		previous = filepath.FromSlash(saved.Previous)
	}
	if root == "" {
		return "", errors.New("数据根为空")
	}
	if fallback := fallbackRoot(previous, root); fallback != "" {
		// 记下的位置已经不在了，迁移前的旧位置还在：退回旧位置并把记录改回去。
		// 不在这里重建一个空目录——那会让「空的新位置」成为唯一数据来源，旧数据看着像丢了。
		if err := writeState(statePath, fallback, ""); err != nil {
			return "", err
		}
		return fallback, nil
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", fmt.Errorf("创建数据根 %s: %w", root, err)
	}
	if err := writeState(statePath, root, previous); err != nil {
		return "", err
	}
	return root, nil
}

// fallbackRoot 返回可用的退路：记下的位置已经不在了，而迁移前的旧位置还在时才算。
// 没有迁移过（previous 为空）、两个位置是同一个、或旧位置也没了，都返回空串，
// 调用方按原来的方式重建记下的位置。
func fallbackRoot(previous, root string) string {
	if previous == "" || strings.EqualFold(previous, root) {
		return ""
	}
	if info, err := os.Stat(root); err == nil && info.IsDir() {
		return ""
	}
	if info, err := os.Stat(previous); err != nil || !info.IsDir() {
		return ""
	}
	return previous
}

// Remember 把数据根记录改成 root，并把 previous 记成退路：迁移在内容复制并校验成功后调用，
// 此前旧位置一直生效。传空 previous 时清掉退路（原地确认同一份数据根）。
func Remember(statePath, root, previous string) error {
	if root == "" {
		return errors.New("数据根为空")
	}
	if strings.EqualFold(previous, root) {
		previous = ""
	}
	return writeState(statePath, root, previous)
}

// readState 读状态文件；不存在或读不懂都当没记过（调用方退回默认位置）。
func readState(statePath string) (state, bool) {
	data, err := os.ReadFile(statePath)
	if err != nil {
		return state{}, false
	}
	var s state
	if err := json.Unmarshal(data, &s); err != nil {
		return state{}, false
	}
	return s, true
}

// writeState 原子写状态文件：先写同目录临时文件再改名，半截文件不会留下来。
func writeState(statePath, root, previous string) error {
	if err := os.MkdirAll(filepath.Dir(statePath), 0o755); err != nil {
		return fmt.Errorf("创建应用数据目录 %s: %w", filepath.Dir(statePath), err)
	}
	data, err := json.Marshal(state{Root: filepath.ToSlash(root), Previous: filepath.ToSlash(previous)})
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(statePath), stateFile+".*.tmp")
	if err != nil {
		return fmt.Errorf("写状态文件 %s: %w", statePath, err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return fmt.Errorf("写状态文件 %s: %w", statePath, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("写状态文件 %s: %w", statePath, err)
	}
	if err := os.Rename(tmp.Name(), statePath); err != nil {
		return fmt.Errorf("写状态文件 %s: %w", statePath, err)
	}
	return nil
}
