// Package gateway 是页面的网关能力在本机的实现：受系统保护的密钥与真实 HTTP 请求。
// 这里只做原生能力，设置文案与模型交集中在 client/src/core，二者通过壳端口连接。
package gateway

import (
	"errors"
	"path/filepath"

	"github.com/qinyuanj/kacha/desktop/internal/dataroot"
)

// ErrUnsupported 表示当前平台没有 Windows 系统保护；能力保持明确不可用。
var ErrUnsupported = errors.New("当前平台不支持 Windows 系统保护")

// keyFile 是数据根下受保护密钥的文件名；迁移把它和别的数据一起复制过去。
const keyFile = "api-key.protected"

// credentialStore 是密钥持久化的最小接口，Windows 实现用 DPAPI。
type credentialStore interface {
	Load() (string, error)
	Save(secret string) error
	Delete() error
}

// Service 持有一个受保护密钥文件的位置；每次调用都重新读文件，不缓存明文。
type Service struct {
	credPath string
	creds    credentialStore
	// roots 是可切换的数据根（迁移 #161）：装了它，密钥文件跟着新位置走。
	// 迁移把整份数据根（含密钥文件）复制过去，所以切换后同一份凭据仍然可用。
	roots *dataroot.Roots
}

// New 用数据根下的密钥文件路径造服务；不创建文件。
func New(credPath string) *Service {
	return &Service{credPath: credPath, creds: newCredentialStore(credPath)}
}

// NewFollowing 造一个跟着共享数据根走的服务：密钥文件在数据根下，切换后落到新位置。
func NewFollowing(roots *dataroot.Roots) *Service {
	return &Service{roots: roots}
}

// credFile 返回当前的密钥文件路径。
func (s *Service) credFile() string {
	if s.roots != nil {
		return filepath.Join(s.roots.Current(), keyFile)
	}
	return s.credPath
}

// store 返回当前密钥文件的持久化实现；位置变了就换一个，不缓存明文。
func (s *Service) store() credentialStore {
	if s.roots == nil {
		return s.creds
	}
	return newCredentialStore(s.credFile())
}

// ReadApiKey 读回当前保存的密钥；没有保存过返回空串。
func (s *Service) ReadApiKey() (string, error) {
	return s.store().Load()
}

// WriteApiKey 保存或替换密钥；明文不写进普通设置或日志。
func (s *Service) WriteApiKey(key string) error {
	return s.store().Save(key)
}

// DeleteApiKey 清除密钥；清除后重启读不到。
func (s *Service) DeleteApiKey() error {
	return s.store().Delete()
}
