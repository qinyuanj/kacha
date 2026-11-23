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

// TestRealGiteaPayloadMapping 锁住真实报文契约：tag_name、browser_download_url
// 与选版规则一起决定能不能找到可安装的桌面发行。退回 json:"url" 或误用 API 地址时，
// 这条会因为附件地址不匹配而红。
func TestRealGiteaPayloadMapping(t *testing.T) {
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
	picks := candidates(releases, "1.6.0")
	if len(picks) != 1 || picks[0].Version != "1.6.1" {
		t.Fatalf("选版 = %+v，要一个 1.6.1", picks)
	}
	name := InstallerName("1.6.1")
	pkg, ok := findAsset(picks[0].Release, name)
	if !ok {
		t.Fatal("找不到安装器附件")
	}
	if want := downloadBase + "kacha-setup-1.6.1-amd64.exe"; pkg.URL != want {
		t.Fatalf("安装器地址 = %q，要 %q", pkg.URL, want)
	}
	sig, ok := findAsset(picks[0].Release, name+".sig")
	if !ok {
		t.Fatal("找不到签名附件")
	}
	if want := downloadBase + "kacha-setup-1.6.1-amd64.exe.sig"; sig.URL != want {
		t.Fatalf("签名附件地址 = %q，要 %q", sig.URL, want)
	}
}
