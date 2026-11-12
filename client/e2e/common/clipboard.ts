// e2e 共用的剪贴板 / 导入参考图约定：内容寻址的落盘路径与摘要算法只在这里定义一次，
// 各个 spec 直接 import，不各自抄一份（服务端按内容寻址落盘，改了命名规则这里跟着改）。
import { createHash } from "node:crypto";
import { IMPORTED_REFERENCES_DIR } from "../../src/core/boardPack";

export { IMPORTED_REFERENCES_DIR };

/** 一份内容的 sha256（十六进制）：服务端按内容寻址落盘，文件名就是它。 */
export const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** base64 图片的 sha256：e2e 里的图片都是 base64 存的（见 common/boards 的 png）。 */
export const sha256OfBase64 = (b64: string): string => sha256Hex(Buffer.from(b64, "base64"));

/** 导入参考图里的落盘路径：<目录>/<内容摘要>.<扩展名>。 */
export const importedReferencePath = (sha256: string, extension = "png"): string => `${IMPORTED_REFERENCES_DIR}/${sha256}.${extension}`;
