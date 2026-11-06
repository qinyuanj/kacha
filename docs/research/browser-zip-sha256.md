# HTTP 下浏览器按条目读取画板包并计算 sha256：可行性与性能（2026-11-06）

回答 [HTTP 下浏览器流式读 zip 条目并计算 sha256 的可行性与性能](https://github.com/qinyuanj/kacha/issues/50)，背景是 [画板包导入按内容去重上传](https://github.com/qinyuanj/kacha/issues/45)。基于 main `16e283d`。

## 结论

1. **可行，而且不需要把 zip 读进内存。** 从 `<input type="file">` 拿到的 `File` 由磁盘承载；`Blob.slice()` 返回新的 Blob，读取时才取对应字节。读取器可以先 slice 文件尾找到 EOCD，再读中央目录拿到每个条目的 offset 和压缩后大小，最后读 30 字节本地头算出数据起点。stored 条目直接用 `slice(start, start+csize).stream()`；deflate 条目再经过 `DecompressionStream("deflate-raw")`。这几项都**不受安全上下文限制**，只有 Web Crypto（`crypto.subtle`）受限。
2. **sha256 用纯 JS 或 WASM 都够快。** 在 Node 24 / Ryzen 5 5500 上做增量 update：hash-wasm 约 250 MiB/s，@noble/hashes 约 200 MiB/s（原生 OpenSSL 约 1.8 GiB/s，作参照）。端到端处理 290 MiB 的测试包（162 个条目，含 20 MiB deflate 条目）耗时 2.1–2.5 s，峰值 RSS 约 100–120 MiB，**与包大小无关**。265 MB 去重后内容在团队机器上估计用时为秒级，远小于内网上传时间（100 Mbps 下约 21 s）。
3. **现有 `client/src/core/sha256.ts` 不适合这个用途**：一次性接口，要先把整份输入复制进填充缓冲区，实测只有 31 MiB/s。
4. **推荐路径**：在 `client/src/core` 自写一个最小 zip 读取器（只支持 stored/deflate，要支持 zip64），sha256 改用 `@noble/hashes`，整套流程放进一个 Web Worker。**不用 fflate 的流式 `Unzip`**：它只能顺序读取，没有随机访问。遇到 data descriptor 时，它靠逐字节扫描签名来找条目边界；Web 版导出的每个条目都带 data descriptor，图片内容里恰好出现签名字节时会截断条目。如果不想自己维护 ZIP 解析代码，zip.js 是可靠的备选，代价是约 39 KB gzip 的体积和更多配置。
5. **Web Worker 不是必需，但建议用。** 主线程按块异步处理不会长时间冻结页面，但 1–3 s 的 CPU 时间会和渲染争抢；`File` 可以 structured clone 给 Worker，不会复制内容。成本只是 Vite 的一行 `new Worker(new URL(...), { type: "module" })`。

## 本仓库现状

- **导入流程**：`client/src/shell/ipc.ts` 的 `uploadPack` 把整个 zip 当请求体 `POST /api/packs/uploads`，服务端流式落临时文件。之后 `entries` / `texts` / `import` 三个接口都在服务端用 Rust `zip` crate 读取。client 没有任何 zip 库，`package.json` 只有 React 和 `@xyflow/react`。
- **画板包布局**（`server/src/board_pack.rs`）：`.json` 条目用 Deflated，其余条目（图片、图层文件）用 **Stored**，超过 4 GiB 的条目带 `large_file`（zip64）。
- **Web 版导出写 data descriptor**：HTTP 下载流用 `ZipWriter::new_stream`，zip 8.6.0 中 `using_data_descriptor = !self.seek_possible`（`zip-8.6.0/src/write.rs:1298`）。所以 Web 版导出的每个条目都设了通用标志位 3，本地头里的 CRC 和大小为 0，真实值写在条目数据之后。桌面版 0.2.0/0.3.x 写的是可 seek 的文件，没有 data descriptor。**两种包的中央目录里都有正确的大小和 offset**，按中央目录读取对两者一视同仁。
- **sha256**：客户端 `client/src/core/sha256.ts` 是自写的一次性纯 JS 实现（注释已说明 HTTP 下没有 `crypto.subtle`，ADR 0018）。服务端 `transfer.rs` 上传参考图时边写边算 SHA-256，按 `导入参考图/<sha256>.<ext>` 存放；`image_info.rs` 也算 sha256。
- **约束**（ADR 0018）：服务端内存预算 512 MB，单文件请求体上限 64 MB。按缺失内容逐个上传图片时，单张图片远小于这个上限。

## 平台能力（一手信源）

| 能力 | 结论 | 信源 |
|---|---|---|
| Web Crypto (`crypto.subtle`) | 仅安全上下文可用；HTTP 内网页面不可用 | MDN [Features restricted to secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts/features_restricted_to_secure_contexts)（列表含 Web Crypto API） |
| Compression Streams | IDL 为 `[Exposed=*]`，没有 `[SecureContext]`；`CompressionFormat` 含 `"deflate-raw"`（RFC 1951，即 ZIP method 8 的裸 deflate）；Worker 内可用 | WHATWG [Compression Standard](https://compression.spec.whatwg.org/) §3、§5；MDN [DecompressionStream()](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream/DecompressionStream)（Baseline，2023-05 起各浏览器可用） |
| File / Blob 随机读取 | `Blob.slice(start, end)` 返回新的 Blob，不复制数据；`blob.stream()` 和 `arrayBuffer()` 读取时才取字节。File 不在 MDN 安全上下文限制列表中 | W3C [File API](https://w3c.github.io/FileAPI/)；同上 MDN 列表 |
| `crypto.getRandomValues` | 不受限（与本题无关，仅说明 `crypto` 对象本身存在） | 同上 MDN 列表 |
| ZIP 结构 | EOCD → 中央目录（每项有 method、compressed size、local header offset）→ 本地头（30 字节 + 文件名长 n + extra 长 m）→ 数据。标志位 3 表示大小写在 data descriptor 里；超过 4 GiB 或 65535 个条目时走 zip64 EOCD locator | PKWARE [APPNOTE.TXT](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) §4.3.7、§4.3.9、§4.3.12、§4.3.14–4.3.16、§4.4.4 |

要点：本地头里的文件名和 extra 长度可能与中央目录中的不同，**数据起点必须按本地头计算**，不能按中央目录推算。

## 候选库

版本和维护日期取自 `npm view` 与 GitHub API（2026-11-06）。

| 库 | 用途 | 流式 / 随机访问 | 体积 | 许可证 | 维护 |
|---|---|---|---|---|---|
| [@zip.js/zip.js](https://github.com/gildas-lormeau/zip.js) 2.24.0 | 完整 zip 读写 | `ZipReader(new BlobReader(file))` 读中央目录后按条目 `getData(writable)` 流式输出，即按 offset 随机读取；支持 zip64、data descriptor、可选 CRC 校验；deflate 优先走原生 `DecompressionStream`，不支持时用内置 WASM 或 JS | `dist/zip-core.min.js` 105 KB min / 约 39 KB gzip（本地实测）；全量包另带 54 KB 的 `zip-module.wasm` 和 Worker 脚本 | BSD-3-Clause | 活跃（最近推送 2026-10-22） |
| [fflate](https://github.com/101arrowz/fflate) 0.8.3 | deflate + zip | `unzipSync` / `unzip` 需要整个 zip 的 `Uint8Array`；流式 `Unzip` 只接受**顺序 push 整个文件**，没有随机访问；单独的 `Inflate` 流可以用来解 deflate 条目 | ZIP 解压约 5 KB min（README） | MIT | 维护中（最近推送 2026-05-16） |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) 2.4.0 | 纯 JS 哈希 | `sha256.create().update(chunk)….digest()` 增量计算 | sha256 约 2.8 KB gzip（README） | MIT | 活跃（最近推送 2026-09-08）；1.0 版经 Cure53 审计；零依赖；ESM-only，v2 要求 `.js` 子路径导入 |
| [hash-wasm](https://github.com/Daninet/hash-wasm) 4.12.0 | WASM 哈希 | `createSHA256()` → `init/update/digest` 增量计算；`save/load` 可续算 | SHA-256 约 7 KB gzip（README；WASM 以 base64 内嵌，无需单独加载 .wasm） | npm 标为 MIT（GitHub 许可证检测为 NOASSERTION） | **最近一次提交 / 发布是 2024-11-19**，近两年无更新 |
| 现有 `client/src/core/sha256.ts` | 纯 JS sha256 | 一次性接口，无增量 API | — | 仓库自有 | — |

fflate `Unzip` 处理 data descriptor 的方式（`fflate/esm/browser.js` 0.8.3，`Unzip.prototype.push`）：设了标志位 3 时，把大小记为未知（`sc = -1 - z64`），然后在缓冲区里**逐字节查找** `0x08074b50`（data descriptor）、`0x04034b50`（下一个本地头）或 `0x02014b50`（中央目录）作为条目结束。Stored 的 PNG/JPEG 数据近似随机字节，任意 4 字节恰好是这三个签名之一的概率约 3/2³²，所以 265 MB 内容里期望出现约 0.19 次，至少碰到一次的概率约 17%，相应的条目会被截断、哈希算错。逐字节扫描也是它慢的原因（下表 36 MiB/s）。

## 基准

环境：WSL2 / Linux 6.18，AMD Ryzen 5 5500（6 核 12 线程），Node 24.22.1（V8，与 Chrome/Edge 同引擎）。脚本见 [`browser-zip-sha256-bench/`](./browser-zip-sha256-bench/)。

### sha256 吞吐（256 MiB 随机数据，增量 update，3 次取最好）

| 实现 | 1 MiB 块 | 64 KiB 块 |
|---|---|---|
| node:crypto（原生 OpenSSL，参照上限，相当于有 `crypto.subtle` 时） | 1804 MiB/s | 1884 MiB/s |
| hash-wasm 4.12.0（WASM） | 244 MiB/s | 251 MiB/s |
| @noble/hashes 2.4.0（纯 JS） | 199 MiB/s | 196 MiB/s |
| 现有 `client/src/core/sha256.ts`（64 MiB 一次性输入） | 31 MiB/s | — |

块大小在 64 KiB–1 MiB 之间对吞吐量基本没有影响。

### 端到端：从 Blob 按条目读取 + 解压 + sha256

测试包由 `gen.py` 生成：290 MiB，162 个条目。其中 80 个 3.5 MiB stored "png"（随机字节），81 个 deflate JSON，外加一个 20 MiB deflate 条目（解压后）。写入目标不可 seek，**所有条目都带 data descriptor**，与 Web 版导出一致。Blob 用 `fs.openAsBlob` 获得，不整体读入；`peakRSS` 包含 Node 自身约 50 MiB 的基线。四种方式得到的哈希集合都与 Python `zipfile` 解出的结果一致。

| 方式 | 用时 | 吞吐 | 峰值 RSS |
|---|---|---|---|
| 自写读取器 + hash-wasm | 2.06 s | 146 MiB/s | 103 MiB |
| 自写读取器 + @noble/hashes | 2.35 s | 128 MiB/s | 105 MiB |
| zip.js `BlobReader` + hash-wasm（`useWebWorkers: false`） | 2.51 s | 120 MiB/s | 120 MiB |
| fflate 流式 `Unzip` + hash-wasm（顺序读全文件） | 8.25 s | 36 MiB/s | 150 MiB |

### 与浏览器的差异

尝试用 Playwright 在 Chromium 中以局域网 IP 的 HTTP 页面（非安全上下文）复测，但本机 WSL 缺少 Chromium 运行库（`libnspr4.so`），没有跑成。脚本 `browser-bench.mjs` + `web/` 已就绪，可在装有浏览器依赖的机器上运行：它会打印 `isSecureContext`、`typeof crypto.subtle`，以及主线程 / Worker 各模式的用时、块大小、JS 堆峰值和主线程最大定时器间隔。

由信源和实现推断的差异：

- **CPU 部分**：Chrome/Edge 与 Node 同为 V8，JS/WASM 哈希速度应在同一量级。hash-wasm README 在 Chrome 131 / Ryzen 9 7900X 上测得 1 MB 输入下 hash-wasm 426 MB/s、noble-hashes 1.3.2 约 110 MB/s。noble 从 v2 起明显变快（本测 199 MiB/s，其 README 在 Apple M4 上给出 297 MiB/s）。Firefox（SpiderMonkey）和 Safari（JSC）的数字可能不同，但量级不变。
- **I/O 部分**：浏览器里 Blob 的读取要经过渲染进程与浏览器进程之间的 IPC，`blob.stream()` 的块大小由浏览器决定，所以吞吐量会比 Node 直接读文件低一些。内存方面，File 不会被整体载入，常驻量是流队列加当前块，与 Node 结果同样与包大小无关。
- **团队机器**：比本机慢也只会到几秒量级；与 265 MB 的上传时间相比可以忽略，去重省下的上传时间远大于哈希成本。

## 推荐实现路径

1. **`client/src/core/zipIndex.ts`（纯函数 + 读取端口）**：接口形如 `readRange(start, end): Promise<Uint8Array>`，File 用 `blob.slice().arrayBuffer()` 实现，单测用内存 `Uint8Array` 实现，可直接复用现有画板包 fixtures。功能：
   - 读 EOCD（从尾部最多 65557 字节里反向查找签名），遇到 `0xFFFF` / `0xFFFFFFFF` 时走 zip64 EOCD locator 和 zip64 EOCD，中央目录条目的 zip64 extra（0x0001）也要解析；
   - 输出 `{ name, method, compressedSize, size, crc32, localHeaderOffset }`，文件名按标志位 11 区分 UTF-8 和 CP437（Rust `zip` 写入的非 ASCII 名会设 UTF-8 标志）；
   - 读本地头得到数据起点；只接受 method 0 和 8，遇到其他方法、加密或分卷时报错，回退为整包上传。
   代码约 100–150 行，比引入 zip.js 更贴合「服务端产出、格式已知」的现状，也容易在 vitest 里覆盖 data descriptor 与 zip64 两种布局。
2. **sha256 用 `@noble/hashes/sha2.js`**：选它而不是 hash-wasm，因为它在活跃维护、经过审计、零依赖、体积更小，也不涉及 WASM 实例化。在本题场景下比 hash-wasm 只慢约 20%，265 MB 约多 0.2–0.3 s。建议**顺带让 `client/src/core/sha256.ts` 改为基于 noble 的实现**：保留现有的 `sha256Hex` 签名和 await 时序，另外导出增量接口，以免仓库里有两套实现。
3. **Worker**：`packHashWorker.ts` 接收 `File`，逐条目把 `blob.slice(...).stream()`（deflate 条目再接 `pipeThrough(new DecompressionStream("deflate-raw"))`）喂给 hasher，回传每个条目的 `{ name, sha256, size }` 和进度。用 `AbortController` 或 `terminate()` 支持取消，与现有 `runCancellable` 的取消语义对齐。
4. **服务端不信任客户端哈希**：缺失内容上传后，服务端照 `transfer.rs` 的做法边写边算 sha256 并核对，不一致就拒绝。可以选做 CRC-32 校验来发现损坏的包：浏览器可以用中央目录里的 crc32 加一个约 1 KB 的 JS crc32 实现，但服务端核对 sha256 已经能保证结果正确，所以这一项可选。
5. **元数据条目**：manifest、画板、`task.json` 是小的 deflate 条目，同样用 `DecompressionStream` 在浏览器解开；读取后的 `inspectPack` 逻辑可以继续复用现在的 `readTexts` 输入形状。

**不推荐**：`file.arrayBuffer()` 后用 `unzipSync`（数百 MB 常驻内存）；fflate 流式 `Unzip`（见上文签名扫描风险）；用现有一次性 `sha256Hex` 算大图（31 MiB/s，且要整份复制）。

## 复现

```sh
# 依赖装在独立目录：npm i @zip.js/zip.js@2.24.0 fflate@0.8.3 @noble/hashes@2.4.0 hash-wasm@4.12.0
python3 -I gen.py /tmp/pack.zip && python3 -I verify.py /tmp/pack.zip
node hash-bench.mjs <node_modules>
node zip-bench.mjs <node_modules> /tmp/pack.zip manual-wasm   # manual-noble | zipjs | fflate-unzip
node repo-sha-bench.mjs <repo>/client/src/core/sha256.ts
node browser-bench.mjs <playwright-core 目录> <node_modules> ./web /tmp/pack.zip <局域网 IP>
```
