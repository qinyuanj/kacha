//go:build !windows

package gateway

// 非 Windows 没有 Windows 系统保护：读当没有密钥，写与清除明确不可用。
type credentialStore interface {
	Load() (string, error)
	Save(secret string) error
	Delete() error
}

type unsupportedStore struct{}

func newCredentialStore(string) credentialStore { return unsupportedStore{} }
func (unsupportedStore) Load() (string, error)  { return "", nil }
func (unsupportedStore) Save(string) error      { return ErrUnsupported }
func (unsupportedStore) Delete() error          { return ErrUnsupported }
