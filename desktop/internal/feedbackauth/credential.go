package feedbackauth

import "path/filepath"

type tokenStore interface {
	Load() (string, error)
	Save(secret string) error
	Delete() error
}

func newTokenStore(root string) tokenStore {
	return newCredentialStore(filepath.Join(root, "feedback-oauth-token.dat"))
}
