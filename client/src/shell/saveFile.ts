// 结果图片经服务端附件接口下载；带图层的结果由服务端打成 zip。
import { transfer } from "./ipc";

export async function saveCopyAs(absPath: string): Promise<void> {
  transfer.downloadImage(absPath);
}
