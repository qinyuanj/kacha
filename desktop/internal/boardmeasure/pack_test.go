package boardmeasure_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/boardmeasure"
	"github.com/qinyuanj/kacha/desktop/internal/localstore"
	"github.com/qinyuanj/kacha/desktop/internal/packimport"
)

// 用已有画板包验收（#158）：把真实夹具包导入临时数据根，量导入后的画板——
// 画板体量 = 它引用的各任务目录字节之和，与画板列表报的体量一致。
// 不依赖真实网关生成：包里的任务目录与图片就是现成的真实文件。
func TestMeasureImportedPackBoard(t *testing.T) {
	for _, fixture := range []string{"client/fixtures/packs/v2-duplicates.ugcpack", "client/fixtures/packs/v0.3.2-flash-layers.ugcpack"} {
		t.Run(filepath.Base(fixture), func(t *testing.T) {
			root := t.TempDir()
			pack := filepath.Join("..", "..", "..", filepath.FromSlash(fixture))
			report, err := packimport.New(root).Import(pack)
			if err != nil {
				t.Fatalf("导入画板包：%v", err)
			}
			if len(report.Boards) == 0 {
				t.Fatalf("导入结局里没有画板：%+v", report)
			}
			for _, rel := range report.Boards {
				data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
				if err != nil {
					t.Fatalf("读导入的画板 %s：%v", rel, err)
				}
				m, ok := boardmeasure.MeasureBoard(root, string(data))
				if !ok {
					t.Fatalf("导入的画板读不懂：%s", rel)
				}
				if len(m.Dirs) == 0 {
					t.Fatalf("导入的画板没有引用任何条目：%s", rel)
				}
				// 每个引用的条目都量出正字节：包里的任务目录与图片都真实落盘了。
				for item, size := range m.Dirs {
					if size <= 0 {
						t.Fatalf("条目 %s 量出 %d 字节", item, size)
					}
				}
			}
		})
	}
}

// 画板列表报的体量与整理模式量出来的一致：两处同一个口径，界面才不会出现两个数字。
func TestListBodySizeMatchesMeasure(t *testing.T) {
	root := t.TempDir()
	pack := filepath.Join("..", "..", "..", "client", "fixtures", "packs", "v2-duplicates.ugcpack")
	report, err := packimport.New(root).Import(pack)
	if err != nil {
		t.Fatalf("导入画板包：%v", err)
	}
	listing, err := localstore.New(root).List()
	if err != nil {
		t.Fatalf("List：%v", err)
	}
	byPath := map[string]*int64{}
	for _, board := range listing.Boards {
		byPath[board.Path] = board.Bytes
	}
	for _, rel := range report.Boards {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatalf("读导入的画板 %s：%v", rel, err)
		}
		m, ok := boardmeasure.MeasureBoard(root, string(data))
		if !ok {
			t.Fatalf("导入的画板读不懂：%s", rel)
		}
		want := m.Total()
		got := byPath[rel]
		if got == nil || *got != want {
			t.Fatalf("画板列表体量 %s = %v, want %d（与整理模式同一口径）", rel, got, want)
		}
	}
}
