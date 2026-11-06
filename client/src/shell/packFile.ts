// 画板包入口：浏览器选择画板包文件。只选文件，不上传；上传由导入流程负责。
import { PACK_FILE_FILTER } from "../core/boardPack";

/**
 * 弹浏览器文件选择：`change` 到达即返回选中的文件；`<input>` 原生 `cancel` 事件（关掉对话框未选文件）返回 null。
 * 不按窗口焦点或定时器推测取消（#55）；要求 Chrome 113+、Firefox 91+、Safari 16.4+。
 */
export function pickPackFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = PACK_FILE_FILTER.extensions.map((e) => `.${e}`).join(",");
    input.style.display = "none";
    document.body.appendChild(input);
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    input.click();
  });
}
