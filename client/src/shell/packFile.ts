// Web 版画板包入口：系统文件对话框换成浏览器的文件选择与上传（桌面仍走 desktop.open/save）。
import { PACK_FILE_FILTER } from "../core/boardPack";
import { packUpload } from "./ipc";

/** 弹浏览器文件选择，选中后流式上传到服务端临时位置；取消选择返回 null。 */
export function pickAndUploadPack(): Promise<{ id: string; name: string } | null> {
  const port = packUpload;
  if (!port) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = PACK_FILE_FILTER.extensions.map((e) => `.${e}`).join(",");
    input.style.display = "none";
    document.body.appendChild(input);
    let settled = false;
    const cleanup = () => {
      input.remove();
      window.removeEventListener("focus", onFocus);
    };
    const done = (value: { id: string; name: string } | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    // 取消选择没有 change 事件：窗口重新获得焦点且未选文件时按取消处理。
    const onFocus = () => setTimeout(() => done(null), 300);
    window.addEventListener("focus", onFocus);
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return done(null);
      port.upload(file).then((id) => done({ id, name: file.name }), (e) => {
        cleanup();
        reject(e);
      });
    });
    input.click();
  });
}
