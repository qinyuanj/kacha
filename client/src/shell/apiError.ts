/** 同源 API 错误：status=0 表示网络失败；code 区分 invalid_key / gateway_unavailable / forbidden 等。 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** 服务端代为访问上游（对象存储）失败时的上游状态；与本接口自身的 status 不是一回事。 */
    public upstreamStatus?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
