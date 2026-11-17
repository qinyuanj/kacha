// Package gateway 是页面的网关能力在本机的实现：受系统保护的密钥与真实 HTTP 请求。
// 这里只做原生能力，设置文案与模型交集中在 client/src/core，二者通过壳端口连接。
package gateway

import "errors"

// ErrUnsupported 表示当前平台没有 Windows 系统保护；能力保持明确不可用。
var ErrUnsupported = errors.New("当前平台不支持 Windows 系统保护")

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
}

// New 用数据根下的密钥文件路径造服务；不创建文件。
func New(credPath string) *Service {
	return &Service{credPath: credPath, creds: newCredentialStore(credPath)}
}

// ReadApiKey 读回当前保存的密钥；没有保存过返回空串。
func (s *Service) ReadApiKey() (string, error) {
	return s.creds.Load()
}

// WriteApiKey 保存或替换密钥；明文不写进普通设置或日志。
func (s *Service) WriteApiKey(key string) error {
	return s.creds.Save(key)
}

// DeleteApiKey 清除密钥；清除后重启读不到。
func (s *Service) DeleteApiKey() error {
	return s.creds.Delete()
}
