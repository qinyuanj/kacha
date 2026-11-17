package updateservice

import (
	"crypto/sha256"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// 隔离测试发行验收（#165）：资产由 `go tool mygo keygen` 生成的测试密钥经 tools/signrelease 签出。
// 这里走客户端真实的选版、下载、验签与安装入口，核对三件事：
//  1. 只选当前版本之上的 1.6.0，描述、安装器与签名三件齐全才可能成为候选；
//  2. 下载完成不等于可安装：只有发布者签名在本机验过才进 ready，安装只经用户触发的 Install；
//  3. 包或签名被篡改时拒绝安装，旧版本照常可用。
//
// 正常 go test 会跳过：资产是验收时在临时目录组装的，不进仓库、也不发布。
// 验收运行需要三个环境变量：
//
//	KACHA_ACCEPTANCE_RELEASE_DIR  含 <版本>/{安装器,.sig,update-windows-amd64.json,SHA256SUMS} 的目录
//	KACHA_ACCEPTANCE_PUBKEY       测试密钥对的 base64 公钥（mygo-update.pub 的内容）
//	KACHA_ACCEPTANCE_BASE_URL     签名时用的同一个 Gitea 地址，如 http://127.0.0.1:38991
//
// 这条跑通只证明隔离测试发行的元数据与客户端信任链一致，不等于正式发布或真机安装升级。
func TestIsolatedReleaseAcceptance(t *testing.T) {
	dir := strings.TrimSpace(os.Getenv("KACHA_ACCEPTANCE_RELEASE_DIR"))
	keyText := strings.TrimSpace(os.Getenv("KACHA_ACCEPTANCE_PUBKEY"))
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("KACHA_ACCEPTANCE_BASE_URL")), "/")
	if dir == "" || keyText == "" || base == "" {
		t.Skip("没有设置 KACHA_ACCEPTANCE_*：跳过隔离测试发行验收（正常测试不依赖发布资产）")
	}
	if !strings.HasPrefix(base, "http://") {
		t.Fatalf("KACHA_ACCEPTANCE_BASE_URL 必须是 http:// 地址，当前是 %q", base)
	}

	versions := []string{"1.5.0", "1.6.0"}
	pkgs := map[string][]byte{}
	sigs := map[string][]byte{}
	descs := map[string][]byte{}
	for _, v := range versions {
		pkgs[v], sigs[v], descs[v] = readIsolatedAssets(t, dir, v)
	}

	// tamper 让同一份服务器的字节在轮次之间变化，模拟下载到的包或签名被换掉。
	var tamper atomic.Int32 // 0 正常，1 包被改，2 签名被改
	assetURL := func(version, name string) string { return base + "/assets/" + version + "/" + name }
	downloadURL := func(version string) string {
		return base + "/qinyuanj/kacha/releases/download/v" + version + "/" + InstallerName(version)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/"+OwnerRepo+"/releases", func(w http.ResponseWriter, _ *http.Request) {
		var releases []Release
		for _, v := range versions {
			releases = append(releases, Release{Tag: "v" + v, Assets: []Asset{
				{Name: ManifestName, URL: assetURL(v, ManifestName)},
				{Name: InstallerName(v), URL: downloadURL(v)},
				{Name: InstallerName(v) + ".sig", URL: assetURL(v, InstallerName(v)+".sig")},
			}})
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(releases); err != nil {
			t.Errorf("列出发行: %v", err)
		}
	})
	mux.HandleFunc("/assets/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/assets/"), "/")
		if len(parts) != 2 {
			http.NotFound(w, r)
			return
		}
		version, name := parts[0], parts[1]
		switch {
		case name == ManifestName:
			_, _ = w.Write(descs[version])
		case name == InstallerName(version)+".sig":
			body := sigs[version]
			if tamper.Load() == 2 {
				body = append([]byte(nil), body...)
				body[0] ^= 0x01
			}
			_, _ = w.Write(body)
		default:
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("/qinyuanj/kacha/releases/download/", func(w http.ResponseWriter, r *http.Request) {
		rest, ok := strings.CutPrefix(r.URL.Path, "/qinyuanj/kacha/releases/download/v")
		if !ok {
			http.NotFound(w, r)
			return
		}
		version, name, ok := strings.Cut(rest, "/")
		if !ok || name != InstallerName(version) || pkgs[version] == nil {
			http.NotFound(w, r)
			return
		}
		body := pkgs[version]
		if tamper.Load() == 1 {
			body = append([]byte(nil), body...)
			body[len(body)-1] ^= 0x01
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(body)
	})

	// 描述里的包地址就是签名时写入的地址，所以服务器必须监听同一个 host:port。
	addr := strings.TrimPrefix(base, "http://")
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("监听 %s 失败（端口被占用时换一个 KACHA_ACCEPTANCE_BASE_URL 重新签名）: %v", addr, err)
	}
	server := httptest.NewUnstartedServer(mux)
	_ = server.Listener.Close()
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)

	rec := &recorder{}
	svc := New(Options{
		Current:   "1.5.0",
		Root:      t.TempDir(),
		BaseURL:   base,
		PublicKey: keyText,
		Client:    server.Client(),
		Launch:    rec.launch,
		Quit:      rec.quit,
	})
	if !svc.Enabled() {
		t.Fatalf("注入测试公钥后服务仍不可用：%+v", svc.Status())
	}
	if got := PublisherKey(); got == "" {
		t.Log("本次构建没有内置发布者公钥：正式发布前必须在发布环境写入（这次验签用的是注入的测试公钥）")
	} else {
		t.Log("本次构建内置了发布者公钥")
	}
	if err := svc.Install(); err == nil {
		t.Fatalf("还没检查、没验签就允许安装")
	}

	// 1) 选版 + 下载 + 验签：只选更高的 1.6.0，验签通过才可装。
	svc.Check()
	snap := waitPhase(t, svc, PhaseReady)
	if snap.Phase != PhaseReady {
		t.Fatalf("phase = %q (error %q), want ready", snap.Phase, snap.Error)
	}
	if snap.Version != "1.6.0" {
		t.Fatalf("选中的版本 = %q, want 1.6.0（1.5.0 与当前同版本，不是更新）", snap.Version)
	}
	if !snap.Verified || !snap.Installable {
		t.Fatalf("verified = %v, installable = %v, want both true", snap.Verified, snap.Installable)
	}
	if want := int64(len(pkgs["1.6.0"])); snap.Downloaded != want || snap.Total != want {
		t.Fatalf("下载进度 = %d/%d, want %d/%d（描述里的字节数必须与真实安装器一致）",
			snap.Downloaded, snap.Total, want, want)
	}
	t.Logf("选版通过：%s → 1.6.0，下载 %d 字节且验签通过", snap.Current, snap.Downloaded)

	// 2) 包被换掉：下载“完成”也不能进可安装状态，安装入口拒绝。
	tamper.Store(1)
	svc.Check()
	snap = waitPhase(t, svc, PhaseError)
	if snap.Verified || snap.Installable {
		t.Fatalf("篡改包仍被标为可安装：%+v", snap)
	}
	if !strings.Contains(snap.Error, "验签失败") {
		t.Fatalf("篡改包的错误不明确：%q", snap.Error)
	}
	if err := svc.Install(); err == nil {
		t.Fatalf("篡改包可以安装")
	}
	if len(rec.launched) != 0 {
		t.Fatalf("篡改包启动了安装器：%v", rec.launched)
	}
	t.Logf("拒绝篡改包：%s", snap.Error)

	// 3) 签名被换掉（描述里的签名与 .sig 不一致）：拒装，不把半套资产当更新。
	tamper.Store(2)
	svc.Check()
	snap = waitPhase(t, svc, PhaseError)
	if snap.Installable || !strings.Contains(snap.Error, "签名不可用") {
		t.Fatalf("篡改签名没有被明确拒绝：%+v", snap)
	}
	t.Logf("拒绝篡改签名：%s", snap.Error)

	// 4) 恢复正确资产：仍能重新检查到 ready，安装交给注入的启动器（不真起进程）。
	tamper.Store(0)
	svc.Check()
	snap = waitPhase(t, svc, PhaseReady)
	if snap.Phase != PhaseReady {
		t.Fatalf("恢复正确资产后 phase = %q (error %q), want ready", snap.Phase, snap.Error)
	}
	if err := svc.Install(); err != nil {
		t.Fatalf("验签通过后安装失败：%v", err)
	}
	if len(rec.launched) != 1 || filepath.Base(rec.launched[0]) != InstallerName("1.6.0") {
		t.Fatalf("交给安装器的不是这份更新：%v", rec.launched)
	}
	if args := rec.args[0]; len(args) != 1 || args[0] != "/S" {
		t.Fatalf("安装器参数 = %v, want [/S]", rec.args)
	}
	if rec.quits != 1 {
		t.Fatalf("启动安装器后退出次数 = %d, want 1（退出后由安装器替换正在运行的可执行文件）", rec.quits)
	}
	downloaded, err := os.ReadFile(rec.launched[0])
	if err != nil {
		t.Fatalf("读取下载的安装器: %v", err)
	}
	got, want := sha256.Sum256(downloaded), sha256.Sum256(pkgs["1.6.0"])
	if got != want {
		t.Fatalf("下载的安装器字节与发布资产不一致：%x != %x", got, want)
	}
	t.Logf("可安装状态通过：安装器 %s，参数 /S，SHA-256 %x", filepath.Base(rec.launched[0]), got)
}

// readIsolatedAssets 读一份隔离测试发行的安装器、签名与更新描述。
func readIsolatedAssets(t *testing.T, root, version string) (pkg, sig, desc []byte) {
	t.Helper()
	read := func(name string) []byte {
		body, err := os.ReadFile(filepath.Join(root, version, name))
		if err != nil {
			t.Fatalf("读取隔离测试发行资产 %s/%s: %v", version, name, err)
		}
		return body
	}
	return read(InstallerName(version)), read(InstallerName(version) + ".sig"), read(ManifestName)
}
