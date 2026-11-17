package dataroot

import (
	"path/filepath"
	"sync"
)

// Roots 是进程内共享的数据根：一份安装只有一份数据，但位置会因迁移而改变。
//
// 服务在构造时拿到它而不是一个字符串，迁移切一次之后所有读取都落到新位置，
// 不必重建服务或重启进程。
type Roots struct {
	mu   sync.RWMutex
	root string
}

// NewRoots 用启动时解析出的数据根造一个共享位置。
func NewRoots(root string) *Roots {
	return &Roots{root: root}
}

// Current 返回当前数据根的绝对路径。
func (r *Roots) Current() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.root
}

// Switch 换到迁移后的新位置；只应在内容复制并校验成功、状态记录已改写之后调用。
func (r *Roots) Switch(root string) {
	r.mu.Lock()
	r.root = root
	r.mu.Unlock()
}

// Join 返回数据根下的绝对路径（拼一段相对路径）。
func (r *Roots) Join(parts ...string) string {
	return filepath.Join(append([]string{r.Current()}, parts...)...)
}
