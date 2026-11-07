// 网页版更新说明：把 docs/release/web-changelog.md 解析为按版本倒序的结构。
// 格式从严：一级标题只能是版本号（新在前、不重复），二级标题只能是 新增 / 改进 / 修复（同版本内不重复），
// 其余只允许「- 」列表与 HTML 注释；任何不符都抛错并指出行号，由守护测试在日常验证时发现，页面上只降级为提示、不显示乱码。

export type ChangelogGroupTitle = "新增" | "改进" | "修复";

export interface ChangelogItem {
  text: string;
  /** 改变操作习惯的条目；text 已去掉「注意：」前缀。 */
  notice: boolean;
}

export interface ChangelogGroup {
  title: ChangelogGroupTitle;
  items: ChangelogItem[];
}

export interface ChangelogVersion {
  version: string;
  groups: ChangelogGroup[];
}

export const NOTICE_PREFIX = "注意：";
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const GROUP_TITLES: readonly string[] = ["新增", "改进", "修复"] satisfies ChangelogGroupTitle[];

/** 新用户（没有记录）不显示，由调用方直接记下当前版本；记录与当前版本不同才显示。 */
export function shouldShowUpdateNotice(currentVersion: string, lastSeenVersion?: string): boolean {
  return lastSeenVersion !== undefined && lastSeenVersion !== currentVersion;
}

function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a)!.slice(1).map(Number);
  const pb = VERSION.exec(b)!.slice(1).map(Number);
  for (let k = 0; k < 3; k++) if (pa[k] !== pb[k]) return pa[k] - pb[k];
  return 0;
}

export function parseChangelog(markdown: string): ChangelogVersion[] {
  const versions: ChangelogVersion[] = [];
  const lines = markdown.split(/\r?\n/);
  let version: { value: ChangelogVersion; line: number } | null = null;
  let group: { value: ChangelogGroup; line: number } | null = null;
  let commentLine = 0;

  const fail = (lineNo: number, why: string): never => {
    throw new Error(`更新说明格式错误：第 ${lineNo} 行${why}：${lines[lineNo - 1].trim()}`);
  };
  const closeGroup = () => {
    if (group && group.value.items.length === 0) fail(group.line, "的组没有条目");
    group = null;
  };
  const closeVersion = () => {
    closeGroup();
    if (version && version.value.groups.length === 0) fail(version.line, "的版本没有任何组");
    version = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (commentLine) {
      if (line.endsWith("-->")) commentLine = 0;
      continue;
    }
    if (line.startsWith("<!--")) {
      if (!line.endsWith("-->")) commentLine = lineNo;
      continue;
    }
    if (line === "") continue;

    const heading = /^(#+)\s+(.*)$/.exec(line);
    if (heading?.[1] === "#") {
      const value = heading[2].trim();
      if (!VERSION.test(value)) fail(lineNo, "的一级标题不是版本号");
      const previous = versions[versions.length - 1];
      if (previous && compareVersions(value, previous.version) === 0) fail(lineNo, "的版本重复");
      if (previous && compareVersions(value, previous.version) > 0) fail(lineNo, "的版本没有按新在前排列");
      closeVersion();
      const entry: ChangelogVersion = { version: value, groups: [] };
      versions.push(entry);
      version = { value: entry, line: lineNo };
    } else if (heading?.[1] === "##") {
      const title = heading[2].trim();
      if (!version) fail(lineNo, "的组不在任何版本下");
      if (!GROUP_TITLES.includes(title)) fail(lineNo, "的组名不是 新增 / 改进 / 修复");
      if (version!.value.groups.some((g) => g.title === title)) fail(lineNo, "的组在同一版本内重复");
      closeGroup();
      const entry: ChangelogGroup = { title: title as ChangelogGroupTitle, items: [] };
      version!.value.groups.push(entry);
      group = { value: entry, line: lineNo };
    } else if (line === "-" || line.startsWith("- ")) {
      if (!group) fail(lineNo, "的条目不在任何组下");
      const text = line.slice(1).trim();
      const notice = text.startsWith(NOTICE_PREFIX);
      const body = notice ? text.slice(NOTICE_PREFIX.length).trim() : text;
      if (body === "") fail(lineNo, "的条目为空");
      group!.value.items.push({ text: body, notice });
    } else {
      fail(lineNo, "不是版本标题、组标题或「- 」条目");
    }
  }
  if (commentLine) fail(commentLine, "的 HTML 注释没有闭合");
  closeVersion();
  return versions;
}
