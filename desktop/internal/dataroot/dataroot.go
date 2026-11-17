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
)

// stateFile 是状态文件名，落在应用数据目录（不是数据根内部：数据根被删掉也要能重建）。
const stateFile = "shell-state.json"

type state struct {
	Root string `json:"root"`
}

// StatePath 返回状态文件在应用数据目录里的位置。
func StatePath(appDataDir string) string {
	return filepath.Join(appDataDir, stateFile)
}

// Resolve 返回数据根：状态文件里记下的位置优先，否则用默认位置。返回前确保目录存在。
func Resolve(statePath, defaultRoot string) (string, error) {
	root := defaultRoot
	if saved, ok := readState(statePath); ok && saved.Root != "" {
		root = filepath.FromSlash(saved.Root)
	}
	if root == "" {
		return "", errors.New("数据根为空")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", fmt.Errorf("创建数据根 %s: %w", root, err)
	}
	if err := writeState(statePath, root); err != nil {
		return "", err
	}
	return root, nil
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
func writeState(statePath, root string) error {
	if err := os.MkdirAll(filepath.Dir(statePath), 0o755); err != nil {
		return fmt.Errorf("创建应用数据目录 %s: %w", filepath.Dir(statePath), err)
	}
	data, err := json.Marshal(state{Root: filepath.ToSlash(root)})
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
