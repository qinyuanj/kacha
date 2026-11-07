# Kacha Web 部署与运维

Kacha 由一个 `kacha-server` 进程同时托管前端静态文件和 API，默认地址为 `http://lzxsvn:3004/`。桌面安装器、自动更新与 Gitea 发布脚本已退役；旧版本只从 tag `v0.3.2` 查阅。

## 构建与复制

在开发机（原生 Windows）安装 Rust、Node 与 Python 3.11+，在仓库根目录的 PowerShell 中执行：

```powershell
python packaging\build_web.py
# 已按锁文件安装依赖时可跳过 npm ci：
python packaging\build_web.py --skip-npm-ci
```

脚本运行前端 release 构建和 `cargo build --release`，输出：

```text
release/kacha-web/
  kacha-server[.exe]
  static/
    index.html
    assets/...
  SHA256SUMS
```

把整个 `kacha-web` 目录复制到部署机，例如 `C:\kacha`。运行环境不需要 Rust、Node 或 Python；只需服务端程序和 `static/`。`index.html` 使用相对资源路径。SHA256SUMS 可用于复制后核对文件。

Linux 上命令相同，只需把 `python` 换成 `python3`、路径分隔符换成 `/`；Linux 不再实测。

2026-11-07 在 Windows 开发机实测：`python packaging\build_web.py` 完成 release 构建并产出 `kacha-server.exe` 与 `static/`；前台启动后 `GET /` 返回首页、`GET /api/config` 返回版本，登录后经符号链接越界读文件返回 403；`cleanup --dry-run` 正常执行并退出 0。尚未实测：在 lzxsvn 上以 Windows 服务运行（见下文「待人工实测」与 [#70](https://github.com/qinyuanj/kacha/issues/70)）。

## 配置

命令行参数优先于环境变量。Windows 服务建议使用下面的绝对路径参数，避免服务工作目录影响相对路径。

| 参数 | 环境变量 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `--listen` | `KACHA_LISTEN` | `0.0.0.0:3004` | 监听地址与端口；部署前确认端口空闲 |
| `--data-root` | `KACHA_DATA_ROOT` | `./kacha-data` | 所有用户数据根、回收区与服务端日志的位置 |
| `--gateway-url` | `KACHA_GATEWAY_URL` | `http://lzxsvn:3001` | 服务端验证密钥的网关地址，也是前端初始网关地址与 CSP 允许地址 |
| `--static-dir` | `KACHA_STATIC_DIR` | 无 | 前端构建目录；部署时指到复制后的 `static` |
| `--result-hosts` | `KACHA_RESULT_HOSTS` | 空 | 逗号分隔的额外结果对象存储主机或后缀；默认已含 `.volces.com`、`.volccdn.com`、`.bytepluses.com`、`.aliyuncs.com` |
| `--min-free-gb` | `KACHA_MIN_FREE_GB` | `20` | 数据盘最低余量（GiB）；低于它时写入接口返回 507 |

结果下载只允许 HTTP/HTTPS 与允许列表中的主机，重定向也逐次校验。不要把不可信内网主机加入列表。若允许用户把前端网关改为非 `KACHA_GATEWAY_URL` 的地址，还需同步调整服务端 CSP；当前部署应保持一致。

数据根建议放在空间充足的 NTFS 数据盘。服务端只存密钥指纹和会话（`<数据根>/sessions.json`，只含会话令牌哈希、指纹与过期时间，服务重启后会话仍有效），不存密钥；日志不应包含密钥、提示词全文或签名结果地址。服务端不做备份，也不自动清理用户数据（画板包上传临时文件除外，见「清理与恢复」）。

## Windows 服务

服务端自带原生 Windows 服务模式：`kacha-server.exe service <与前台相同的参数>`。该模式对接服务控制管理器（SCM），启动时报告运行状态；收到停止（或关机）请求后，立即停止接受新连接，等进行中的请求处理完再退出，排空最多 60 秒。超过 60 秒就放弃剩余请求退出。单个文件都经临时文件加原子改名落位，被放弃的请求不会留下半截文件，只会留下临时文件；画板改名或删除恰好在两步之间被结束时，可能多出一个孤立的 `.bak`，可手动处理。不带 `service` 时仍是前台运行，Ctrl+C 走同一条优雅关停路径。`service` 子命令只供 SCM 启动，在终端直接运行会报错退出。

以下命令需管理员 PowerShell，服务名统一为 `kacha`。按实际路径与域名调整；`--result-hosts` 只填需要追加的主机。

```powershell
$dir  = 'C:\Users\Intel\dev\services\kacha'
$data = "$dir\data"
$bin  = "`"$dir\kacha-server.exe`" service --listen 0.0.0.0:3004 --data-root `"$data`" --gateway-url http://lzxsvn:3001 --static-dir `"$dir\static`" --result-hosts .aliyuncs.com --min-free-gb 20"
sc.exe create kacha binPath= $bin start= auto depend= new-api obj= "NT AUTHORITY\NetworkService"
sc.exe failure kacha reset= 86400 actions= restart/5000/restart/5000/restart/5000
sc.exe failureflag kacha 1
# NetworkService 需要数据根的修改权限（程序目录只需读取与执行）：
icacls $data /grant "NT AUTHORITY\NetworkService:(OI)(CI)M"
sc.exe start kacha
sc.exe query kacha
```

- `sc.exe` 的 `参数= 值` 等号后必须有空格。`obj= "NT AUTHORITY\NetworkService"` 内置账户无需密码；不写 `obj=` 则以 LocalSystem 运行。
- `depend= new-api` 让服务在网关服务之后启动。
- `start= auto` 配置开机自启。`failure` 配置三次失败均在 5 秒后重启。`failureflag 1` 让服务以非零退出码报告停止时也触发恢复，例如数据根不可写、端口被占用。
- `$bin` 示例按 PowerShell 7 编写。Windows PowerShell 5.1 传给外部程序时会剥掉内嵌的双引号，路径含空格就会出错；这种情况请改用 PowerShell 7，或改用不含空格的路径。
- 开放防火墙 3004 端口时只限可信内网。
- 升级前执行 `sc.exe stop kacha`，等 `sc.exe query kacha` 显示 `STOPPED`；最长约 60 秒排空。替换程序和 `static/` 后再启动。

**日志**：服务模式没有控制台。启动（版本、监听地址、数据根、运行模式）、启动失败原因、收到关停信号、排空结果和退出都写入 `<数据根>\server-log\server.log`；超过 1 MiB 时轮转为 `server.1.log`，总量不超过 2 MiB。前台运行也写这份日志，同时保留控制台输出。同目录下的 `diagnostics.log` 是另一份日志（每日用量等事件），不记进程生命周期。启动时会先写一行日志，探测数据根是否可写；写不进去就直接启动失败。服务起不来时，先看 `server.log` 和 `sc.exe query kacha` 的 `SERVICE_EXIT_CODE`：1 表示数据根不可用（不能创建或不可写）、监听失败或异常退出，2 表示监听地址无效。数据根不可写时 `server.log` 也写不进去，只能看退出码；先检查服务账户的权限。

### 从 NSSM 服务迁移

lzxsvn 目前由 NSSM 服务 `kacha` 托管控制台程序，停服时硬终止进程。迁移到原生服务模式的步骤如下，需要维护窗口：

1. 记下现有参数：`nssm get kacha AppParameters`，同时核对账户（`NetworkService`）、依赖（`new-api`）与自启设置。
2. 通知用户暂停上传、保存与导入，然后执行 `nssm stop kacha`。
3. 执行 `nssm remove kacha confirm` 删除 NSSM 服务，再用 `sc.exe query kacha` 确认服务已不存在。
4. 用上面的 `sc.exe create` 以原生方式重建服务，参数保持不变（`--listen`、`--data-root`、`--gateway-url`、`--static-dir`、`--result-hosts`、`--min-free-gb`），只在程序路径后加 `service`。
5. 核对数据目录权限：NetworkService 对 `data\` 有修改权限。
6. 执行 `sc.exe start kacha`，确认 `GET /api/config` 版本正确，`data\server-log\server.log` 有本次启动记录。
7. 之后看 `data\server-log\server.log`；NSSM 的 `C:\Users\Intel\dev\logs\kacha\out.log` / `err.log` 不再更新，可归档。

### 待人工实测（lzxsvn）

以下各项**尚未实测**，需管理员在 lzxsvn 上逐项验证并回写结果：

- [ ] `sc.exe create`（带 `service`、`depend= new-api`、`obj= "NT AUTHORITY\NetworkService"`）成功。
- [ ] `sc.exe start kacha` 在数秒内进入 `RUNNING`，没有报错 1053；`server.log` 记录启动与「服务模式」。
- [ ] `sc.exe query kacha` 显示 `RUNNING`，`STOPPABLE` 与 `ACCEPTS_SHUTDOWN`。
- [ ] `sc.exe stop kacha` 进入 `STOP_PENDING` 后变成 `STOPPED`，退出码为 0；`server.log` 记录关停信号、排空完成与退出。
- [ ] 停服时有进行中的上传或画板包导入：请求能完成，或在 60 秒上限后被放弃；目标文件没有损坏，`server.log` 记录排空结果。
- [ ] 崩溃后自动重启：用 `taskkill /F /PID <pid>` 结束进程，5 秒后服务恢复为 `RUNNING`。
- [ ] 启动失败触发恢复：例如端口被占用时，`server.log` 记录失败原因，SCM 按失败策略重试。
- [ ] 开机自启：重启 lzxsvn 后服务在 `new-api` 之后自动进入 `RUNNING`。

实际上线、qwen 结果域名实测和 Gitea Release 页更新不属于本节。

## 清理与恢复

先预览，再执行；不要在服务端处理同一用户写入时并发运行清理：

```powershell
C:\kacha\kacha-server.exe cleanup --data-root D:\kacha-data --dry-run
C:\kacha\kacha-server.exe cleanup --data-root D:\kacha-data
# 磁盘紧急时跳过回收区，直接删除：
C:\kacha\kacha-server.exe cleanup --data-root D:\kacha-data --purge
```

候选只有连续 60 天无访问的闲置用户，以及所有画板均不引用且建立超过 30 天的任务目录。默认移入 `<数据根>\recycle\<批次>`，后续清理会彻底删除超过 14 天的批次。

列出回收区并恢复误删条目：

```powershell
C:\kacha\kacha-server.exe cleanup restore --data-root D:\kacha-data
C:\kacha\kacha-server.exe cleanup restore --data-root D:\kacha-data "<批次>/users/<指纹>/<原相对路径>"
```

恢复整个闲置用户时条目到 `users/<指纹>`；恢复任务目录时还包括日期与任务 id。命令搬回原位置，原位置已存在会拒绝覆盖。没有恢复界面。

### 画板包上传临时文件

导入画板包有两种上传暂存，导入结束（成功、失败或取消）即删除：

- 整包上传（浏览器读不了包时的回退）：`<数据根>\users\<指纹>\.kacha\packs\*.ugcpack.tmp`，每个可达几百 MB。
- 按内容去重上传：`<数据根>\users\<指纹>\.kacha\pack-content\*.staging.tmp\`，每次导入一个目录，里面每份内容一个文件（以 sha256 命名，写了一半的是 `*.part`）。

关掉标签页、放弃请求没发出去等情况会留下暂存。服务端在该用户每次开始上传（整包上传或开一份去重暂存）时，自动删除他修改时间超过 1 小时的两种暂存；`cleanup` 命令不处理它们。

升级前已存在的残留，会在对应用户下次上传时被清理；不想等的话，由管理员在服务停止时（或确认没有导入在进行时）手动删除 `<数据根>/users/*/.kacha/packs/*.ugcpack.tmp` 文件与 `<数据根>/users/*/.kacha/pack-content/*.staging.tmp` 目录（整个目录删除）。

用量与清理显示的字节数按文件长度累加：导入画板包时同次导入里内容相同的文件以硬链接落盘，会被重复计入，删除一个任务目录也不一定释放它显示的全部字节。

## 换密钥后的管理员迁移

换密钥即新用户。若只需迁移部分画板，优先让旧用户导出画板包，再用新密钥导入。必须搬整份数据时：

1. 通知用户暂停操作并停止 Kacha 服务。
2. 用新密钥登录一次以建立新用户数据根，再停止服务。
3. 把 `users/<旧指纹>/` 下的 `画板/`、日期任务目录和 `导入参考图/` 移到 `users/<新指纹>/`。不要覆盖新目录的 `.kacha/user.json` 等会话元数据。
4. 确认目标路径仍在配置的数据根内，重新启动服务并让用户核对画板、结果和图层。

服务端没有备份，搬移失败时只能靠用户导出的画板包与已下载结果恢复。

## 设计规模内存实测

设计规模是 12 人（见 `CONTEXT.md`）：它是容量与内存预算依据的规模假设，不是强制上限。压测脚本用真实 release 服务端和本地网关桩，按 `--users` 开同样多的线程，分别执行写结果、读图、上传并导入 v0.3.2 画板包、导出画板包；结束后、服务端退出前读一次操作系统记录的进程峰值内存（Windows：峰值工作集 `PeakWorkingSetSize`；Linux：`/proc/<pid>/status` 的 `VmHWM`），不受采样间隔影响。读不到峰值或超过预算（`--budget-mib`，默认 512）时以非 0 退出。

```powershell
python packaging\load_users.py --users 12 --output release\memory-12-users.json
```

2026-11-07 Windows 开发机实测（release 构建）：12 人全部操作成功，0.67 秒完成，**服务端峰值工作集 13.95 MiB**，低于 **512 MiB** 预算。该结果使用仓库的小型画板包夹具，未计入 lzxsvn 上 Gitea、new-api、学习站等进程的内存。

## 验证

提交前在仓库根目录执行：

```powershell
python packaging\verify.py
```

脚本先预检构建输出目录的完整性标签（见下文），再依次跑打包脚本单测、前端单测、类型检查、e2e（4 个 worker）与服务端测试（`--no-fail-fast`）。每一项都会跑完，最后汇总；任一失败即以非 0 退出。只需重跑其中一项时，命令见 [verify.py](verify.py) 的 `COMMANDS`。

仓库自带 pre-push 钩子 [.githooks/pre-push](../.githooks/pre-push)，推送前自动跑这套验证，失败即拒绝推送。每个 clone 启用一次（同一 clone 的 worktree 共用）：

```powershell
git config core.hooksPath .githooks
```

符号链接逃逸测试在无权创建符号链接时打印原因并跳过，其余断言照常运行。无权的原因可能有两种：当前账户既没开开发者模式，也不是管理员；或者测试程序以 Low 完整性级别运行。

Windows 启动程序时，进程的完整性级别不会高于 exe 文件自身的标签；文件的标签从所在目录继承。仓库若放在带 Low 完整性标签的目录下（例如某些沙箱工具会这样标记 Desktop），编译出的测试程序和服务端都会以 Low 运行。这时它们不能写 `%TEMP%`（报错误 5，测试建临时目录失败、压测启动时报「数据根不可写」），也不能创建符号链接；`cargo build` 编译 ring 时 cl.exe 报 `D8050: 无法执行 c1.dll` 也是这个原因。新 clone 或新建 worktree 的目录同样继承标签，先跑 `python packaging\verify.py --preflight`，它只做这项预检。可以用 `icacls <目录>` 查看目录的标签。处理方法是把两个构建输出目录设为 Medium，其中已有的文件会随之继承：

```powershell
icacls server\target /setintegritylevel '(OI)(CI)M'
icacls release /setintegritylevel '(OI)(CI)M'
```

`cargo clean` 会删掉整个 `target` 目录，标签也随之消失，之后需要重新设置；`verify.py` 的预检会在跑测试前发现这种情况，并打印上面的命令。部署时复制到 lzxsvn 的程序按目标目录的标签运行，不受影响。
