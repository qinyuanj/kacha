/** 同源 API 错误：status=0 表示网络失败；code 区分 invalid_key / gateway_unavailable / forbidden 等。 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
