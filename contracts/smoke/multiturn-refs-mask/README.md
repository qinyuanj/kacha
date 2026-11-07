# 冒烟：多轮消息、参考图序号措辞、高亮叠加

#71 使用的脚本，换模型（如 seedream 系列）时原样重跑。

在 PowerShell 中执行：

```powershell
Set-Location contracts\smoke\multiturn-refs-mask
python -m venv .venv; .venv\Scripts\pip install pillow
$env:KACHA_GATEWAY_API_KEY = '临时密钥'   # 或写入仓库根的 .scratch\gateway.key（只给本人读取权限）
$env:SMOKE_MODEL = 'seedream-xxx'          # 默认 qwen-image-3.0-pro
$py = '.venv\Scripts\python'
& $py gen_images.py                        # 合成测试图 → in/
& $py probe.py gen_img                     # seedream 先探请求形态：gen_t2i | gen_img | edits_msgs | edits_image；lite 用 $env:SMOKE_SIZE = '2K'
& $py batch1.py t1                         # 结果回灌第 1 轮（t2a/t2c 依赖其输出）
foreach ($t in 't2d', 't2a', 't2c') { & $py batch1.py $t }
foreach ($k in 'tu', 'image', 'picture', 'tuzh') { foreach ($n in 2, 3) { & $py batch2.py $k $n } }
foreach ($w in 'maskfield', 'ov1', 'ov2', 'ctl', 'hard', 'hardctl') { & $py batch3.py $w }
& $py score.py                             # 主色占比；最终仍需人眼看 out/*/img0.png
# Seedream（#83）：probe.py 已确认 input.messages 被丢弃，改用 seedream.py（顶层 image 数组）
foreach ($k in 'tu', 'image', 'tuzh') { foreach ($n in 2, 3) { & $py seedream.py refs $k $n } }
foreach ($w in 'marked', 'overlay', 'bbox') { foreach ($r in 1, 2) { & $py seedream.py region $w $r } }; & $py seedream.py region ctl 1
& $py seedream.py limit 10; & $py seedream.py limit 11   # lite 用 14 / 15
& $py seedream.py burst 10
```

Linux 下把 `.venv\Scripts\python` 换成 `.venv/bin/python`、`$env:X = 'v'` 换成 `export X='v'` 即可。

串行跑：网关并发 6～10 时 429 且无 Retry-After。每次调用把原始响应与出图存 `out/<name>/`，脱敏交互存 `fixtures/<name>.json`；整理进 `contracts/fixtures/<日期>/` 前须再把 `mask` 等非标准字段的 data-URL 替换为 `[REDACTED_IMAGE]`（见 2026-09-16 夹具）。`in/`、`out/`、`fixtures/`、`.venv/` 不入库。
