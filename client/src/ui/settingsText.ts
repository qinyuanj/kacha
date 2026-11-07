// 高级设置文件状态的用户可见提示文案：源码与 e2e 断言共用这一份，改文案只改这里。
// 不依赖 core：e2e 在 Node 里导入，core/capabilities 的 JSON 导入在那里加载不了。

/** settings.json 由更新版本写入（newer）。 */
export const settingsNewerText = (version: number) => `settings.json 由更新版本的工具写入（format_version ${version}），本次使用默认设置且不会覆盖该文件`;

/** 本次没能从服务端读到 settings.json（unreadable）。 */
export const SETTINGS_UNREADABLE_TEXT = "无法从服务端读取 settings.json，本次使用默认设置且不会覆盖该文件；请刷新页面重试";
