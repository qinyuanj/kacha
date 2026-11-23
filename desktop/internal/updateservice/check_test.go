package updateservice

import (
	"testing"
)

// 选版只认更高正式版本，且描述、包与签名三件齐全。
func TestCheckSelectsOnlyHigherFormalReleaseWithCompleteAssets(t *testing.T) {
	pub := newPublisher(t)
	f := buildFixture(t, pub,
		// latest 指向 Web 发行（无桌面资产）时，不能遮蔽后面的桌面发行。
		releaseSpec{Version: "1.9.0", Omit: []string{ManifestName, InstallerName("1.9.0"), InstallerName("1.9.0") + ".sig"}},
		// 与当前同版本：不算更新。
		releaseSpec{Version: "1.5.0"},
		// 预发布：不进正式通道。
		releaseSpec{Version: "1.9.0", Tag: "v1.9.0-beta.1", Prerelease: true},
		// 草稿：不发布。
		releaseSpec{Version: "1.8.0", Draft: true},
		// 缺签名附件：半套资产。
		releaseSpec{Version: "1.7.0", Omit: []string{InstallerName("1.7.0") + ".sig"}},
		// 描述缺一级标题：说明不完整。
		releaseSpec{Version: "1.6.5", Notes: "修复若干问题"},
		// 描述平台不对：不是本平台的包。
		releaseSpec{Version: "1.6.4", Platform: "darwin-arm64"},
		// 说明里的版本标题必须精确：更长的标题、丢掉 #、空说明都不算完整。
		releaseSpec{Version: "1.6.2", Notes: "# 1.6.2-beta"},
		releaseSpec{Version: "1.6.1", Notes: "1.6.1\n"},
		releaseSpec{Version: "1.6.6", Notes: "\n"},
		// 这个才是该选的。
		releaseSpec{Version: "1.6.0"},
	)
	svc, _ := newService(t, f, pub, "1.5.0")
	svc.Check()
	snap := waitPhase(t, svc, PhaseReady)
	if snap.Phase != PhaseReady {
		t.Fatalf("phase = %q (error %q), want ready", snap.Phase, snap.Error)
	}
	if snap.Version != "1.6.0" {
		t.Fatalf("version = %q, want 1.6.0", snap.Version)
	}
	if !snap.Verified || !snap.Installable {
		t.Fatalf("verified = %v, installable = %v, want both true", snap.Verified, snap.Installable)
	}
}

// 没有更高的完整正式版本时是「已是最新」，不是错误。
func TestCheckReportsUpToDateWithoutCandidate(t *testing.T) {
	pub := newPublisher(t)
	f := buildFixture(t, pub, releaseSpec{Version: "1.5.0"})
	svc, _ := newService(t, f, pub, "1.5.0")
	svc.Check()
	snap := waitPhase(t, svc, PhaseUpToDate)
	if snap.Phase != PhaseUpToDate {
		t.Fatalf("phase = %q (error %q), want up_to_date", snap.Phase, snap.Error)
	}
	if snap.Installable || snap.Verified {
		t.Fatalf("up to date must not be installable")
	}
}

// 篡改签名：包完整、长度也对，但不是发布者签的，不能进入可安装状态。
func TestTamperedSignatureIsNotInstallable(t *testing.T) {
	pub := newPublisher(t)
	other := newPublisher(t)
	pkg := []byte("installer-1.6.0")
	forged := other.sign(pkg)
	f := buildFixture(t, pub, releaseSpec{Version: "1.6.0", Package: pkg, Signature: forged})
	svc, rec := newService(t, f, pub, "1.5.0")
	svc.Check()
	snap := waitPhase(t, svc, PhaseError)
	if snap.Phase != PhaseError {
		t.Fatalf("phase = %q, want error", snap.Phase)
	}
	if snap.Verified || snap.Installable {
		t.Fatalf("a forged signature must not be installable")
	}
	if err := svc.Install(); err == nil {
		t.Fatalf("Install must refuse an unverified package")
	}
	if len(rec.launched) != 0 {
		t.Fatalf("installer launched %d times, want 0", len(rec.launched))
	}
}

// 损坏包：描述说的大小对不上（内容被改），验签必须失败。
func TestCorruptPackageIsNotInstallable(t *testing.T) {
	pub := newPublisher(t)
	pkg := []byte("installer-1.6.0")
	sig := pub.sign(pkg)
	// 签名对应原包，实际发布的是被改过的字节。
	f := buildFixture(t, pub, releaseSpec{Version: "1.6.0", Package: []byte("installer-1.6.0-corrupted"), Signature: sig})
	svc, rec := newService(t, f, pub, "1.5.0")
	svc.Check()
	snap := waitPhase(t, svc, PhaseError)
	if snap.Verified || snap.Installable {
		t.Fatalf("a corrupted package must not be installable (phase %q)", snap.Phase)
	}
	if err := svc.Install(); err == nil {
		t.Fatalf("Install must refuse a corrupted package")
	}
	if len(rec.launched) != 0 {
		t.Fatalf("installer launched %d times, want 0", len(rec.launched))
	}
}

// 描述里的签名与 .sig 附件不一致：资产是半套，不能装。
func TestMismatchedDescriptorSignatureIsNotInstallable(t *testing.T) {
	pub := newPublisher(t)
	pkg := []byte("installer-1.6.0")
	sig := pub.sign(pkg)
	f := buildFixture(t, pub, releaseSpec{Version: "1.6.0", Package: pkg, Signature: sig, DescriptorSignature: "not-the-same-signature"})
	svc, _ := newService(t, f, pub, "1.5.0")
	svc.Check()
	snap := waitPhase(t, svc, PhaseError)
	if snap.Installable || snap.Verified {
		t.Fatalf("mismatched signatures must not be installable")
	}
}

// 离线：检查失败，旧版本照常可用，不安装也不崩。
func TestOfflineCheckFailsWithoutInstalling(t *testing.T) {
	pub := newPublisher(t)
	f := buildFixture(t, pub, releaseSpec{Version: "1.6.0"})
	svc, rec := newService(t, f, pub, "1.5.0")
	// 服务器先关掉：网络不可达。
	f.server.Close()
	svc.Check()
	snap := waitPhase(t, svc, PhaseError)
	if snap.Phase != PhaseError {
		t.Fatalf("phase = %q, want error", snap.Phase)
	}
	if snap.Error == "" {
		t.Fatalf("offline failure must carry a reason")
	}
	if snap.Installable {
		t.Fatalf("offline must not be installable")
	}
	if len(rec.launched) != 0 {
		t.Fatalf("offline must not launch the installer")
	}
}
