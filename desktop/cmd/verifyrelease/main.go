// Command verifyrelease 在发布前核对更新资产：描述里的签名必须能被这次构建内置的
// 发布者公钥验证（与客户端装包前用的是同一个公钥、同一条 Ed25519 规则）。
//
// 为什么在 desktop/ 下：内置公钥文件在 desktop/internal/updateservice，Go 的 internal
// 包只能被 desktop/ 下的代码导入。发布脚本（packaging/publish_release.py）因此调这里，
// 而不是在 Python 里再写一份验签——两份判断迟早会漂移，这里错一次就发出去一个装不上的包。
//
// 用法（在仓库根）：
//
//	go run ./desktop/cmd/verifyrelease -installer build/windows-amd64/kacha-setup-1.5.0-amd64.exe \
//	    -descriptor build/windows-amd64/update-windows-amd64.json
//
// 退出码非 0 表示验签不通过（含「这次构建没有内置公钥」），原因写在 stderr。
package main

import (
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/qinyuanj/kacha/desktop/internal/updateservice"
)

// descriptor 是待核对的更新描述（字段与客户端 updateservice.Manifest 一致）。
type descriptor struct {
	Signature string `json:"signature"`
}

func main() {
	installer := flag.String("installer", "", "安装器路径（必填）")
	descriptorPath := flag.String("descriptor", "", "更新描述路径（必填）")
	flag.Parse()
	if err := verifyWithKey(updateservice.PublisherKey(), *installer, *descriptorPath); err != nil {
		fmt.Fprintln(os.Stderr, "验签失败："+err.Error())
		os.Exit(1)
	}
	fmt.Println("验签通过：描述里的签名能被内置发布者公钥验证")
}

// verifyWithKey 用给定的发布者公钥核对「安装器摘要 + 描述里的签名」。
//
// 公钥为空表示这次构建没有可信发布者：直接拒绝，不退化成「只对哈希」——
// 哈希只能发现损坏，证明不了是谁发布的。
func verifyWithKey(keyText, installer, descriptorPath string) error {
	if installer == "" || descriptorPath == "" {
		return fmt.Errorf("-installer 与 -descriptor 都是必填")
	}
	if strings.TrimSpace(keyText) == "" {
		return fmt.Errorf("这次构建没有内置发布者公钥（desktop/internal/updateservice 的公钥文件只有注释），无法确认发布者")
	}
	key, err := updateservice.ParsePublicKey(keyText)
	if err != nil {
		return fmt.Errorf("内置发布者公钥不可用：%w", err)
	}
	pkg, err := os.ReadFile(installer)
	if err != nil {
		return fmt.Errorf("读不了安装器 %s: %w", installer, err)
	}
	raw, err := os.ReadFile(descriptorPath)
	if err != nil {
		return fmt.Errorf("读不了更新描述 %s: %w", descriptorPath, err)
	}
	var m descriptor
	if err := json.Unmarshal(raw, &m); err != nil {
		return fmt.Errorf("更新描述不是有效 JSON: %w", err)
	}
	sum := sha256.Sum256(pkg)
	if err := updateservice.Verify(key, sum[:], m.Signature); err != nil {
		return fmt.Errorf("描述里的签名不是这份安装器的发布者签名：%w", err)
	}
	return nil
}
