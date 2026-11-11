import { describe, expect, it } from "vitest";
import { approxSizeText, ARCHIVE_TEXT, formatBytes, PASTE_TEXT, pasteRefusalText, sizeNoticeText, slotsRefusal, usageLimitText } from "./boardText";

// 期望文案照抄票面（#89 已确认的简洁版），独立于源码，防止同义反复。
describe("画板位文案（#89）", () => {
  it("放得下时不拒绝，放不下时给出带实际数字的统一文案", () => {
    expect(slotsRefusal({ used: 7, total: 10 }, 1)).toBeNull();
    expect(slotsRefusal({ used: 7, total: 10 }, 3)).toBeNull();
    expect(slotsRefusal({ used: 9, total: 10 }, 2)).toBe("画板位满了（9/10），归档或删掉一块再新建。");
    expect(slotsRefusal({ used: 10, total: 10 }, 1)).toBe("画板位满了（10/10），归档或删掉一块再新建。");
    // 超出画板位的老用户：照实际数字写。
    expect(slotsRefusal({ used: 12, total: 10 }, 1)).toBe("画板位满了（12/10），归档或删掉一块再新建。");
  });

  it("不新增画板时不拒绝", () => {
    expect(slotsRefusal({ used: 12, total: 10 }, 0)).toBeNull();
  });
});

// 体量与用量的换算 / 提醒句式：改 boardText（#96 的粘贴文案）时按 ADR 0020 补上这批存量覆盖。
describe("体量换算", () => {
  it("不到 1 KiB 按字节原样写", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("1024 起按 KiB / MiB / GiB / TiB 逐级换算，保留一位小数", () => {
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MiB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GiB");
    expect(formatBytes(5 * 1024 ** 4)).toBe("5.0 TiB");
  });

  it("满 100 起不再留小数：提醒里读的是量级而不是精度", () => {
    expect(formatBytes(150 * 1024 ** 2)).toBe("150 MiB");
  });

  it("超过 TiB 也停在 TiB，不再造新单位", () => {
    expect(formatBytes(1024 ** 5)).toBe("1024 TiB");
  });

  it("体量一律写「约 X」", () => {
    expect(approxSizeText(1536)).toBe("约 1.5 KiB");
  });
});

describe("用量与体量提醒", () => {
  it("接近上限只说整理，达到上限先说生成不受影响", () => {
    expect(usageLimitText("warn", 900, 1000)).toBe("用量接近上限（900 B / 上限 1000 B），整理一下画板？");
    expect(usageLimitText("alert", 1000, 1000)).toBe("用量已满（1000 B / 上限 1000 B），生成不受影响，请整理画板释放空间。");
  });

  it("画板越线提示带约数与整理引导", () => {
    expect(sizeNoticeText(2 * 1024 ** 3)).toBe("这块画板已经约 2.0 GiB 了，整理一下？");
  });
});

describe("粘贴文案（#96）", () => {
  it("拒绝原因到文案只有一处映射：只读归档沿用画板只读的共享文案", () => {
    expect(pasteRefusalText("readOnly")).toBe(ARCHIVE_TEXT.readOnly);
    expect(pasteRefusalText("staleNodeClip")).toBe(PASTE_TEXT.staleNodeClip);
    expect(pasteRefusalText("filesNotReadable")).toBe(PASTE_TEXT.filesNotReadable);
  });

  it("超限提示里的上限来自那个跨层常量，不另写一份数字", () => {
    expect(PASTE_TEXT.tooLarge).toBe("图片超过 64 MB 上限，先压缩再粘贴");
  });
});
