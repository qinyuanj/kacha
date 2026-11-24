//go:build !windows

package feedbackauth

type unsupportedStore struct{}

func newCredentialStore(string) tokenStore     { return unsupportedStore{} }
func (unsupportedStore) Load() (string, error) { return "", nil }
func (unsupportedStore) Save(string) error     { return ErrUnsupported }
func (unsupportedStore) Delete() error         { return ErrUnsupported }
