package updateservice

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// formalVersion 是正式版本：只认 X.Y.Z，预发布（1.2.3-beta.1）与 v 前缀都不算。
var formalVersion = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// ErrNoUpdate 表示这一轮没有可选的新版本（已是最新，或没有完整资产的新版本）。
var ErrNoUpdate = errors.New("updateservice: no newer formal version with complete assets")

// ManifestName 是本平台更新描述的文件名（与 #163 的发布脚本一致）。
const ManifestName = "update-windows-amd64.json"

// Asset 是发行里的一件附件。
//
// URL 取 browser_download_url，不是 url：Gitea 的发行列表里附件根本没有 url 字段
// （Gitea 28.3 实测，2026-11-19），只有浏览器下载地址。映射错字段时 URL 全是空串，
// fetchDescriptor 拿空地址发请求、validateDescriptor 又比不过描述里的地址，
// 结果是「永远显示已是最新」——1.6.0 的更新入口就是这样失效的（见 issue）。
type Asset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

// Release 是一份发行（只保留选版要用的字段）。
type Release struct {
	Tag        string  `json:"tag_name"`
	Draft      bool    `json:"draft"`
	Prerelease bool    `json:"prerelease"`
	Assets     []Asset `json:"assets"`
}

// Manifest 是本平台的更新描述（发布脚本生成，客户端只读）。
type Manifest struct {
	Version   string `json:"version"`
	Platform  string `json:"platform"`
	URL       string `json:"url"`
	Size      int64  `json:"size"`
	Signature string `json:"signature"`
	Notes     string `json:"notes"`
}

// Candidate 是选中的那份更新：描述、包与签名三件俱全，且版本更高。
type Candidate struct {
	Version string
	Notes   string
	// PackageURL 与 SignatureURL 是包里那件安装器与它的签名附件。
	PackageURL   string
	SignatureURL string
	// Size 是描述里声明的安装器字节数（下载完再对一次）。
	Size int64
	// Descriptor 是描述原文：装之前要再核一遍签名与它一致。
	Descriptor Manifest
}

// ReleaseURL 是这份发行在 Gitea 上的页面，手动下载入口用它。
func ReleaseURL(base, ownerRepo, version string) string {
	return fmt.Sprintf("%s/%s/releases/tag/v%s", strings.TrimRight(base, "/"), ownerRepo, version)
}

// InstallerName 是安装器的文件名（与 #163 的发布脚本一致）。
func InstallerName(version string) string {
	return "kacha-setup-" + version + "-amd64.exe"
}

// formalTag 把 tag 折成正式版本号；不是正式版本返回 false。
func formalTag(tag string) (string, bool) {
	v := strings.TrimPrefix(strings.TrimSpace(tag), "v")
	if !formalVersion.MatchString(v) {
		return "", false
	}
	return v, true
}

// compareVersions 按数值比较两个正式版本：a<b 返回 -1，相等 0，a>b 返回 1。
func compareVersions(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		x, y := atoi(as[i]), atoi(bs[i])
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

// atoi 把版本字段折成整数；非数字当 0（formalVersion 已保证是数字）。
func atoi(s string) int {
	n := 0
	for _, r := range s {
		if r < 0x30 || r > 0x39 {
			return n
		}
		n = n*10 + int(r-0x30)
	}
	return n
}

// assetNames 是本平台三件必需资产的命名规则：描述、安装器与签名。
func assetNames(version string) (descriptor, pkg, sig string) {
	return ManifestName, InstallerName(version), InstallerName(version) + ".sig"
}

// findAsset 按名字取一件附件。
func findAsset(r Release, name string) (Asset, bool) {
	for _, a := range r.Assets {
		if a.Name == name {
			return a, true
		}
	}
	return Asset{}, false
}

// Pick 是一份「清单上看能试」的发行。
type Pick struct {
	Version string
	Release Release
}

// candidates 挑出可以看一眼描述的发行：更高正式版本、非草稿非预发布、三件资产齐全。
//
// 只按清单筛一遍，描述内容还要 validateDescriptor 才能定。排序是版本从高到低，
// 调用方按序取第一份通过描述的，就是最高的完整可用版本。
func candidates(releases []Release, current string) []Pick {
	var out []Pick
	for _, r := range releases {
		if r.Draft || r.Prerelease {
			continue
		}
		version, ok := formalTag(r.Tag)
		if !ok || compareVersions(version, current) <= 0 {
			continue
		}
		_, pkg, sig := assetNames(version)
		if _, ok := findAsset(r, ManifestName); !ok {
			continue
		}
		if _, ok := findAsset(r, pkg); !ok {
			continue
		}
		if _, ok := findAsset(r, sig); !ok {
			continue
		}
		out = append(out, Pick{Version: version, Release: r})
	}
	sort.SliceStable(out, func(i, j int) bool {
		return compareVersions(out[i].Version, out[j].Version) > 0
	})
	return out
}

// validateDescriptor 核对描述与这份发行对得上：版本、平台、包地址、签名与说明。
//
// 描述对不上的版本算「资产不完整」，不是错误也不是可装的更新：选版跳过它，
// 而不是把半套资产当成新版提示给用户。
func validateDescriptor(m Manifest, version string, release Release) error {
	if m.Version != version {
		return fmt.Errorf("描述版本 %q 与发行版本 %q 不一致", m.Version, version)
	}
	if m.Platform != "windows-amd64" {
		return fmt.Errorf("描述平台 %q 不是 windows-amd64", m.Platform)
	}
	if strings.TrimSpace(m.Signature) == "" {
		return errors.New("描述缺少发布者签名：哈希不能替代签名")
	}
	pkg, _ := findAsset(release, InstallerName(version))
	if m.URL != pkg.URL {
		return fmt.Errorf("描述里的包地址 %q 不是这份发行的安装器", m.URL)
	}
	if want := "/v" + version + "/"; !strings.Contains(m.URL, want) {
		return fmt.Errorf("包地址必须指向 v%s 的发行附件", version)
	}
	if !hasHeading(m.Notes, "# "+version) {
		return fmt.Errorf("更新描述缺少当前版本 %q 的一级标题", version)
	}
	return nil
}

// hasHeading 判断文本里有没有这一行一级标题。
func hasHeading(notes, heading string) bool {
	for _, line := range strings.Split(notes, "\n") {
		if strings.TrimRight(line, " \t") == heading {
			return true
		}
	}
	return false
}
