import { describe, expect, it } from "vitest";
import { approxSizeText, ARCHIVE_TEXT, boardSlotsFullText, DELETE_TASK_TEXT, formatBytes, IMPORT_TEXT, isSlotsFullText, PACK_IMPORT_TEXT, PASTE_TEXT, pasteRefusalText, REGION_TEXT, RELOCATE_TEXT, SAVE_TEXT, sizeNoticeText, slotsRefusal, slotsUsageText, STAGE_TEXT, TIDY_TEXT, usageLimitText, VARIANT_TEXT } from "./boardText";

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

// 画布这层拆出来的文案（原先是散在各模块里的裸字面量）：这里照票面 / 拆分前的原文手写一份。
// 手写的理由（CODING_STANDARDS 允许的例外）：这是定义处的测试，需要一份独立于被测代码的期望值来锁住
// 「文案一字不改」；别处的测试一律导入这些常量，不再手抄。
describe("画布动作文案", () => {
  it("另存为：成功一句，失败带原因", () => {
    expect(SAVE_TEXT.started).toBe("已开始下载（结果带图层时为 zip）");
    expect(SAVE_TEXT.failed("磁盘满了")).toBe("另存失败：磁盘满了");
  });

  it("生成变体的父任务已删除", () => {
    expect(VARIANT_TEXT.parentGone).toBe("父任务已删除，无法生成变体");
  });

  it("框选修改区域：拒绝原因、弹窗标题、目标标注与连线徽标", () => {
    expect(REGION_TEXT.unsupported).toBe("当前模型不支持框选修改区域");
    expect(REGION_TEXT.previewTitle("ref1.png")).toBe("框选修改区域 · ref1.png");
    expect(REGION_TEXT.targetLabel("Seedream 5.0 Flash", 2)).toBe("Seedream 5.0 Flash 的图2");
    expect(REGION_TEXT.edgeLabel(3)).toBe("3 区域");
  });

  it("删除排队 / 执行中的任务节点：确认框两行文案与三个按钮", () => {
    expect(DELETE_TASK_TEXT.title).toBe("删除任务节点");
    expect(DELETE_TASK_TEXT.ok).toBe("取消并删除");
    expect(DELETE_TASK_TEXT.cancel).toBe("不删除");
    expect(DELETE_TASK_TEXT.confirm(2)).toBe("2 个任务正在排队 / 执行。先取消再删除？\n已在执行的只停止本地等待，网关侧计算可能仍在继续。");
  });

  it("重新定位：没找到可改手动选文件，读不了带原因", () => {
    expect(RELOCATE_TEXT.missing("res1.png")).toBe("在用户数据根内没有找到 res1.png，可改为手动选择文件");
    expect(RELOCATE_TEXT.unreadable("坏.png", "网关拒绝")).toBe("无法读取 坏.png：网关拒绝");
  });

  it("本机图片导入：只收图片，逐张失败带原因", () => {
    expect(IMPORT_TEXT.imageOnly).toBe("只支持拖入图片文件");
    expect(IMPORT_TEXT.failed("a.png", "网络失败")).toBe("无法导入 a.png：网络失败");
  });

  it("整理模式的确认框取消按钮也在同一处", () => {
    expect(TIDY_TEXT.cancelLabel).toBe("取消");
  });
});

// 整理模式与画板包导入的既有文案：票面要求 boardText 全覆盖，这里把由 App / stages 调用的条目也锁住。
describe("整理模式与画板包导入文案", () => {
  it("整理条的体量对比、收掉张数与移出结局", () => {
    expect(TIDY_TEXT.compare(1536, 0)).toBe("整理前约 1.5 KiB → 现在约 0 B");
    expect(TIDY_TEXT.prune(3)).toBe("收掉未定稿（3）");
    expect(TIDY_TEXT.pruneConfirm(2, 2048)).toBe("将收掉 2 张，画板约减少 2.0 KiB。\n定稿与已被下游使用的结果保留；可以撤销。");
    expect(TIDY_TEXT.pruneConfirm(2, null)).toContain("画板体量暂时算不出");
    expect(TIDY_TEXT.movedOut("新板")).toBe("已移出为新画板「新板」，可在画板列表里打开。撤销只恢复本画板，新画板保留。");
    expect(TIDY_TEXT.movedOutKept("新板", "被拒")).toBe("新画板「新板」已建好，但本画板没有删去这些节点：被拒");
    expect(TIDY_TEXT.movedOutKept("新板", null)).toBe("新画板「新板」已建好，但本画板没有删去这些节点");
    expect(TIDY_TEXT.moveOutFailed("磁盘满了")).toBe("移出失败：磁盘满了");
  });

  it("画板包导入失败的两种说明", () => {
    expect(PACK_IMPORT_TEXT.failed("包坏了")).toBe("导入画板包失败：包坏了");
    expect(PACK_IMPORT_TEXT.openFailed("打不开")).toBe("画板已导入，但打开失败：打不开。可从画板列表打开。");
  });
});

// 既有条目里此前没人调用的三条（阶段成员数、画板位满的识别、画板位用量）：补上，票面要求本文件全覆盖。
describe("阶段与画板位的存量文案", () => {
  it("阶段收起时写成员数", () => {
    expect(STAGE_TEXT.count(2)).toBe("2 个节点");
  });

  it("按统一文案的开头认出「画板位满」：其它报错不算", () => {
    expect(isSlotsFullText(boardSlotsFullText({ used: 9, total: 10 }))).toBe(true);
    expect(isSlotsFullText("服务端返回 HTTP 500")).toBe(false);
  });

  it("画板位用量写 used/total", () => {
    expect(slotsUsageText({ used: 3, total: 10 })).toBe("画板位 3/10");
  });
});
