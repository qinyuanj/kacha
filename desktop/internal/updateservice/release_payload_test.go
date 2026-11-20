package updateservice

import (
	"encoding/json"
	"testing"
)

// giteaReleaseListPayload 是 2026-11-19 从真实 Gitea 28.3 抓下来的报文形状。
//
// 它故意保持原样：附件只有 browser_download_url，没有 url。夹具如果由 Go 结构体
// 自己序列化出来，就会跟着结构体一起错（这正是 1.6.0 更新入口失效却全绿的原因），
// 所以这里放死报文，作为「真实服务长什么样」的唯一凭据。
const giteaReleaseListPayload = `[
  {
    "id": 42,
    "tag_name": "v1.6.1",
    "draft": false,
    "prerelease": false,
    "html_url": "http://lzxsvn:3000/qinyuanj/kacha-cd/releases/tag/v1.6.1",
    "assets": [
      {
        "id": 1,
        "name": "SHA256SUMS",
        "browser_download_url": "http://lzxsvn:3000/qinyuanj/kacha-cd/releases/download/v1.6.1/SHA256SUMS"
      },
      {
        "id": 2,
        "name": "kacha-setup-1.6.1-amd64.exe",
        "browser_download_url": "http://lzxsvn:3000/qinyuanj/kacha-cd/releases/download/v1.6.1/kacha-setup-1.6.1-amd64.exe"
      },
      {
        "id": 3,
        "name": "kacha-setup-1.6.1-amd64.exe.sig",
        "browser_download_url": "http://lzxsvn:3000/qinyuanj/kacha-cd/releases/download/v1.6.1/kacha-setup-1.6.1-amd64.exe.sig"
      },
      {
        "id": 4,
        "name": "update-windows-amd64.json",
        "browser_download_url": "http://lzxsvn:3000/qinyuanj/kacha-cd/releases/download/v1.6.1/update-windows-amd64.json"
      }
    ]
  }
]`

const downloadBase = "http://lzxsvn:3000/qinyuanj/kacha-cd/releases/download/v1.6.1/"

// TestAssetURLComesFromBrowserDownloadURL 锁住真实报文契约：附件的下载地址来自
// browser_download_url。退回 json:"url" 时这条会红，因为真实报文里没有那个字段。
func TestAssetURLComesFromBrowserDownloadURL(t *testing.T) {
	var releases []Release
	if err := json.Unmarshal([]byte(giteaReleaseListPayload), &releases); err != nil {
		t.Fatalf("解不开真实报文：%v", err)
	}
	if len(releases) != 1 {
		t.Fatalf("发行条数 = %d，要 1", len(releases))
	}
	for _, asset := range releases[0].Assets {
		if asset.URL == "" {
			t.Fatalf("附件 %q 的地址是空的：说明解的不是 browser_download_url", asset.Name)
		}
		if want := downloadBase + asset.Name; asset.URL != want {
			t.Fatalf("附件 %q 的地址 = %q，要 %q", asset.Name, asset.URL, want)
		}
	}
}

// TestCandidatesAcceptRealPayload 用真实报文走一遍选版：能选出候选，且候选里
// 的包地址是浏览器下载地址（不是空串、也不是 API 地址）。
func TestCandidatesAcceptRealPayload(t *testing.T) {
	var releases []Release
	if err := json.Unmarshal([]byte(giteaReleaseListPayload), &releases); err != nil {
		t.Fatalf("解不开真实报文：%v", err)
	}
	picks := candidates(releases, "1.6.0")
	if len(picks) != 1 || picks[0].Version != "1.6.1" {
		t.Fatalf("选版 = %+v，要一个 1.6.1", picks)
	}
	pkg, ok := findAsset(picks[0].Release, InstallerName("1.6.1"))
	if !ok {
		t.Fatal("找不到安装器附件")
	}
	if want := downloadBase + "kacha-setup-1.6.1-amd64.exe"; pkg.URL != want {
		t.Fatalf("安装器地址 = %q，要 %q", pkg.URL, want)
	}
	sigName := InstallerName("1.6.1") + ".sig"
	sig, ok := findAsset(picks[0].Release, sigName)
	if !ok {
		t.Fatal("找不到签名附件")
	}
	if sig.URL == "" {
		t.Fatal("签名附件地址是空的")
	}
}
