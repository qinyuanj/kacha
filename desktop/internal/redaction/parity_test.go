package redaction_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/redaction"
)

// 与前端 client/src/ui/FeedbackDialog.tsx 的 redactFeedbackText 共用同一批样本（#227 复审判断题 6）。
// 两端各写一套实现（Go 用 [REDACTED]，前端用 <已隐藏>/<本地路径>），替换标记不同，
// 所以这里比的是「哪些内容必须消失、哪些必须留下」，不是逐字节相等。
type redactionSample struct {
	Name   string   `json:"name"`
	Text   string   `json:"text"`
	Hidden []string `json:"hidden"`
	Kept   []string `json:"kept"`
}

func loadRedactionSamples(t *testing.T) []redactionSample {
	t.Helper()
	path := filepath.Join("..", "..", "..", "contracts", "redaction-samples.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读夹具失败: %v", err)
	}
	var fixture struct {
		Samples []redactionSample `json:"samples"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("解析夹具失败: %v", err)
	}
	if len(fixture.Samples) == 0 {
		t.Fatalf("夹具是空的：%s", path)
	}
	return fixture.Samples
}

// 同一批样本：该消失的必须消失，该留下的必须留下。
func TestRedactionMatchesClientFixture(t *testing.T) {
	for _, sample := range loadRedactionSamples(t) {
		t.Run(sample.Name, func(t *testing.T) {
			got := redaction.Redact(sample.Text)
			for _, secret := range sample.Hidden {
				if strings.Contains(got, secret) {
					t.Fatalf("脱敏后仍含 %q：%q", secret, got)
				}
			}
			for _, kept := range sample.Kept {
				if !strings.Contains(got, kept) {
					t.Fatalf("脱敏吞掉了非秘密文本 %q：%q", kept, got)
				}
			}
		})
	}
}

// 没有秘密的对照样本必须原样返回：这条防的是「为了更安全把普通文本也吞掉」。
func TestRedactionLeavesCleanSamplesAlone(t *testing.T) {
	clean := 0
	for _, sample := range loadRedactionSamples(t) {
		if len(sample.Hidden) != 0 {
			continue
		}
		clean++
		if got := redaction.Redact(sample.Text); got != sample.Text {
			t.Fatalf("%s：干净文本被改写 %q → %q", sample.Name, sample.Text, got)
		}
	}
	if clean == 0 {
		t.Fatal("夹具里没有「没有秘密」的对照样本，这条用例就恒真了")
	}
}
