// signrelease 在发布环境给安装器签名并写出更新描述（#164）。
//
// 只做一件事：把发布者私钥签的「安装器 SHA-256 摘要」写成 .sig 与
// update-windows-amd64.json，让客户端能独立验签。私钥只从环境变量读，
// 不进仓库、不进发行资产、也不打印。
//
// 用法（在仓库根）：
//
//	go run ./tools/signrelease -installer build/windows-amd64/kacha-setup-1.5.0-amd64.exe \
//	    -version 1.5.0 -notes docs/release/release-notes-1.5.0.md \
//	    -base-url http://lzxsvn:3000 -out build/windows-amd64
//
// 私钥来自 MYGO_UPDATER_PRIVATE_KEY（`go tool mygo keygen` 生成的 mygo-update.key 内容）。
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	ownerRepo = "qinyuanj/kacha"
	// platform 是本项目的唯一发布目标。
	platform = "windows-amd64"
)

var formalVersion = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// descriptor 是客户端读的更新描述：字段与 desktop/internal/updateservice.Manifest 一致。
type descriptor struct {
	Version   string `json:"version"`
	Platform  string `json:"platform"`
	URL       string `json:"url"`
	Size      int64  `json:"size"`
	Signature string `json:"signature"`
	Notes     string `json:"notes"`
}

func main() {
	installer := flag.String("installer", "", "安装器路径（必填）")
	version := flag.String("version", "", "版本号 X.Y.Z（必填）")
	notes := flag.String("notes", "", "发布说明 Markdown 路径（必填，需含 # <版本> 标题）")
	baseURL := flag.String("base-url", "http://lzxsvn:3000", "Gitea 地址")
	out := flag.String("out", "", "输出目录（默认与安装器同目录）")
	flag.Parse()
	if err := run(*installer, *version, *notes, *baseURL, *out); err != nil {
		fmt.Fprintln(os.Stderr, "签名失败："+err.Error())
		os.Exit(1)
	}
}

func run(installer, version, notesPath, baseURL, out string) error {
	if installer == "" || version == "" || notesPath == "" {
		return fmt.Errorf("-installer、-version 与 -notes 都是必填")
	}
	if !formalVersion.MatchString(version) {
		return fmt.Errorf("版本 %q 不是 X.Y.Z 形式的正式版本", version)
	}
	key, err := signingKey()
	if err != nil {
		return err
	}
	pkg, err := os.ReadFile(installer)
	if err != nil {
		return err
	}
	notes, err := os.ReadFile(notesPath)
	if err != nil {
		return err
	}
	if !hasHeading(string(notes), "# "+version) {
		return fmt.Errorf("发布说明缺少「# %s」标题：描述不完整时不能发布", version)
	}
	sum := sha256.Sum256(pkg)
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(key, sum[:]))
	name := "kacha-setup-" + version + "-amd64.exe"
	if filepath.Base(installer) != name {
		return fmt.Errorf("安装器文件名必须是 %s，当前是 %s", name, filepath.Base(installer))
	}
	dir := out
	if dir == "" {
		dir = filepath.Dir(installer)
	}
	// .sig 与描述写同一个签名：客户端两边都能核对，改一个就露馅。
	if err := os.WriteFile(filepath.Join(dir, name+".sig"), []byte(sig+"\n"), 0o644); err != nil {
		return err
	}
	m := descriptor{
		Version:   version,
		Platform:  platform,
		URL:       fmt.Sprintf("%s/%s/releases/download/v%s/%s", strings.TrimRight(baseURL, "/"), ownerRepo, version, name),
		Size:      int64(len(pkg)),
		Signature: sig,
		Notes:     string(notes),
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "update-"+platform+".json"), append(data, '\n'), 0o644)
}

// signingKey 只从环境变量读私钥：私钥不进仓库，也不从文件路径推断。
func signingKey() (ed25519.PrivateKey, error) {
	text := strings.TrimSpace(os.Getenv("MYGO_UPDATER_PRIVATE_KEY"))
	if text == "" {
		return nil, fmt.Errorf("没有设置 MYGO_UPDATER_PRIVATE_KEY：发布者私钥只在发布环境提供")
	}
	raw, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		return nil, fmt.Errorf("私钥不是 base64：%w", err)
	}
	if len(raw) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("私钥长度是 %d，期望 %d（mygo keygen 的 mygo-update.key）", len(raw), ed25519.PrivateKeySize)
	}
	return ed25519.PrivateKey(raw), nil
}

// hasHeading 要求说明里有本版本的一级标题：没有标题等于描述不完整。
func hasHeading(notes, heading string) bool {
	for _, line := range strings.Split(notes, "\n") {
		if strings.TrimSpace(line) == heading {
			return true
		}
	}
	return false
}
