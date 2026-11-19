// Command verifyrelease 在发布前核对更新资产：描述里的签名必须能被这次构建内置的
// 发布者公钥验证（与客户端装包前用的是同一个公钥、同一条 Ed25519 规则）。
//
// 为什么在 desktop/ 下：内置公钥文件在 desktop/internal/updateservice，Go 的 internal
// 包只能被 desktop/ 下的代码导入。发布脚本（packaging/publish_release.py）因此调这里，
// 而不是在 Python 里再写一份验签——两份判断迟早会漂移，这里错一次就发出去一个装不上的包。
//
// 用法（在仓库根）：
//
//	# 构建之前：核对发布私钥与这次构建内置的公钥是不是一对
//	go run ./desktop/cmd/verifyrelease -check-private-key
//
//	# 构建之后：核对描述里的签名能被内置公钥验证
//	go run ./desktop/cmd/verifyrelease -installer build/windows-amd64/kacha-setup-1.5.0-amd64.exe \
//	    -descriptor build/windows-amd64/update-windows-amd64.json
//
// 退出码非 0 表示核对不通过（含「这次构建没有内置公钥」），原因与下一步动作写在 stderr。
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/qinyuanj/kacha/desktop/internal/updateservice"
)

const (
	// privateKeyEnv 是发布者私钥的唯一来源；私钥不走命令行参数（会进 shell 历史与进程列表）。
	privateKeyEnv = "MYGO_UPDATER_PRIVATE_KEY"
	// publisherKeyFile 是内置公钥文件：失败文案要指出该动哪个文件，而不只是说「对不上」。
	publisherKeyFile = "desktop/internal/updateservice/publisher_key.txt"
)

// descriptor 是待核对的更新描述（字段与客户端 updateservice.Manifest 一致）。
type descriptor struct {
	Signature string `json:"signature"`
}

func main() {
	installer := flag.String("installer", "", "安装器路径（-check-private-key 之外必填）")
	descriptorPath := flag.String("descriptor", "", "更新描述路径（-check-private-key 之外必填）")
	checkPrivateKeyOnly := flag.Bool("check-private-key", false,
		"只核对 "+privateKeyEnv+" 的私钥与内置发布者公钥是否配对（构建前先跑）")
	flag.Parse()
	if *checkPrivateKeyOnly {
		publicText, err := checkPrivateKey(os.Getenv(privateKeyEnv), updateservice.PublisherKey())
		if err != nil {
			fmt.Fprintln(os.Stderr, "私钥预检失败："+err.Error())
			os.Exit(1)
		}
		fmt.Println("私钥预检通过：私钥与内置发布者公钥配对（公钥 " + publicText + "），可以开始构建")
		return
	}
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

// checkPrivateKey 核对发布私钥与这次构建内置的发布者公钥是不是一对，返回推导出的公钥（base64）。
//
// 同一个判断原本只在发布阶段出现：verifyWithKey 拒绝时说对不上，那时整次构建已经白跑。
// 这里把它提到构建之前，配错当场暴露；失败文案给出「写哪个文件、写哪个值」，
// 因为「mismatch」本身不构成一个能照做的动作。
//
// 只读：不改 publisher_key.txt。写不写公钥、换成哪一对密钥是发布者身份决策（#165 的 B2），
// 本命令只负责把错配挡在构建之前。之所以能给出该写的公钥，是因为公钥由私钥推导得出；
// 全程不打印私钥本身——私钥进终端或日志就等于泄露。
func checkPrivateKey(privateKeyText, builtinKeyText string) (string, error) {
	text := strings.TrimSpace(privateKeyText)
	if text == "" {
		return "", fmt.Errorf("没有设置 %s：发布者私钥只在发布环境提供。下一步：在受限发布环境设好该变量（PowerShell 用 $env:%s）再重跑；私钥不要写进仓库、命令行参数或脚本", privateKeyEnv, privateKeyEnv)
	}
	raw, decodeErr := base64.StdEncoding.DecodeString(text)
	if decodeErr != nil {
		return "", fmt.Errorf("%s 不是 base64 的 mygo keygen 私钥：%w。下一步：用 go tool mygo keygen -o <目录> 生成一对密钥，把 mygo-update.key 的全部内容设进 %s", privateKeyEnv, decodeErr, privateKeyEnv)
	}
	if len(raw) != ed25519.PrivateKeySize {
		return "", fmt.Errorf("%s 解出 %d 字节，期望 %d 字节（mygo keygen 的 mygo-update.key）。下一步：重新生成密钥对，或改用正确的 mygo-update.key 内容", privateKeyEnv, len(raw), ed25519.PrivateKeySize)
	}
	publicText := base64.StdEncoding.EncodeToString(ed25519.PrivateKey(raw).Public().(ed25519.PublicKey))
	builtin := strings.TrimSpace(builtinKeyText)
	if builtin == "" {
		return publicText, fmt.Errorf("这次构建没有内置发布者公钥（%s 只有注释），更新入口因此关闭。下一步：把公钥 %s 写进 %s 的第一行，再重建客户端；是否采用这一对密钥由发布负责人决定", publisherKeyFile, publicText, publisherKeyFile)
	}
	key, err := updateservice.ParsePublicKey(builtin)
	if err != nil {
		return publicText, fmt.Errorf("内置发布者公钥不可用（%s 里不是 base64 的 %d 字节 Ed25519 公钥）：%w。下一步：把公钥 %s 写进该文件的第一行，再重建客户端", publisherKeyFile, ed25519.PublicKeySize, err, publicText)
	}
	if !bytes.Equal(key, ed25519.PrivateKey(raw).Public().(ed25519.PublicKey)) {
		return publicText, fmt.Errorf("私钥与内置公钥不配对：私钥推导出的公钥是 %s，内置的是 %s。下一步：先确认要发的是哪一对——沿用内置公钥就换回与它配对的私钥；改用这对新密钥就把 %s 写进 %s 并重建客户端。改好后重跑本命令，通过再开始构建", publicText, builtin, publicText, publisherKeyFile)
	}
	return publicText, nil
}
