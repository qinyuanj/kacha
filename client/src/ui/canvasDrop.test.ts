// 画布拖放与粘贴的纯逻辑：图片过滤、松手处挂到哪张任务卡片、逐张上传并读元信息、粘贴图片按时间戳命名后落成参考图节点。
import { describe, expect, it, vi } from "vitest";
import type { Board, BoardNode } from "../core/board";
import { MAX_PASTE_BYTES } from "../core/pageInput";
import type { ImageInfo } from "../shell/ipc";
import { IMPORT_TEXT, PASTE_TEXT } from "./boardText";
import { addImportedReferences, dropAttachOf, imageFilesOf, importImages, importPastedImages, isImageFile } from "./canvasDrop";

const USER_ROOT = "/~";

const imageInfo = (sha256 = "sha-a"): ImageInfo => ({ sha256, bytes: 10, width: 64, height: 48, format: "png", has_alpha: false });

const referenceNamed = (id: string, displayName: string): BoardNode => ({
  id,
  type: "reference",
  pos: [0, 0],
  size: [240, 160],
  path: `refs/${id}.png`,
  sha256: `sha-${id}`,
  display_name: displayName,
  extra: {},
});
const reference = (id: string): BoardNode => referenceNamed(id, id);
const task = (id: string): BoardNode => ({
  id,
  type: "task",
  pos: [0, 0],
  size: [280, 240],
  model: "m",
  size_spec: { tier: "1k", ratio: "1:1", width: null, height: null, auto_ratio: null },
  image_ports: 0,
  layer_decomposition: false,
  transparent_background: false,
  last_submitted: null,
  extra: {},
});
const boardOf = (...nodes: BoardNode[]): Board => ({ format_version: 2, title: "画板", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges: [], extra: {} });

/** 只带导入 / 粘贴逻辑要读的三样的文件替身：名字、MIME、字节数。 */
const fileOf = (name: string, type = "", size = 1024): File => ({ name, type, size }) as unknown as File;

describe("isImageFile", () => {
  it("MIME 是图片、或后缀是图片扩展名（大小写不敏感）", () => {
    expect(isImageFile({ name: "a.bin", type: "image/png" })).toBe(true);
    expect(isImageFile({ name: "截图.PNG", type: "" })).toBe(true);
    expect(isImageFile({ name: "x.heic", type: "" })).toBe(true);
    expect(isImageFile({ name: "note.txt", type: "text/plain" })).toBe(false);
    expect(isImageFile({ name: "board.ugcboard.json", type: "application/json" })).toBe(false);
  });
});

describe("imageFilesOf", () => {
  it("MIME 是图片就收", () => {
    expect(imageFilesOf([{ name: "a.bin", type: "image/png" }])).toEqual([{ name: "a.bin", type: "image/png" }]);
  });

  it("后缀在 IMAGE_EXTENSIONS 里也收，大小写不敏感", () => {
    expect(imageFilesOf([{ name: "截图.PNG", type: "" }, { name: "x.heic", type: "" }])).toHaveLength(2);
  });

  it("非图片一律不收；混合时保持原顺序", () => {
    const files = [
      { name: "a.png", type: "image/png" },
      { name: "note.txt", type: "text/plain" },
      { name: "board.ugcboard.json", type: "application/json" },
      { name: "b.webp", type: "" },
    ];
    expect(imageFilesOf(files)).toEqual([files[0], files[3]]);
    expect(imageFilesOf([])).toEqual([]);
  });
});

describe("dropAttachOf", () => {
  const board = boardOf(task("t1"), reference("r1"));

  it("落在任务卡片上：挂到该任务左侧", () => {
    expect(dropAttachOf({ kind: "node", nodeId: "t1" }, board)).toEqual({ taskId: "t1", place: "left" });
  });

  it("落在画布空白、图片节点或不在画板上的 id：不挂接", () => {
    expect(dropAttachOf(null, board)).toBeUndefined();
    expect(dropAttachOf({ kind: "pane" }, board)).toBeUndefined();
    expect(dropAttachOf({ kind: "node", nodeId: "r1" }, board)).toBeUndefined();
    expect(dropAttachOf({ kind: "node", nodeId: "gone" }, board)).toBeUndefined();
  });
});

describe("importImages", () => {
  it("逐张上传、读元信息、写缓存，返回要落成参考图的那些", async () => {
    const upload = vi.fn(async (file: File) => ({ path: `导入参考图/${file.name}` }));
    const inspect = vi.fn(async () => imageInfo());
    const prime = vi.fn();
    const toast = vi.fn();

    const images = await importImages([fileOf("a.png"), fileOf("b.png")], { userRoot: USER_ROOT, toast, ports: { upload, inspect, prime } });

    expect(images).toEqual([
      { path: "导入参考图/a.png", sha256: "sha-a", display_name: "a.png", width: 64, height: 48 },
      { path: "导入参考图/b.png", sha256: "sha-a", display_name: "b.png", width: 64, height: 48 },
    ]);
    expect(upload.mock.calls.map(([file]) => file.name)).toEqual(["a.png", "b.png"]);
    // 绝对路径 = 用户数据根 + 服务端给的相对路径。
    expect(inspect).toHaveBeenCalledWith("/~/导入参考图/a.png");
    expect(prime).toHaveBeenCalledWith("/~/导入参考图/a.png", imageInfo());
    expect(toast).not.toHaveBeenCalled();
  });

  it("单张失败只提示，不打断其余", async () => {
    const upload = vi.fn(async (file: File) => {
      if (file.name === "bad.png") throw new Error("上传失败");
      return { path: `导入参考图/${file.name}` };
    });
    const inspect = vi.fn(async (absPath: string) => {
      if (absPath.endsWith("unreadable.png")) throw new Error("无法识别的图片格式");
      return imageInfo();
    });
    const prime = vi.fn();
    const toast = vi.fn();

    const images = await importImages([fileOf("bad.png"), fileOf("unreadable.png"), fileOf("ok.png")], { userRoot: USER_ROOT, toast, ports: { upload, inspect, prime } });

    expect(images.map((img) => img.display_name)).toEqual(["ok.png"]);
    expect(toast.mock.calls).toEqual([[IMPORT_TEXT.failed("bad.png", "上传失败")], [IMPORT_TEXT.failed("unreadable.png", "无法识别的图片格式")]]);
    expect(prime).toHaveBeenCalledTimes(1);
  });

  it("一张都没成功：返回空数组", async () => {
    const upload = vi.fn(async () => Promise.reject(new Error("网络失败")));
    const toast = vi.fn();
    expect(await importImages([fileOf("a.png")], { userRoot: USER_ROOT, toast, ports: { upload, inspect: vi.fn(async () => imageInfo()), prime: vi.fn() } })).toEqual([]);
    expect(toast).toHaveBeenCalledWith(IMPORT_TEXT.failed("a.png", "网络失败"));
  });

  it("displayNames 整批给显示名；没给到的那张退回本机文件名", async () => {
    const upload = vi.fn(async (file: File) => ({ path: `导入参考图/${file.name}` }));
    const deps = { userRoot: USER_ROOT, toast: vi.fn(), ports: { upload, inspect: vi.fn(async () => imageInfo()), prime: vi.fn() } };

    const named = await importImages([fileOf("a.png"), fileOf("b.png")], { ...deps, displayNames: (paths) => paths.map((_, i) => `粘贴-第${i + 1}张`) });
    expect(named.map((img) => img.display_name)).toEqual(["粘贴-第1张", "粘贴-第2张"]);

    // 回调少给（或中途失败）时那张用本机文件名，不留下 undefined。
    const partial = await importImages([fileOf("a.png"), fileOf("b.png")], { ...deps, displayNames: () => ["只有第一张有名字"] });
    expect(partial.map((img) => img.display_name)).toEqual(["只有第一张有名字", "b.png"]);
  });
});

describe("importPastedImages", () => {
  const portsOf = () => ({ upload: vi.fn(async (file: File) => ({ path: `导入参考图/${file.name}` })), inspect: vi.fn(async () => imageInfo()), prime: vi.fn() });

  /** 固定「现在」，粘贴显示名里的时间戳才可断言。 */
  async function atTime<T>(run: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 0));
    try {
      return await run();
    } finally {
      vi.useRealTimers();
    }
  }

  it("显示名整批按「粘贴-年月日-时分」算，并避开画板里已有的名字", async () => {
    const board = boardOf(task("t1"), referenceNamed("r1", "粘贴-20260102-0304.png"));
    const ports = portsOf();
    const apply = vi.fn();
    const toast = vi.fn();

    await atTime(() => importPastedImages([fileOf("a.png", "image/png"), fileOf("b.png", "image/png")], { x: 12, y: 34 }, { board, userRoot: USER_ROOT, toast, ports, apply }));

    expect(toast).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(1);
    const change = apply.mock.calls[0][0];
    // 画板里已有同名的一张，所以第一张就是 -2，第二张接着 -3；扩展名取落盘路径。
    expect(change.kind).toBe("addReferences");
    expect(change.images.map((img: { display_name: string }) => img.display_name)).toEqual(["粘贴-20260102-0304-2.png", "粘贴-20260102-0304-3.png"]);
    expect(change.at).toEqual([12, 34]);
    expect(change.attach).toBeNull();
  });

  it("恰好等于单张上限：仍照常导入，不提示超限", async () => {
    const ports = portsOf();
    const apply = vi.fn();
    const toast = vi.fn();

    await importPastedImages([fileOf("limit.png", "image/png", MAX_PASTE_BYTES)], { x: 0, y: 0 }, { board: boardOf(), userRoot: USER_ROOT, toast, ports, apply });

    expect(toast).not.toHaveBeenCalled();
    expect(ports.upload).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("超过单张上限：当场提示，不发请求也不落盘", async () => {
    const ports = portsOf();
    const apply = vi.fn();
    const toast = vi.fn();

    await importPastedImages([fileOf("huge.png", "image/png", MAX_PASTE_BYTES + 1)], { x: 0, y: 0 }, { board: boardOf(), userRoot: USER_ROOT, toast, ports, apply });

    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.tooLarge);
    expect(ports.upload).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("超限的跳过、其余照常导入（一次粘贴多张仍算一个撤销步）", async () => {
    const ports = portsOf();
    const apply = vi.fn();
    const toast = vi.fn();

    await importPastedImages(
      [fileOf("huge.png", "image/png", MAX_PASTE_BYTES + 1), fileOf("ok.png", "image/png")],
      { x: 0, y: 0 },
      { board: boardOf(), userRoot: USER_ROOT, toast, ports, apply },
    );

    expect(toast).toHaveBeenCalledWith(PASTE_TEXT.tooLarge);
    expect(ports.upload).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("一张可用的都没有：不落盘", async () => {
    const apply = vi.fn();
    await importPastedImages([], { x: 0, y: 0 }, { board: boardOf(), userRoot: USER_ROOT, toast: vi.fn(), ports: portsOf(), apply });
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("addImportedReferences", () => {
  const images = [{ path: "导入参考图/a.png", sha256: "sha-a", display_name: "a.png", width: 64, height: 48 }];

  it("有导入成功的图片才落盘，并带上挂接目标", () => {
    const apply = vi.fn();
    addImportedReferences(images, { x: 12, y: 34 }, { taskId: "t1", place: "left" }, apply);
    expect(apply).toHaveBeenCalledWith({ kind: "addReferences", images, at: [12, 34], attach: { taskId: "t1", place: "left" } });

    addImportedReferences(images, { x: 12, y: 34 }, undefined, apply);
    expect(apply).toHaveBeenLastCalledWith({ kind: "addReferences", images, at: [12, 34], attach: null });
  });

  it("一张都没成功：不产生撤销步", () => {
    const apply = vi.fn();
    addImportedReferences([], { x: 0, y: 0 }, undefined, apply);
    expect(apply).not.toHaveBeenCalled();
  });
});
