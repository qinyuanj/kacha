package packimport

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 交换格式兼容由现役 Go 导入器验收，不再依赖已退役的浏览器 ZIP 读取链。
func TestImportExchangeFixtures(t *testing.T) {
	for _, fixture := range []string{
		"client/fixtures/packs/v0.3.2-flash-layers.ugcpack",
		"client/fixtures/packs/v2-duplicates.ugcpack",
		"contracts/smoke/board-pack/千问测试.ugcpack",
		"contracts/smoke/board-pack/豆包测试.ugcpack",
	} {
		t.Run(filepath.Base(fixture), func(t *testing.T) {
			pack := filepath.Join("..", "..", "..", filepath.FromSlash(fixture))
			zr, err := zip.OpenReader(pack)
			if err != nil {
				t.Fatal(err)
			}
			defer zr.Close()
			contents := map[string][]byte{}
			for _, entry := range zr.File {
				if entry.FileInfo().IsDir() {
					continue
				}
				r, err := entry.Open()
				if err != nil {
					t.Fatal(err)
				}
				data, err := io.ReadAll(r)
				closeErr := r.Close()
				if err != nil {
					t.Fatal(err)
				}
				if closeErr != nil {
					t.Fatal(closeErr)
				}
				contents[entry.Name] = data
			}
			var manifest struct {
				Boards     []string          `json:"boards"`
				Duplicates map[string]string `json:"duplicates"`
			}
			if err := json.Unmarshal(contents["manifest.json"], &manifest); err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			report, err := New(root).Import(pack)
			if err != nil {
				t.Fatalf("导入真实画板包：%v", err)
			}
			if len(report.Boards) == 0 || len(report.Boards) != len(manifest.Boards) || len(report.Conflicts) != 0 {
				t.Fatalf("导入结局不完整：%+v", report)
			}
			for _, board := range report.Boards {
				data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(board)))
				if err != nil || !json.Valid(data) {
					t.Fatalf("画板未有效落盘 %s：%v", board, err)
				}
			}
			for omitted, original := range manifest.Duplicates {
				data, exists := contents[original]
				if !exists {
					t.Fatalf("夹具缺少代表条目 %s", original)
				}
				contents[omitted] = data
			}
			for name, want := range contents {
				if name == "manifest.json" || strings.HasPrefix(name, "画板/") {
					continue
				}
				got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(name)))
				if err != nil || !bytes.Equal(got, want) {
					t.Fatalf("条目未逐字节保留 %s：%v", name, err)
				}
			}
		})
	}
}
