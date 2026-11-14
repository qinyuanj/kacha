// 测试用的内存壳端口（#126）：驱动打开画板、复制图片、粘贴图片、导入画板包，
// 并能返回成功、部分成功与失败结局，让界面把这些结局原样传出去（不必起 MyGo runtime、不发请求）。
// 形状与真实适配器一致：失败一律是 PortError，类别（conflict / missing / slotsFull / alreadyExists, ...）与
// Web 实现折出来的同一套，界面按类别分支的分支点因此在替身下也走得到。
// 各分组的替身在 shell/testing/fakePortStores.ts（#137），这里只把它们拼起来。
import { buildZip, type FixtureEntry } from "../../core/testing/zipFixture";
import { PortError, type CorePorts, type FeatureId, type PortFailureKind, type ShellPort } from "../port";
import type { FakeBoard, FakeCalls, FakePortOptions } from "./fakePortTypes";
import {
  fakeBoardStore,
  fakeFileStore,
  fakeMediaStore,
  fakeMetaStore,
  fakePackStore,
  fakeSessionStore,
  fakeUiStore,
  fakeUsageStore,
} from "./fakePortStores";

export type { FakeCalls, FakePortOptions } from "./fakePortTypes";

/** 造一个端口失败（界面按 kind 分支）。 */
export const fakeFailure = (kind: PortFailureKind, message: string = kind, feature?: FeatureId): PortError =>
  new PortError({ kind, code: kind, message, status: kind === "conflict" ? 409 : 0, ...(feature ? { feature } : {}) });

/** 画板包 fixture：manifest + 一块画板（导入用例用来验「选中的包文件被交给端口」）。 */
export function fakePackFile(entries: FixtureEntry[] = []): File {
  const bytes = buildZip(entries);
  return new File([bytes as unknown as BlobPart], "包.ugcpack", { type: "application/zip" });
}

/** 内存壳端口：所有分组都是可断言的替身，行为按选项脚本化。 */
export type FakePort = ShellPort & { calls: FakeCalls };

/** 替身记下的调用：断言界面把结局传出去时用。 */
export function emptyFakeCalls(): FakeCalls {
  return {
    write: [],
    read: [],
    rename: [],
    remove: [],
    archive: [],
    unarchive: [],
    import: [],
    copyImage: [],
    copyText: [],
    pickImages: [],
    pickPackFile: [],
    saveCopyAs: [],
    log: [],
    uploadReference: [],
    inspectImage: [],
    list: 0,
    uiStateWrites: [],
  };
}

/** core 那一组：把文件与元数据的能力拼成 core 需要的形状。 */
function fakeCorePorts(files: ReturnType<typeof fakeFileStore>, meta: ReturnType<typeof fakeMetaStore>): CorePorts {
  return {
    ...{},
    taskFs: { readFile: files.readFile, writeNewFile: files.writeNewFile },
    runDeps: {
      readFile: files.readFile,
      writeNewFile: files.writeNewFile,
      fetch: async () => new Response(null, { status: 500 }),
      now: () => new Date(0),
      schedule: (ms, fn) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
    relocateFs: { listDir: files.listDir, isFile: files.isFile, sha256: files.sha256 },
    packFs: { isFile: files.isFile, sha256: files.sha256 },
    imageProbe: { inspectImage: files.inspectImage },
    settingsPorts: {
      readSettings: meta.readSettings,
      defaultBaseUrl: async () => "http://gateway.invalid",
      writeSettings: meta.writeSettings,
      readModelsCache: meta.readModelsCache,
      writeModelsCache: meta.writeModelsCache,
      readApiKey: async () => null,
      writeApiKey: async () => undefined,
      deleteApiKey: async () => undefined,
      fetch: async () => new Response(null, { status: 500 }),
      now: () => new Date(0),
      log: () => undefined,
    },
  };
}

export function createFakePort(options: FakePortOptions = {}): FakePort {
  const boards = new Map<string, FakeBoard>((options.boards ?? []).map((b) => [b.path, { ...b }]));
  const pickImages = [...(options.pickImages ?? [])];
  const pickPacks = [...(options.pickPackFiles ?? [])];
  const imports = [...(options.imports ?? [])];
  const calls = emptyFakeCalls();
  const missing = new Set<FeatureId>(options.missing ?? []);

  const board = fakeBoardStore(boards, calls, options);
  const files = fakeFileStore(boards, calls);
  const meta = fakeMetaStore(calls);
  const media = fakeMediaStore(options, calls, pickImages, pickPacks);
  const pack = fakePackStore(imports, calls);
  const ui = fakeUiStore(calls);
  const usage = fakeUsageStore(new Set<string>(missing));
  const session = fakeSessionStore(options);
  const core = fakeCorePorts(files, meta);

  return {
    userRoot: options.userRoot ?? "/~",
    features: {
      generation: !missing.has("generation"),
      usage: !missing.has("usage"),
      packExport: !missing.has("packExport"),
    },
    board,
    files,
    meta,
    media,
    pack,
    ui,
    usage,
    session,
    core,
    calls,
  };
}