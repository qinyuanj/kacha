import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChangelog, shouldShowUpdateNotice } from "./changelog";

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

describe("仓库里的更新说明与两张清单", () => {
  /** 仓库根下的文件原文；路径相对本测试文件。 */
  const read = (relative: string): string => readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");

  it("更新说明、服务端清单与桌面配置写的是同一个版本号，该版本一节至少有一条", () => {
    // 两张清单的版本号在这里手写正则读：Cargo.toml 与 mygo.config.ts 不是 TypeScript 能导入的东西，
    // 跨语言只能各读一遍（CODING_STANDARDS「一个含义只定义一处」的例外）。
    const notes = read("docs/release/web-changelog.md");
    const server = /^version\s*=\s*"([^"]+)"/m.exec(read("server/Cargo.toml"))?.[1];
    const desktop = /^\s*version:\s*["']([^"']+)["']/m.exec(read("mygo.config.ts"))?.[1];
    expect(server, "server/Cargo.toml 里读不到 version").toBeDefined();
    expect(desktop, "mygo.config.ts 里读不到 version").toBeDefined();
    expect(desktop, `桌面配置 mygo.config.ts 的版本 ${desktop} 与服务端清单 server/Cargo.toml 的 ${server} 不同号`).toBe(server);
    const section = parseChangelog(notes).find((v) => v.version === server);
    expect(section, `docs/release/web-changelog.md 缺少当前版本 ${server} 的一节`).toBeDefined();
    expect(section!.groups.flatMap((g) => g.items).length, `docs/release/web-changelog.md 中 ${server} 一节没有条目`).toBeGreaterThan(0);
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
