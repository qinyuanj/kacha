package boardmeasure_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qinyuanj/kacha/desktop/internal/boardmeasure"
	"github.com/qinyuanj/kacha/desktop/internal/packimport"
)

// 用已有画板包验收（#158）：把真实夹具包导入临时数据根，量导入后的画板——
// 画板体量 = 它引用的各任务目录字节之和，与画板列表报的体量是同一口径。
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
				text := string(data)
				total := boardmeasure.BoardBytes(root, &text, nil)
				if total == nil {
					t.Fatalf("导入的画板读不懂：%s", rel)
				}
				if *total <= 0 {
					t.Fatalf("导入的画板量出 %d 字节：引用没被认出来", *total)
				}
				// 认出来的每个条目都必须真实落在导入后的数据根里：体量来自包里的文件，
				// 不是把读不懂的引用当成 0 后凑出来的。
				refs, ok := boardmeasure.NodeRefs(text)
				if !ok {
					t.Fatalf("导入的画板读不懂：%s", rel)
				}
				items := 0
				for _, node := range refs {
					for _, item := range node.Items {
						items++
						if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(item))); err != nil {
							t.Fatalf("画板 %s 引用的条目 %s 没落在导入的数据根里：%v", rel, item, err)
						}
					}
				}
				if items == 0 {
					t.Fatalf("导入的画板没有引用任何条目：%s", rel)
				}
			}
		})
	}
}
