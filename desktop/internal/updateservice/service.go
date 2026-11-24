package updateservice

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 发布侧常量：Gitea 在内网/VPN 上，地址可被环境变量覆盖（打包与测试都从这里取）。
const (
	// DefaultBaseURL 是团队 Gitea 的地址（可信内网或 VPN）。
	DefaultBaseURL = "http://lzxsvn:3000"
	// OwnerRepo 是发行所在的仓库。
	OwnerRepo = "qinyuanj/kacha-cd"
	// MaxPackageBytes 是安装器字节上限：描述说多大都不能超过它。
	MaxPackageBytes = 512 << 20
	// MaxDescriptorBytes 是更新描述字节上限。
	MaxDescriptorBytes = 1 << 20
	// relaunchFlag 是交给安装器的参数：静默装完之后启动新版本。
	// installer/installer.nsh 的 customInit 读同一个字面量，两端由
	// packaging/tests/test_installer_include.py 锁住。
	relaunchFlag = "--relaunch"
)

//go:embed publisher_key.txt
var publisherKeyFile string

// PublisherKey 返回这次构建内置的发布者公钥（base64）；空表示没有。
//
// 公钥来自编译时嵌入的 publisher_key.txt：发布环境在构建前写入真实公钥。
// 私钥只在发布环境，客户端只带公钥。文件为空或只有注释时视为「没有可信公钥」，
// 更新能力按「尚不可用」处理，而不是退化成「只校验哈希」。
func PublisherKey() string {
	for _, line := range strings.Split(publisherKeyFile, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		return line
	}
	return ""
}

// Options 是服务的依赖；测试替换掉网络与安装动作，不弹窗也不真装。
type Options struct {
	// Current 是当前运行版本。
	Current string
	// Root 是下载目录的父目录（数据根）。
	Root string
	// RootFunc 给了就每次现取数据根（数据位置迁移后 #161 跟着换），优先于 Root。
	RootFunc func() string
	// BaseURL 是 Gitea 地址；空则用 KACHA_GITEA_URL，再空用 DefaultBaseURL。
	BaseURL string
	// PublicKey 是发布者公钥（base64）；空则用内置的 publisherKey。
	PublicKey string
	// Client 是 HTTP 客户端；空则用带超时的默认客户端。
	Client *http.Client
	// Launch 启动安装器；空则真起进程。
	Launch func(path string, args []string) error
	// Quit 退出本应用；空则什么也不做（由装配层接 mygo.App.Quit）。
	Quit func()
}

// dataRoot 是下载目录的父目录：装了 RootFunc 就跟当前数据根走（迁移后不往旧位置写）。
func (s *Service) dataRoot() string {
	if s.rootFunc != nil {
		return s.rootFunc()
	}
	return s.root
}

// Service 是更新协调服务：查发行、选版、下载、验签、装。
type Service struct {
	current  string
	root     string
	rootFunc func() string
	base     string
	key      ed25519.PublicKey
	client   *http.Client
	launch   func(string, []string) error
	quit     func()

	mu         sync.Mutex
	snap       Snapshot
	cand       *Candidate
	pkgPath    string
	checking   bool
	generation int64
}

// New 造一个更新服务；没有可用公钥时服务仍在，但状态是 disabled。
func New(opts Options) *Service {
	base := strings.TrimRight(strings.TrimSpace(opts.BaseURL), "/")
	if base == "" {
		base = strings.TrimRight(strings.TrimSpace(os.Getenv("KACHA_GITEA_URL")), "/")
	}
	if base == "" {
		base = DefaultBaseURL
	}
	keyText := strings.TrimSpace(opts.PublicKey)
	if keyText == "" {
		keyText = PublisherKey()
	}
	client := opts.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Minute}
	}
	launch := opts.Launch
	if launch == nil {
		launch = launchInstaller
	}
	quit := opts.Quit
	if quit == nil {
		quit = func() {}
	}
	s := &Service{current: opts.Current, root: opts.Root, rootFunc: opts.RootFunc, base: base, client: client, launch: launch, quit: quit}
	s.snap = Snapshot{Phase: PhaseIdle, Current: opts.Current}
	if keyText == "" {
		// 没有内置公钥：这次构建不能验证发布者，更新保持明确不可用。
		s.snap.Phase = PhaseDisabled
		s.snap.Error = "这次构建没有内置发布者公钥，自动更新尚不可用"
		return s
	}
	key, err := ParsePublicKey(keyText)
	if err != nil {
		s.snap.Phase = PhaseDisabled
		s.snap.Error = "内置的发布者公钥不可用，自动更新尚不可用"
		return s
	}
	s.key = key
	return s
}

// Enabled 表示这次构建能验证发布者签名（有可用公钥）。
func (s *Service) Enabled() bool { return s.key != nil }

// Status 返回当前快照；页面轮询它。
func (s *Service) Status() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snap
}

// Check 启动一次检查（并发调用合并），立刻返回；进度与结局看 Status。
//
// 检查不安装、不重启，也不打断创作：失败只记在快照里，用户可手动重试。
func (s *Service) Check() {
	s.mu.Lock()
	if !s.Enabled() || s.checking || s.snap.Phase == PhaseInstalling {
		s.mu.Unlock()
		return
	}
	s.checking = true
	s.generation++
	gen := s.generation
	s.snap.Phase = PhaseChecking
	s.snap.Error = ""
	s.mu.Unlock()
	go s.runCheck(gen)
}

// runCheck 是一次检查的完整流程：列发行、选版、下载、验签。
func (s *Service) runCheck(gen int64) {
	defer func() {
		s.mu.Lock()
		if s.generation == gen {
			s.checking = false
			s.snap.CheckedAt = time.Now()
		}
		s.mu.Unlock()
	}()
	releases, err := s.fetchReleases()
	if err != nil {
		s.fail(gen, "检查更新失败："+err.Error())
		return
	}
	cand, err := s.selectCandidate(releases)
	if errors.Is(err, ErrNoUpdate) {
		s.markUpToDate(gen)
		return
	}
	if err != nil {
		s.fail(gen, "检查更新失败："+err.Error())
		return
	}
	s.mu.Lock()
	if s.generation != gen {
		s.mu.Unlock()
		return
	}
	s.cand = cand
	s.snap.Phase = PhaseAvailable
	s.snap.Version = cand.Version
	s.snap.Notes = cand.Notes
	s.snap.PageURL = ReleaseURL(s.base, OwnerRepo, cand.Version)
	s.snap.Verified = false
	s.snap.Installable = false
	s.snap.Downloaded = 0
	s.snap.Total = cand.Size
	s.mu.Unlock()
	s.download(gen, cand)
}

// markUpToDate 记「已是最新」：清掉上一次的版本与进度，避免旧提示留在界面上。
func (s *Service) markUpToDate(gen int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation != gen {
		return
	}
	s.cand = nil
	s.snap.Phase = PhaseUpToDate
	s.snap.Version = ""
	s.snap.Notes = ""
	s.snap.PageURL = ""
	s.snap.Verified = false
	s.snap.Installable = false
	s.snap.Downloaded = 0
	s.snap.Total = 0
}

// fail 把这一轮失败记进快照：旧版本照常可用，界面给重试与失败原因。
func (s *Service) fail(gen int64, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation != gen {
		return
	}
	s.snap.Phase = PhaseError
	s.snap.Error = message
	s.snap.Verified = false
	s.snap.Installable = false
}

// download 下载安装器到数据根的 更新/ 下，再在本机验签。
//
// 下载完成只到 downloading 的进度；只有验签通过才进 ready。
// 「下完了」与「能装了」是两件事。
func (s *Service) download(gen int64, cand *Candidate) {
	s.mu.Lock()
	if s.generation != gen {
		s.mu.Unlock()
		return
	}
	s.snap.Phase = PhaseDownloading
	dir := filepath.Join(s.dataRoot(), "更新")
	s.mu.Unlock()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		s.fail(gen, "下载更新失败：建下载目录失败："+err.Error())
		return
	}
	target := filepath.Join(dir, InstallerName(cand.Version))
	digest, err := s.fetchPackage(gen, cand.PackageURL, target)
	if err != nil {
		s.fail(gen, "下载更新失败："+err.Error())
		return
	}
	sig, err := s.fetchSignature(cand.SignatureURL)
	if err != nil {
		s.fail(gen, "下载更新签名失败："+err.Error())
		return
	}
	// 描述里的签名与 .sig 附件必须是同一个值：对不上说明资产是半套。
	if err := sameSignature(cand.Descriptor.Signature, sig); err != nil {
		s.fail(gen, "更新签名不可用："+err.Error())
		return
	}
	// 真正验签：用内置发布者公钥核对包摘要。哈希对得上不代表签名对得上。
	if err := Verify(s.key, digest, sig); err != nil {
		s.fail(gen, "更新包验签失败，已拒绝安装："+err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation != gen {
		return
	}
	s.pkgPath = target
	s.snap.Verified = true
	s.snap.Installable = true
	s.snap.Phase = PhaseReady
	s.snap.Downloaded = cand.Size
}

// fetchReleases 列出 Gitea 上的发行；只读公开清单，不带凭据。
func (s *Service) fetchReleases() ([]Release, error) {
	url := s.base + "/api/v1/repos/" + OwnerRepo + "/releases?limit=50"
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("列出发行返回 %d", resp.StatusCode)
	}
	var releases []Release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&releases); err != nil {
		return nil, err
	}
	return releases, nil
}

// selectCandidate 取最高的「描述、包与签名齐全且描述自洽」的正式版本。
//
// latest 指向 Web 发行时这里不受影响：它按每份发行自己的资产判断，不看 latest。
func (s *Service) selectCandidate(releases []Release) (*Candidate, error) {
	picks := candidates(releases, s.current)
	for _, pick := range picks {
		desc, err := s.fetchDescriptor(pick.Release)
		if err != nil {
			continue
		}
		if err := validateDescriptor(desc, pick.Version, pick.Release); err != nil {
			continue
		}
		pkg, _ := findAsset(pick.Release, InstallerName(pick.Version))
		_, _, sigName := assetNames(pick.Version)
		sigAsset, _ := findAsset(pick.Release, sigName)
		return &Candidate{
			Version:      pick.Version,
			Notes:        desc.Notes,
			PackageURL:   pkg.URL,
			SignatureURL: sigAsset.URL,
			Size:         desc.Size,
			Descriptor:   desc,
		}, nil
	}
	return nil, ErrNoUpdate
}

// fetchDescriptor 读这份发行里的更新描述。
func (s *Service) fetchDescriptor(r Release) (Manifest, error) {
	asset, ok := findAsset(r, ManifestName)
	if !ok {
		return Manifest{}, fmt.Errorf("发行缺少 %s", ManifestName)
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, asset.URL, nil)
	if err != nil {
		return Manifest{}, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return Manifest{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Manifest{}, fmt.Errorf("读取描述返回 %d", resp.StatusCode)
	}
	var m Manifest
	if err := json.NewDecoder(io.LimitReader(resp.Body, MaxDescriptorBytes)).Decode(&m); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

// fetchPackage 下载安装器并返回它的 SHA-256 摘要；字节数要与描述一致。
func (s *Service) fetchPackage(gen int64, url, target string) ([]byte, error) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载安装器返回 %d", resp.StatusCode)
	}
	// 先写 .part，验签通过后才认这个文件：半截包不会冒充已下载。
	tmp := target + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return nil, err
	}
	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(f, hasher), io.LimitReader(resp.Body, MaxPackageBytes+1))
	closeErr := f.Close()
	if copyErr != nil {
		os.Remove(tmp)
		return nil, copyErr
	}
	if closeErr != nil {
		os.Remove(tmp)
		return nil, closeErr
	}
	if written > MaxPackageBytes {
		os.Remove(tmp)
		return nil, errors.New("安装器超过字节上限")
	}
	if err := os.Rename(tmp, target); err != nil {
		os.Remove(tmp)
		return nil, err
	}
	s.mu.Lock()
	if s.generation == gen {
		s.snap.Downloaded = written
	}
	s.mu.Unlock()
	return hasher.Sum(nil), nil
}

// fetchSignature 读 .sig 附件（base64 的 Ed25519 签名）。
func (s *Service) fetchSignature(url string) (string, error) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载签名返回 %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// Install 把已验签的包交给真实安装器，然后退出本应用。
//
// 只有 ready 且已验签才动：这是「只有用户点击才安装」的服务侧一半；
// 另一半在页面侧的准备流程（任务与保存保护）。
func (s *Service) Install() error {
	s.mu.Lock()
	if s.snap.Phase != PhaseReady || !s.snap.Verified || !s.snap.Installable || s.pkgPath == "" {
		s.mu.Unlock()
		return errors.New("更新尚未验签通过，不能安装")
	}
	path := s.pkgPath
	s.snap.Phase = PhaseInstalling
	s.snap.Installable = false
	s.mu.Unlock()
	// /S 静默安装：安装器自己会退出正在运行的实例（NSIS CloseApp）。
	// relaunchFlag 让安装器装完启动新版本：/S 不显示完成页，安装器自带的
	// 「运行 Kacha」勾选框（MUI_FINISHPAGE_RUN）在静默安装里根本不出现。
	if err := s.launch(path, []string{"/S", relaunchFlag}); err != nil {
		s.mu.Lock()
		s.snap.Phase = PhaseReady
		s.snap.Installable = true
		s.snap.Error = "启动安装器失败：" + err.Error()
		s.mu.Unlock()
		return err
	}
	s.quit()
	return nil
}

// launchInstaller 真起安装器进程（不等待它结束：安装器要替换正在运行的 exe）。
func launchInstaller(path string, args []string) error {
	cmd := exec.Command(path, args...)
	cmd.Dir = filepath.Dir(path)
	return cmd.Start()
}
