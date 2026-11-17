import type { FetchLike } from "../core/gateway";
import type { DesktopBridge } from "./desktop";
import { localRun, unavailable } from "./desktopStores";

/** 网关端口：core 的设置与发现逻辑只需要这些原生能力，不关心 MyGo 绑定细节。 */
export interface GatewayPorts {
  readApiKey(): Promise<string | null>;
  writeApiKey(key: string): Promise<void>;
  deleteApiKey(): Promise<void>;
  fetch: FetchLike;
}

/** 响应头大小写不敏感：Go 与网关可能用不同的写法。 */
function headerValue(headers: Record<string, string>, name: string): string | null {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

/** 把 Go 的通用请求折成 core 认识的 FetchLike；模型发现与后续生成共用这一条原生通道。 */
function gatewayFetch(bridge: DesktopBridge): FetchLike {
  return async (url, init) => {
    if (!bridge.gateway) return unavailable("gateway");
    const response = await localRun(() => bridge.gateway!.request(url, init.method, init.headers, init.body ?? ""));
    return {
      status: response.status,
      headers: { get: (name: string) => headerValue(response.headers, name) },
      text: async () => response.body,
      arrayBuffer: async () => new TextEncoder().encode(response.body).buffer,
    };
  };
}

/** 造一组接到真实 Gateway 绑定的设置端口；没有绑定时不可用，绝不空成功。 */
export function createGatewayPorts(bridge: DesktopBridge): GatewayPorts {
  return {
    readApiKey: async () => (bridge.gateway ? localRun(() => bridge.gateway!.readApiKey()) : unavailable("gateway")),
    writeApiKey: async (key) => {
      if (!bridge.gateway) unavailable("gateway");
      await localRun(() => bridge.gateway!.writeApiKey(key));
    },
    deleteApiKey: async () => {
      if (!bridge.gateway) unavailable("gateway");
      await localRun(() => bridge.gateway!.deleteApiKey());
    },
    fetch: gatewayFetch(bridge),
  };
}
