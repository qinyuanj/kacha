// 弹窗标题语义契约（#243）：标题栏里应是语义标题元素，不是靠样式冒充标题的 <strong>。
// 读组件源码判定：渲染各弹窗要备一堆端口/道具，而这里守的是「标题栏用什么元素」这一条标记契约。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogs = [
  "BoardPackDialog.tsx",
  "ChangelogDialog.tsx",
  "RunConfirmDialog.tsx",
  "SendTextDialog.tsx",
  "FeedbackDialog.tsx",
  "BoardListDialog.tsx",
  "SettingsPanel.tsx",
  "UsageSection.tsx",
  "previewViews.tsx",
] as const;

/** 取每个 modal-head 容器里的 JSX 片段（到匹配的 </div> 为止）。 */
function headBlocks(source: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  while (true) {
    const start = source.indexOf('modal-head', from);
    if (start < 0) break;
    const open = source.indexOf(">", start) + 1;
    const end = source.indexOf("</div>", open);
    blocks.push(source.slice(open, end < 0 ? source.length : end));
    from = end < 0 ? source.length : end + 6;
  }
  return blocks;
}

describe("弹窗标题栏的语义元素（#243）", () => {
  for (const name of dialogs) {
    it(`${name} 的标题栏用语义标题，不用 <strong>`, () => {
      const source = readFileSync(new URL(`../ui/${name}`, import.meta.url), "utf8");
      const blocks = headBlocks(source);
      expect(blocks.length, `${name} 没有 modal-head`).toBeGreaterThanOrEqual(1);
      for (const block of blocks) {
        expect(block, `${name} 标题栏还有 <strong>`).not.toMatch(/<strong\b/);
        expect(block, `${name} 标题栏没有 <h2>`).toMatch(/<h2\b/);
      }
    });
  }
});
