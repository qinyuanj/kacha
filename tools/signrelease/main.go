// signrelease 在发布环境给安装器签名并写出更新描述（#164）。
//
// 只做一件事：把发布者私钥签的「安装器 SHA-256 摘要」写成 .sig 与
// update-windows-amd64.json，让客户端能独立验签。私钥只从环境变量读，
// 不进仓库、不进发行资产、也不打印。
//
// 用法（在仓库根）：
//
//	go run ./tools/signrelease -installer build/windows-amd64/kacha-setup-1.5.0-amd64.exe \
//	    -version 1.5.0 -notes docs/release/changelog.md \
//	    -base-url http://lzxsvn:3000 -out build/windows-amd64
//
// 发布说明的唯一来源是 docs/release/changelog.md（ADR 0024）：传整份文档即可，
// 工具取其中当前版本那一节写进描述。另立一份 release-notes-<版本>.md 会让说明有两个来源。
//
// 验签（发布前核对资产）走 desktop/cmd/verifyrelease：内置公钥在 desktop/internal 下，
// 只有 desktop/ 里的代码能读到它，发布脚本因此调那条命令而不是在这里再写一份。
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
	notes := flag.String("notes", "", "更新说明文档（必填）：传 docs/release/changelog.md，取其中当前版本一节")
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
	notesText, err := os.ReadFile(notesPath)
	if err != nil {
		return err
	}
	notes, ok := notesSection(string(notesText), version)
	if !ok {
		return fmt.Errorf("发布说明缺少「# %s」一节：更新说明的唯一来源是 docs/release/changelog.md", version)
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

// notesSection 取发布说明里当前版本那一节（含一级标题，到下一个一级标题前）。
//
// 说明的唯一来源是 docs/release/changelog.md：它把当前版本写在前、历史版本留在后面，
// 所以按一级标题切出当前版本这一节，描述里就不会混进历史版本的条目。
func notesSection(text, version string) (string, bool) {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	start := -1
	for i, line := range lines {
		if !strings.HasPrefix(line, "# ") {
			continue
		}
		if start >= 0 {
			return strings.TrimRight(strings.Join(lines[start:i], "\n"), "\n") + "\n", true
		}
		if strings.TrimSpace(line[2:]) == version {
			start = i
		}
	}
	if start < 0 {
		return "", false
	}
	return strings.TrimRight(strings.Join(lines[start:], "\n"), "\n") + "\n", true
}


