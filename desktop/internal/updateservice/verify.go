package updateservice

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// ErrBadSignature 是验签失败：签名对不上这个包、这个公钥，或格式不合法。
//
// 它与「下载没完成」是两件事：包字节可以完整、长度也对，签名仍然可能是伪造的。
// 所以下载完成不等于可安装，只有 Verify 通过才进 ready。
var ErrBadSignature = errors.New("updateservice: the package is not signed by the publisher")

// ParsePublicKey 解析内置的发布者公钥（base64 的 32 字节 Ed25519 公钥）。
func ParsePublicKey(text string) (ed25519.PublicKey, error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(text))
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("invalid publisher public key")
	}
	return ed25519.PublicKey(b), nil
}

// Verify 用发布者公钥核对「包摘要 + 签名」。
//
// 签名覆盖的是包的 SHA-256 摘要，base64 编码；哈希本身只能发现损坏，
// 证明不了是谁发布的，所以这里的公钥校验不能省。
func Verify(key ed25519.PublicKey, digest []byte, signature string) error {
	if len(key) != ed25519.PublicKeySize {
		return ErrBadSignature
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signature))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return ErrBadSignature
	}
	if len(digest) != sha256.Size || !ed25519.Verify(key, digest, sig) {
		return ErrBadSignature
	}
	return nil
}

// sameSignature 判断描述里的签名与 .sig 附件是不是同一个值。
//
// 两者都发布在同一份发行里：对不上说明资产是半套（描述先传、签名后传或传错版本），
// 这种发行不能装。
func sameSignature(descriptor, asset string) error {
	a := strings.TrimSpace(descriptor)
	b := strings.TrimSpace(asset)
	if a == "" || b == "" || a != b {
		return fmt.Errorf("描述里的签名与 .sig 附件不一致")
	}
	return nil
}
