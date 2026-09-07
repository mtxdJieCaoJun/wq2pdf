# wq2pdf_reconstruct.py

文泉书局 deep/read 切片 → 复原整页图 → 合并为完整 PDF（含自动目录书签）。

油猴脚本 `wq2pdf.user.js` 负责从浏览器捕获切片并打包（`csv` + `img/`），本脚本是离线还原部分（Python，无浏览器依赖）。

---

## 输入

油猴脚本导出的切片压缩包 `<bid>.zip`：

```
<bid>.zip
├── <bid>.csv             每页一行:  页码,matrix(...)   (UTF-8 带 BOM, csv 双引号转义)
├── img/
│   └── pNNNN_MM.webp    切片；MM = 显示序(left 升序 rank)，每页 6 片，MM 升序即拼接顺序
└── toc.json              (可选) 油猴 0.0.5a+ 随包打包的目录快照
```

脚本自动解压到 zip 同级的 `<bid>/` 目录（工作目录名取自 zip 内的 csv 名），**所有中间文件与产出都保存在该目录内**；已解压则自动跳过（`--reextract` 强制重解）。也支持直接传已解压的目录作为输入。

`csv` 第二列为页面变换方式（`matrix(...)`），决定整图旋转回正的方向：
- `matrix(-1, 0, 0, -1, 0, 0)` → `flip` → 整图旋转 180°
- `matrix(0, -1, 1, 0, 0, 0)`   → `rot90` → 整图逆时针旋转 90°

## 重建流水线

1. 每页 6 片按显示序（文件名后缀 `01→06`）从左到右横向拼成"乱序"完整图，再整图旋转回正；
2. 判断灰度后直接把复原整页存为目标编码（默认 JPEG q95 + 4:4:4；非 JPEG 输入一律转 JPEG）。
   灰页存 DeviceGray、彩页存 RGB；`--img-format png` 可切 PNG 真无损；
3. `img2pdf` 原样直嵌基础 PDF（JPEG→DCTDecode / PNG→FlateDecode，零二次压缩）；
4. 目录按 zip 内 → 文件夹内 → 接口的顺序获取（见下），用 PyMuPDF `set_toc` 写入书签（图像流原样保留，不重压）；
5. 产物按实际使用的参数命名（见"产物命名规则"）。

## 灰度判定

参数 `--gray-mode`：

| 值 | 含义 | 后缀标记 |
|---|---|---|
| `1`  | 全彩（fulc）：强制 RGB，不判灰 | `fulc` |
| `0`  | 自动（auto，默认）：按阈值判定 | `auto` |
| `-1` | 全灰（gray）：所有页强制灰度 | `gray` |

自动判据（2026-09 按用户视觉范例标定）：

> 色差 `Δ = |R-G| + |G-B|` 超过 `--gray-delta`（默认 48）的像素占比 < `--gray-frac`（默认 0.01 = 1%）即视为无彩页，转灰度。

扫描正文页那种带淡纸纹/噪点的"视觉灰页"会正确转灰（实测 p150 = 0.49%、p288 = 0.57% 彩像素），封面等真彩页（p1 = 71%）会保留彩色。微调阈值：`--gray-delta`、`--gray-frac`。

非 JPEG 输入的图片一律先判灰再转 JPEG（步骤 2 一步到位，无 PNG 中转）。

## 目录获取（书签）

优先级：

1. **zip 内 `toc.json`**（油猴随包快照，解压前直接读取，最高优先）
2. **文件夹内**（工作目录）：`toc.json` > `<bid>_toc.json`（本脚本接口缓存）
3. **文泉 `catatree` 接口**（匿名可访问），获取成功后自动写入 `<bid>/<bid>_toc.json` 缓存，下次离线可用

- 接口：`https://wqbook.wqxuetang.com/deep/book/v1/catatree?bid=<bid>`，返回 `{code:0, data:[{level, label, pnum, children}]}`
- `--toc-json <文件>`：显式指定本地 JSON，优先级最高
- `--toc-cookie "..."`：接口需要登录时携带 Cookie
- `--no-toc`：跳过书签

接口失败时降级为无书签 PDF，不影响主体重建。

## 产物命名规则

按实际使用参数拼接后缀（格式在前，jpg_gray 风格）；纯默认（auto + jpeg + 有目录）只保留 `bid`。

| 命令 | PDF | 页面图目录 |
|---|---|---|
| 默认（有目录） | `<bid>/<bid>.pdf` | `<bid>/<bid>_jpg/` |
| `--gray-mode -1` | `<bid>/<bid>_jpg_gray.pdf` | `<bid>/<bid>_jpg_gray/` |
| `--gray-mode 1` | `<bid>/<bid>_jpg_fulc.pdf` | `<bid>/<bid>_jpg_fulc/` |
| `--img-format png` | `<bid>/<bid>_png.pdf` | `<bid>/<bid>_png/` |
| `--gray-mode 1 --img-format png --no-toc` | `<bid>/<bid>_png_fulc_ntoc.pdf` | `<bid>/<bid>_png_fulc_ntoc/` |

页面图目录默认 = `<bid>_<jpg|png>[<_fulc|_auto|_gray>][_ntoc]`，PDF 与页面图目录同级，均在 `<bid>/` 内。

**`ntoc` 自动追加**：只要最终没有目录（显式 `--no-toc`，或 zip/文件夹/接口三处都没取到），产物名自动加 `ntoc` 后缀——无需手动传参。

## 用法

```bash
python wq2pdf_reconstruct.py 3224451.zip                      # 默认: jpeg+自动灰+目录 → 3224451/3224451.pdf
python wq2pdf_reconstruct.py 3224451.zip --gray-mode -1       # 强制全灰 → 3224451/3224451_jpg_gray.pdf
python wq2pdf_reconstruct.py 3224451.zip --gray-mode 1        # 全彩 → 3224451/3224451_jpg_fulc.pdf
python wq2pdf_reconstruct.py 3224451.zip --img-format png     # PNG 无损 → 3224451/3224451_png.pdf
python wq2pdf_reconstruct.py 3224451.zip --gray-mode 0 --gray-delta 48 --gray-frac 0.01
python wq2pdf_reconstruct.py 3224451.zip --jpeg-quality 90
python wq2pdf_reconstruct.py 3224451.zip --pages 1-3,5
python wq2pdf_reconstruct.py 3224451.zip --preview 1,2,291    # 快速预览指定页,只存 PNG → <bid>/preview/
python wq2pdf_reconstruct.py 3224451.zip --reextract          # 强制重新解压覆盖
python wq2pdf_reconstruct.py 3224451.zip --toc-json toc.json  # 用指定本地目录 JSON
python wq2pdf_reconstruct.py 3224451.zip --no-toc             # 不要书签 → ..._ntoc
```

## 参数速查

| 参数 | 默认 | 说明 |
|---|---|---|
| `bid_zip` | （必填） | 油猴导出的 `<bid>.zip`（也接受已解压目录） |
| `-o/--out` | 按参数命名 | 输出 PDF 路径（默认 `<bid>/<bid>[后缀].pdf`） |
| `--png-dir` | 按参数命名 | 整页图输出目录（默认 `<bid>/<参数名>/`） |
| `--reextract` | 关 | 强制重新解压（默认已解压则跳过） |
| `--pages` | 全部 | 只处理指定页，如 `1-3,5` |
| `--preview` | — | 只重建这些页并存 PNG（目检用） |
| `--img-format` | `jpeg` | `jpeg`(非JPEG自动转) / `png`(真无损) |
| `--jpeg-quality` | `95` | JPEG 质量 |
| `--jpeg-subsampling` | `0` | `0`=4:4:4(文字最清晰) / `1`=4:2:2 / `2`=4:2:0 |
| `--gray-mode` | `0` | `1`=全彩 / `0`=自动 / `-1`=全灰 |
| `--gray-delta` | `48` | 自动灰度判据：色差超此值计为彩像素 |
| `--gray-frac` | `0.01` | 自动灰度判据：彩像素占比低于此值才转灰 |
| `--dpi` | `300` | PDF 像素→物理尺寸比例 |
| `--no-toc` / `--toc-json` / `--toc-cookie` | — | 目录书签控制（互斥组） |

## 依赖

Python ≥ 3.9，依赖见 `requirements.txt`：

```bash
pip install -r requirements.txt
```

| 包 | 用途 |
|---|---|
| `pillow` | 切片拼合 / 旋转回正 / 灰度判定 / JPEG·PNG 编码 |
| `img2pdf` | 页面图原样直嵌 PDF（JPEG→DCTDecode，PNG→FlateDecode） |
| `pymupdf` | 写入 PDF 目录书签（Outlines） |
