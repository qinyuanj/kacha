// 浏览器拒绝访问的端口（net::ERR_UNSAFE_PORT）。rig 的服务端与桩都让操作系统分配端口，
// 而 Windows 的动态端口范围可能被 Hyper-V / WSL / Docker 改成从 1024 起，会分到下面这些端口（#75）。
//
// 来源（2026-11-07 核对）：
// - Chromium net/base/port_util.cc 的 kRestrictedPorts（main 分支）
//   https://chromium.googlesource.com/chromium/src/+/main/net/base/port_util.cc
// - Fetch 规范的 bad port 列表 https://fetch.spec.whatwg.org/#bad-port
// 取两者并集：规范比 Chromium 多 4190、6679，Chromium 按注释跟随规范，提前避开。
// 不含 Chromium 由 field trial（kRestrictAbusePorts）下发的动态列表，那份无法离线得知。
const RESTRICTED_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115,
  117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697,
  10080,
]);

export function isChromeRestrictedPort(port: number): boolean {
  return RESTRICTED_PORTS.has(port);
}

/** 一次启动尝试的结果：分到的端口、启动出的对象，以及分到受限端口时用来关掉它的回调。 */
export interface StartAttempt<T> {
  port: number;
  value: T;
  release(): Promise<void>;
}

/**
 * 反复调用 start，直到分到浏览器能访问的端口；分到受限端口的那次先 release 再重来。
 * 超过 attempts 次仍未分到时报错，错误里列出 label 与分到的全部端口。
 */
export async function startOnSafePort<T>(
  label: string,
  start: () => Promise<StartAttempt<T>>,
  // Windows 的 bind(0) 按顺序分配端口，最长的连续受限段 6665–6669 有 5 个，上限要比它大。
  attempts = 10,
): Promise<Omit<StartAttempt<T>, "release">> {
  const rejected: number[] = [];
  for (let i = 0; i < attempts; i++) {
    const { port, value, release } = await start();
    if (!isChromeRestrictedPort(port)) return { port, value };
    rejected.push(port);
    await release();
  }
  throw new Error(`${label}连续 ${attempts} 次分到 Chrome 受限端口（${rejected.join(", ")}），放弃启动`);
}
