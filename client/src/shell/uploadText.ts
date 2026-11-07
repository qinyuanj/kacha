// 无依赖：e2e 直接导入断言，不能拉进 ipc.ts（它会引入 Worker）。

/** 上传类请求按状态码给的失败文案（#60）：反向代理回的非 JSON 错误体也能看懂。 */
export const UPLOAD_FAILURES: Readonly<Record<number, string>> = {
  408: "上传中断：超过 60 秒没有收到数据，请检查网络后重试",
  507: "服务器空间不足，请联系管理员",
};
