// 测试用内存版任务目录文件系统：语义与壳层 IPC 一致——writeNewFile 遇已存在抛 409，readFile 缺失抛 404。
// core 只按结构读错误的 status，不依赖壳层的 ApiError 类。
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

export function memoryTaskFs(initial: Iterable<readonly [string, Uint8Array]> = []) {
  const files = new Map<string, Uint8Array>(initial);
  return {
    files,
    text: (path: string) => new TextDecoder().decode(files.get(path)),
    writeNewFile: async (path: string, bytes: Uint8Array) => {
      if (files.has(path)) throw httpError(409, `${path} 已存在`);
      files.set(path, bytes);
    },
    readFile: async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw httpError(404, `${path} 不存在`);
      return bytes;
    },
  };
}
