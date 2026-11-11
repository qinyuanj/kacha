export type ImageCopyFailure = "decode" | "unavailable";

function selectedRanges(selection: Selection | null): Range[] {
  return selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
}

function copySelectedImage(image: HTMLImageElement, selection: Selection): ImageCopyFailure | null {
  const range = document.createRange();
  range.selectNode(image);
  selection.removeAllRanges();
  selection.addRange(range);
  return document.execCommand("copy") ? null : "unavailable";
}

function copyDecodedImage(image: HTMLImageElement, selection: Selection | null): ImageCopyFailure | null {
  return selection ? copySelectedImage(image, selection) : "unavailable";
}

function restoreSelection(selection: Selection, ranges: readonly Range[]): void {
  selection.removeAllRanges();
  ranges.forEach((range) => selection.addRange(range));
}

/**
 * 复制同源图片：不读字节、不用 Blob / canvas；让浏览器解码一个临时 img，再经选区与复制命令写系统剪贴板。
 * 内网 HTTP 下没有 Clipboard API（见 ADR 0021）；复制完成后恢复页面原有 DOM 选区并移除临时元素。
 * 预期失败以返回值交给界面映射文案；null = 成功，意外异常仍 reject。
 */
export async function copyImageToClipboard(src: string): Promise<ImageCopyFailure | null> {
  const image = document.createElement("img");
  image.style.position = "fixed";
  image.style.left = "-9999px";
  image.style.top = "0";
  image.style.pointerEvents = "none";
  const selection = document.getSelection();
  const previousRanges = selectedRanges(selection);
  document.body.append(image);
  image.src = src;
  try {
    return await image.decode().then(
      () => copyDecodedImage(image, selection),
      () => "decode",
    );
  } finally {
    image.remove();
    if (selection) restoreSelection(selection, previousRanges);
  }
}
