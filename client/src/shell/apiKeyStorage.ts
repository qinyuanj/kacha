// 无依赖：e2e 直接导入断言，不能拉进 ipc.ts（它会引入 Worker）。

/** 浏览器 localStorage 里保存 API 密钥的键（浏览器直连网关要用）。 */
export const API_KEY_STORAGE = "kacha.apiKey";
