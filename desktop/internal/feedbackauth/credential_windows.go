//go:build windows

package feedbackauth

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

type dpapiStore struct{ path string }

func newCredentialStore(path string) tokenStore { return &dpapiStore{path: path} }

func feedbackBlob(data []byte) *windows.DataBlob {
	if len(data) == 0 {
		return &windows.DataBlob{}
	}
	return &windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
}

func feedbackBytes(blob windows.DataBlob) []byte {
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
	if err := windows.CryptProtectData(feedbackBlob([]byte(secret)), nil, nil, 0, nil, 0, &out); err != nil {
		return fmt.Errorf("保护 Gitea 授权失败: %w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	encoded := []byte(base64.StdEncoding.EncodeToString(feedbackBytes(out)))
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".feedback-oauth-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(encoded); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, s.path)
}

func (s *dpapiStore) Load() (string, error) {
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	raw, err := base64.StdEncoding.DecodeString(string(data))
	if err != nil {
		return "", errors.New("Gitea 授权文件格式无效")
	}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(feedbackBlob(raw), nil, nil, 0, nil, 0, &out); err != nil {
		return "", fmt.Errorf("解保护 Gitea 授权失败: %w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return string(feedbackBytes(out)), nil
}

func (s *dpapiStore) Delete() error {
	if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
