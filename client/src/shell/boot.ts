// 桌面壳的唯一启动入口；启动失败交给界面明确报告。
import { bootDesktop } from "./desktopBoot";
import type { ShellPort } from "./port";

export async function selectShellPort(): Promise<ShellPort> {
  return (await bootDesktop()).port;
}
