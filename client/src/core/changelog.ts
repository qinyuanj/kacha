// 更新说明：把 docs/release/changelog.md 解析为按版本倒序的结构。
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
const HEADING = /^(#+)\s+(.*)$/;
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

/** 解析到一半的进展：原文行、已认下的版本、当前版本与当前组（都带行号，留给收尾时报错），以及未闭合注释的起始行。 */
interface ParseProgress {
  lines: string[];
  versions: ChangelogVersion[];
  version: { value: ChangelogVersion; line: number } | null;
  group: { value: ChangelogGroup; line: number } | null;
  commentLine: number;
}

function fail(progress: ParseProgress, lineNo: number, why: string): never {
  throw new Error(`更新说明格式错误：第 ${lineNo} 行${why}：${progress.lines[lineNo - 1].trim()}`);
}

/** 收尾一层：开着的这一层必须已经写进内容（空组、没有任何组的版本都算格式错误），返回清空后的状态。 */
function closed<T>(level: { value: T; line: number } | null, isEmpty: (value: T) => boolean,
                   progress: ParseProgress, why: string): null {
  if (level && isEmpty(level.value)) fail(progress, level.line, why);
  return null;
}

/** 换组或换版本前先收掉当前组。 */
function closeGroup(progress: ParseProgress): void {
  progress.group = closed(progress.group, (group) => group.items.length === 0, progress, "的组没有条目");
}

function closeVersion(progress: ParseProgress): void {
  closeGroup(progress);
  progress.version = closed(progress.version, (version) => version.groups.length === 0, progress, "的版本没有任何组");
}

/** HTML 注释整段不算内容；返回这一行是否已被注释吃掉。 */
function inComment(progress: ParseProgress, line: string, lineNo: number): boolean {
  if (progress.commentLine) {
    if (line.endsWith("-->")) progress.commentLine = 0;
    return true;
  }
  if (!line.startsWith("<!--")) return false;
  if (!line.endsWith("-->")) progress.commentLine = lineNo;
  return true;
}

/** 一级标题开一个新版本：版本号严格是 x.y.z，且比上一个旧。 */
function openVersion(progress: ParseProgress, value: string, lineNo: number): void {
  if (!VERSION.test(value)) fail(progress, lineNo, "的一级标题不是版本号");
  const previous = progress.versions[progress.versions.length - 1];
  if (previous) {
    const order = compareVersions(value, previous.version);
    if (order === 0) fail(progress, lineNo, "的版本重复");
    if (order > 0) fail(progress, lineNo, "的版本没有按新在前排列");
  }
  closeVersion(progress);
  const entry: ChangelogVersion = { version: value, groups: [] };
  progress.versions.push(entry);
  progress.version = { value: entry, line: lineNo };
}

/** 二级标题在当前版本下开一个组：组名只认三种，同一版本内不许重复。 */
function openGroup(progress: ParseProgress, title: string, lineNo: number): void {
  const version = progress.version;
  if (!version) fail(progress, lineNo, "的组不在任何版本下");
  if (!GROUP_TITLES.includes(title)) fail(progress, lineNo, "的组名不是 新增 / 改进 / 修复");
  if (version.value.groups.some((group) => group.title === title)) fail(progress, lineNo, "的组在同一版本内重复");
  closeGroup(progress);
  const entry: ChangelogGroup = { title: title as ChangelogGroupTitle, items: [] };
  version.value.groups.push(entry);
  progress.group = { value: entry, line: lineNo };
}

/** 「- 」条目进当前组；「注意：」开头的是改变操作习惯的条目，正文去掉前缀。 */
function addItem(progress: ParseProgress, line: string, lineNo: number): void {
  const group = progress.group;
  if (!group) fail(progress, lineNo, "的条目不在任何组下");
  const text = line.slice(1).trim();
  const notice = text.startsWith(NOTICE_PREFIX);
  const body = notice ? text.slice(NOTICE_PREFIX.length).trim() : text;
  if (body === "") fail(progress, lineNo, "的条目为空");
  group.value.items.push({ text: body, notice });
}

/** 一行归一类：注释、空行、一级标题、二级标题、条目，都不是就报错。 */
function readLine(progress: ParseProgress, raw: string, lineNo: number): void {
  const line = raw.trim();
  if (inComment(progress, line, lineNo)) return;
  if (line === "") return;
  const heading = HEADING.exec(line);
  if (heading?.[1] === "#") return openVersion(progress, heading[2].trim(), lineNo);
  if (heading?.[1] === "##") return openGroup(progress, heading[2].trim(), lineNo);
  if (line === "-" || line.startsWith("- ")) return addItem(progress, line, lineNo);
  fail(progress, lineNo, "不是版本标题、组标题或「- 」条目");
}

export function parseChangelog(markdown: string): ChangelogVersion[] {
  const progress: ParseProgress = {
    lines: markdown.split(/\r?\n/),
    versions: [],
    version: null,
    group: null,
    commentLine: 0,
  };
  progress.lines.forEach((line, index) => readLine(progress, line, index + 1));
  if (progress.commentLine) fail(progress, progress.commentLine, "的 HTML 注释没有闭合");
  closeVersion(progress);
  return progress.versions;
}
