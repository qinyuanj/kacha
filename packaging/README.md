# Kacha Web 部署与运维

Kacha 由一个 `kacha-server` 进程同时托管前端静态文件和 API，默认地址为 `http://lzxsvn:3004/`。桌面安装器、自动更新与 Gitea 发布脚本已退役；旧版本只从 tag `v0.3.2` 查阅。

## 构建与复制

在开发机安装 Rust、Node 与 Python 3.11+，在仓库根目录执行：

```sh
python3 packaging/build_web.py
# 已按锁文件安装依赖时可跳过 npm ci：
python3 packaging/build_web.py --skip-npm-ci
```

Windows 开发机可执行 `python packaging\build_web.py`。脚本运行前端 release 构建和 `cargo build --release`，输出：

```text
release/kacha-web/
  kacha-server[.exe]
  static/
    index.html
    assets/...
  SHA256SUMS
```

把整个 `kacha-web` 目录复制到部署机，例如 `C:\kacha`。运行环境不需要 Rust、Node 或 Python；只需服务端程序和 `static/`。`index.html` 使用相对资源路径。SHA256SUMS 可用于复制后核对文件。

本次已在 WSL Linux 实际完成 release 构建并检查 Linux 产物；未在 Windows 编译或运行 `.exe`。

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

以下命令需管理员 PowerShell。按实际路径与域名调整；`--result-hosts` 只填需要追加的主机。

```powershell
$bin = '"C:\kacha\kacha-server.exe" --listen 0.0.0.0:3004 --data-root "D:\kacha-data" --gateway-url "http://lzxsvn:3001" --static-dir "C:\kacha\static" --min-free-gb 20'
sc.exe create Kacha binPath= $bin start= auto
sc.exe failure Kacha reset= 86400 actions= restart/5000/restart/5000/restart/5000
sc.exe failureflag Kacha 1
sc.exe start Kacha
sc.exe query Kacha
```

`start= auto` 配置开机自启；`failure` 配置三次失败均在 5 秒后重启，`failureflag 1` 让非服务正常退出的崩溃也触发恢复。开放防火墙 3004 端口时只限可信内网。升级前 `sc.exe stop Kacha`，替换程序和 `static/` 后再启动。

本机为 Linux，以上 Windows 注册、自启与崩溃重启步骤**未实测**；上线前需在 lzxsvn 验证服务状态、重启恢复、端口与磁盘余量。实际上线、qwen 结果域名实测和 Gitea Release 页更新不属于本票。

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

## 30 人并发内存实测

脚本用真实 release 服务端和本地网关桩，30 个线程分别执行写结果、读图、上传并导入 v0.3.2 画板包、导出画板包；每 20 ms 从 Linux `/proc/<pid>/status` 采样 `VmRSS`：

```sh
python3 packaging/load_30_users.py --output release/memory-30-users.json
```

2026-11-05 本机 WSL Linux 实测：30 人全部操作成功，1.62 秒完成，58 次采样，**服务端峰值 RSS 22.15 MiB**，低于约 **512 MiB** 预算。该结果使用仓库的小型画板包夹具，不是 Windows 实测，也未计入 lzxsvn 上 Gitea、new-api、学习站等进程的内存。

## 验证

```sh
python3 -m unittest discover -s packaging/tests
npm --prefix client test
npm --prefix client run typecheck
npm --prefix client run test:e2e -- --workers=4
cargo test --manifest-path server/Cargo.toml
```
