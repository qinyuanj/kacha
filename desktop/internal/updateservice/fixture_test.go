package updateservice

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// 测试用发布者密钥：每个测试自己生成，绝不复用发布环境的私钥。
type publisher struct {
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
}

func newPublisher(t *testing.T) publisher {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	return publisher{pub: pub, priv: priv}
}

func (p publisher) keyText() string { return base64.StdEncoding.EncodeToString(p.pub) }

// privText 是发布环境里 MYGO_UPDATER_PRIVATE_KEY 的值：只给测试里的签名工具用。
func (p publisher) privText() string { return base64.StdEncoding.EncodeToString(p.priv) }

// sign 用测试私钥对包摘要签名，格式与 MyGo 一致：base64(Ed25519(sha256(包)))。
func (p publisher) sign(pkg []byte) string {
	digest := sha256.Sum256(pkg)
	return base64.StdEncoding.EncodeToString(ed25519.Sign(p.priv, digest[:]))
}

// fixture 是一份可发布的发行：描述、安装器与签名三件资产 + 一个测试服务器。
type fixture struct {
	server   *httptest.Server
	base     string
	releases []Release
	mu       sync.Mutex
	requests []string
}

// releaseSpec 描述要造一份怎样的发行。
type releaseSpec struct {
	Version string
	// Package 是安装器字节；空则用默认内容。
	Package []byte
	// Signature 覆盖签名附件；空则用测试私钥正确签名。
	Signature string
	// DescriptorSignature 覆盖描述里的签名；空则与签名附件一致。
	DescriptorSignature string
	// Omit 是要缺掉的资产名。
	Omit       []string
	Draft      bool
	Prerelease bool
	// Platform 覆盖描述里的平台。
	Platform string
	// Notes 覆盖更新说明；空则用带一级标题的说明。
	Notes string
	// Tag 覆盖 tag 名；空则用 v<Version>。
	Tag string
	// URL 覆盖描述里的包地址；空则指向本发行里的安装器。
	URL string
}

func defaultNotes(version string) string {
	return "# " + version + "\n\n## 新增\n\n- 自动更新\n"
}

// buildFixture 造一份或多份发行，并把它们的资产挂到测试服务器上。
func buildFixture(t *testing.T, pub publisher, specs ...releaseSpec) *fixture {
	t.Helper()
	f := &fixture{}
	assets := map[string][]byte{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/"+OwnerRepo+"/releases", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.requests = append(f.requests, r.URL.String())
		releases := append([]Release(nil), f.releases...)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(releases); err != nil {
			t.Errorf("Encode: %v", err)
		}
	})
	mux.HandleFunc("/assets/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		body, ok := assets[r.URL.Path]
		f.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(body)
	})
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	f.base = f.server.URL
	for _, spec := range specs {
		version := spec.Version
		tag := spec.Tag
		if tag == "" {
			tag = "v" + version
		}
		pkg := spec.Package
		if pkg == nil {
			pkg = []byte("installer-" + version)
		}
		sig := spec.Signature
		if sig == "" {
			sig = pub.sign(pkg)
		}
		descSig := spec.DescriptorSignature
		if descSig == "" {
			descSig = sig
		}
		notes := spec.Notes
		if notes == "" {
			notes = defaultNotes(version)
		}
		platform := spec.Platform
		if platform == "" {
			platform = "windows-amd64"
		}
		pkgName := InstallerName(version)
		pkgURL := spec.URL
		if pkgURL == "" {
			pkgURL = f.base + "/assets/" + tag + "/" + pkgName
		}
		m := Manifest{Version: version, Platform: platform, URL: pkgURL, Size: int64(len(pkg)), Signature: descSig, Notes: notes}
		descBytes, err := json.Marshal(m)
		if err != nil {
			t.Fatalf("Marshal: %v", err)
		}
		omit := map[string]bool{}
		for _, name := range spec.Omit {
			omit[name] = true
		}
		var list []Asset
		for _, a := range []struct {
			name string
			body []byte
		}{
			{ManifestName, descBytes},
			{pkgName, pkg},
			{pkgName + ".sig", []byte(sig)},
		} {
			if omit[a.name] {
				continue
			}
			f.mu.Lock()
			assets["/assets/"+tag+"/"+a.name] = a.body
			f.mu.Unlock()
			list = append(list, Asset{Name: a.name, URL: f.base + "/assets/" + tag + "/" + a.name})
		}
		f.releases = append(f.releases, Release{Tag: tag, Draft: spec.Draft, Prerelease: spec.Prerelease, Assets: list})
	}
	return f
}

// newService 造一个指向测试服务器的服务；launch/quit 被替换掉，测试不真装。
type recorder struct {
	mu       sync.Mutex
	launched []string
	args     [][]string
	quits    int
}

func (r *recorder) launch(path string, args []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.launched = append(r.launched, path)
	r.args = append(r.args, args)
	return nil
}

func (r *recorder) quit() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.quits++
}

func newService(t *testing.T, f *fixture, pub publisher, current string) (*Service, *recorder) {
	t.Helper()
	rec := &recorder{}
	svc := New(Options{
		Current:   current,
		Root:      t.TempDir(),
		BaseURL:   f.base,
		PublicKey: pub.keyText(),
		Client:    f.server.Client(),
		Launch:    rec.launch,
		Quit:      rec.quit,
	})
	return svc, rec
}

// waitPhase 等快照到某个阶段；超时即失败（服务是后台 goroutine，测试要等它）。
func waitPhase(t *testing.T, svc *Service, want Phase) Snapshot {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		snap := svc.Status()
		if snap.Phase == want {
			return snap
		}
		time.Sleep(2 * time.Millisecond)
	}
	return svc.Status()
}
