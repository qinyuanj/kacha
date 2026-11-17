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
	// moving 表示正在把数据根整份复制到新位置（#161）。复制期间状态记录还没切，
	// 写进旧位置的内容在切换重载后就丢了，所以这一段里写数据根的操作一律拦下。
	moving bool
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

// BeginMove 标记迁移开始；已经在迁移中时返回 false（两次迁移不能同时跑）。
//
// 标记与复制必须在同一段里：标记之后的写入都被拦下，直到 Switch 或 EndMove。
func (r *Roots) BeginMove() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.moving {
		return false
	}
	r.moving = true
	return true
}

// EndMove 结束迁移标记；成功与失败都要调，否则写入会一直是被拦的状态。
func (r *Roots) EndMove() {
	r.mu.Lock()
	r.moving = false
	r.mu.Unlock()
}

// Moving 报告是否正在迁移：期间写数据根的操作会被拦下，不写进即将作废的旧位置。
func (r *Roots) Moving() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.moving
}
