import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChangelog, shouldShowUpdateNotice, visibleReleases } from "./changelog";

describe("更新说明解析 parseChangelog", () => {
  it("多版本按文档顺序（新在前）输出版本、组与条目", () => {
    const md = ["# 1.1.0", "", "## 新增", "", "- 份数", "", "## 修复", "- 中文标点", "", "# 1.0.0", "## 改进", "- 更快"].join("\n");
    expect(parseChangelog(md)).toEqual([
      {
        version: "1.1.0",
        groups: [
          { title: "新增", items: [{ text: "份数", notice: false }] },
          { title: "修复", items: [{ text: "中文标点", notice: false }] },
        ],
      },
      { version: "1.0.0", groups: [{ title: "改进", items: [{ text: "更快", notice: false }] }] },
    ]);
  });

  it("以「注意：」开头的条目标为注意，正文去掉前缀", () => {
    const md = "# 1.0.0\n## 新增\n- 注意：服务端不备份。\n- 普通条目";
    expect(parseChangelog(md)[0].groups[0].items).toEqual([
      { text: "服务端不备份。", notice: true },
      { text: "普通条目", notice: false },
    ]);
  });

  it("忽略多行 HTML 注释（含注释里的 # 与列表）", () => {
    const md = ["<!--", "# 写作约定", "- 一条一句", "-->", "", "# 1.0.0", "## 修复", "- 修好了"].join("\n");
    expect(parseChangelog(md)).toEqual([
      { version: "1.0.0", groups: [{ title: "修复", items: [{ text: "修好了", notice: false }] }] },
    ]);
  });

  it("空文档或只有注释时为空数组", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("<!--\n约定\n-->\n\n")).toEqual([]);
  });

  it("一级标题不是版本号时报格式错误", () => {
    expect(() => parseChangelog("# 更新说明\n## 新增\n- 一条")).toThrow(/第 1 行/);
  });

  it.each([
    ["组名不在新增/改进/修复内", "# 1.0.0\n## 其他\n- 一条", 2],
    ["同一版本组重复", "# 1.0.0\n## 新增\n- 一条\n## 新增\n- 两条", 4],
    ["版本重复", "# 1.0.0\n## 新增\n- 一条\n# 1.0.0\n## 新增\n- 两条", 4],
    ["版本不是新在前", "# 1.0.0\n## 新增\n- 一条\n# 1.1.0\n## 新增\n- 两条", 4],
    ["组在版本之前", "## 新增\n- 一条", 1],
    ["条目在组之前", "# 1.0.0\n- 一条", 2],
    ["空条目", "# 1.0.0\n## 新增\n- ", 3],
    ["普通段落", "# 1.0.0\n## 新增\n随便一段话", 3],
    ["三级标题", "# 1.0.0\n## 新增\n### 小节", 3],
    ["组没有条目", "# 1.0.0\n## 新增\n## 修复\n- 一条", 2],
    ["版本没有组", "# 1.1.0\n# 1.0.0\n## 新增\n- 一条", 1],
    ["末尾版本没有条目", "# 1.0.0\n## 新增", 2],
    ["注释没有闭合", "# 1.0.0\n## 新增\n- 一条\n<!--\n说明", 4],
  ])("%s时报格式错误并指出行号", (_why, md, line) => {
    expect(() => parseChangelog(md)).toThrow(new RegExp(`第 ${line} 行`));
  });
});

describe("仓库里的更新说明与桌面版本", () => {
  /** 仓库根下的文件原文；路径相对本测试文件。 */
  const read = (relative: string): string => readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");
  /** 可查发行版的完整索引：新在前，同号只出现一次。 */
  const RELEASES = [
    "1.6.11", "1.6.10", "1.6.9", "1.6.8", "1.6.7", "1.6.6", "1.6.5", "1.6.4", "1.6.3", "1.6.2", "1.6.1", "1.6.0", "1.5.0", "1.4.0", "1.3.1", "1.3.0", "1.2.0", "1.1.1", "1.1.0", "1.0.0",
    "0.3.2", "0.3.1", "0.3.0", "0.2.2", "0.2.1", "0.2.0", "0.1.0",
  ];

  it("更新说明包含桌面配置的当前版本，该版本一节至少有一条", () => {
    const notes = read("docs/release/changelog.md");
    const desktop = /^\s*version:\s*["']([^"']+)["']/m.exec(read("mygo.config.ts"))?.[1];
    expect(desktop, "mygo.config.ts 里读不到 version").toBeDefined();
    const section = parseChangelog(notes).find((v) => v.version === desktop);
    expect(section, `docs/release/changelog.md 缺少当前版本 ${desktop} 的一节`).toBeDefined();
    expect(section!.groups.flatMap((g) => g.items).length, `docs/release/changelog.md 中 ${desktop} 一节没有条目`).toBeGreaterThan(0);
  });

  it("恢复全部可查版本，按新在前排列且不重复、不缺漏", () => {
    const notes = read("docs/release/changelog.md");
    expect(parseChangelog(notes).map((v) => v.version)).toEqual(RELEASES);
  });

  it("每个恢复的版本都有可追溯来源，来源索引同序且同号只列一次", () => {
    const sources = read("docs/release/changelog-sources.md");
    const indexed = [...sources.matchAll(/^\|\s*(\d+\.\d+\.\d+)\s*\|/gm)].map((match) => match[1]);
    expect(indexed).toEqual(RELEASES);
  });
});

describe("弹窗可见版本 visibleReleases", () => {
  const releases = [
    { version: "1.6.0", groups: [] },
    { version: "1.5.0", groups: [] },
    { version: "1.4.0", groups: [] },
  ];

  it("当前版本有效时只显示当前及更早版本，过滤尚未发布版本", () => {
    expect(visibleReleases(releases, "1.5.0").map((v) => v.version)).toEqual(["1.5.0", "1.4.0"]);
  });

  it("当前版本比索引还旧时不显示比它新的说明", () => {
    expect(visibleReleases(releases, "1.3.0")).toEqual([]);
  });

  it("当前版本未收录时仍显示所有更早版本，不显示未来版本", () => {
    expect(visibleReleases(releases, "1.5.5").map((v) => v.version)).toEqual(["1.5.0", "1.4.0"]);
  });

  it("当前版本是 dev 等不可比较值时显示已收录说明，不误标当前版本", () => {
    expect(visibleReleases(releases, "dev")).toEqual(releases);
  });
});

describe("是否显示「已更新」提示条 shouldShowUpdateNotice", () => {
  it("没有上次看过的版本（新用户）时不显示", () => {
    expect(shouldShowUpdateNotice("1.2.0")).toBe(false);
    expect(shouldShowUpdateNotice("1.2.0", undefined)).toBe(false);
  });

  it("与上次看过的版本相同时不显示", () => {
    expect(shouldShowUpdateNotice("1.2.0", "1.2.0")).toBe(false);
  });

  it("与上次看过的版本不同时显示", () => {
    expect(shouldShowUpdateNotice("1.2.0", "1.1.1")).toBe(true);
  });
});
