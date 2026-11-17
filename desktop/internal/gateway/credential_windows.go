//go:build windows

package gateway

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// dpapiStore 用 Windows DPAPI 按当前用户保护密钥：密文落在数据根，明文只在内存里短暂存在。
type dpapiStore struct {
	path string
}

func newCredentialStore(path string) credentialStore { return &dpapiStore{path: path} }

func dataBlob(data []byte) *windows.DataBlob {
	if len(data) == 0 {
		return &windows.DataBlob{}
	}
	return &windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
}

func blobBytes(blob windows.DataBlob) []byte {
	if blob.Size == 0 || blob.Data == nil {
		return nil
	}
	return unsafe.Slice(blob.Data, int(blob.Size))
}

func (s *dpapiStore) Save(secret string) error {
	if secret == "" {
		return s.Delete()
	}
	var out windows.DataBlob
	if err := windows.CryptProtectData(dataBlob([]byte(secret)), nil, nil, 0, nil, 0, &out); err != nil {
		return fmt.Errorf("保护 API 密钥失败: %w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	encoded := []byte(base64.StdEncoding.EncodeToString(blobBytes(out)))
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建密钥目录失败: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".api-key-*")
	if err != nil {
		return fmt.Errorf("写保护密钥失败: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(encoded); err != nil {
		tmp.Close()
		return fmt.Errorf("写保护密钥失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("写保护密钥失败: %w", err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return fmt.Errorf("写保护密钥失败: %w", err)
	}
	return nil
}

func (s *dpapiStore) Load() (string, error) {
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("读保护密钥失败: %w", err)
	}
	raw, err := base64.StdEncoding.DecodeString(string(data))
	if err != nil {
		return "", fmt.Errorf("保护密钥文件格式无效")
	}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(dataBlob(raw), nil, nil, 0, nil, 0, &out); err != nil {
		return "", fmt.Errorf("解保护 API 密钥失败: %w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return string(blobBytes(out)), nil
}

func (s *dpapiStore) Delete() error {
	if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("清除 API 密钥失败: %w", err)
	}
	return nil
}
