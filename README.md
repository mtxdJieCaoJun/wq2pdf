# wq2pdf — 文泉书局切片捕获与 PDF 还原工具

>
> **本项目仅用于个人学习**
> 本项目不存储或分发任何受版权保护的内容；
> 所有获取的内容应于24小时内删除。
---

## 项目简介

**wq2pdf** 是一套适用于 [文泉书局](https://wqbook.wqxuetang.com) 在线阅读器的切片捕获与 PDF 还原工具，包含：

| 组件 | 说明 |
| --- | --- |
| `wq2pdf_capture.user.js` | 油猴（Tampermonkey）脚本，静默捕获阅读页切片 |
| `wq2pdf_reconstruct.py` | Python 脚本，将捕获的切片重组为带目录书签的 PDF |
| `requirements.txt` | Python 依赖 |

>只有购买电子书后才能获取全部内容，否则仅能获取前30页试读部分。

---

## 特性

- **零网络请求捕获**：优先读取浏览器 HTTP 缓存中的原始图片字节
- **Canvas 兜底**：缓存不可用时，通过 `<canvas>` 转 JPEG（q0.95）
- **自动目录书签**：自动抓取 `catatree` 目录接口，生成 PDF 书签层级
- **智能灰度检测**：自动判断页面是否为黑白内容，可一键全彩/全灰
- **多标签页互斥**：同一浏览器只允许一个标签页捕获，避免数据混乱
- **自动滚动翻页**：内置自动滚动模式，整本书无人值守捕获
- **限速/占位图检测**：通过 16×16 指纹统计，识别疑似重复占位图
- **参数化命名**：按实际使用的格式、灰度模式、书签状态自动命名产物

---

## 安装

### 1. 浏览器端（油猴脚本）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome/Edge/Firefox）
2. 将 `wq2pdf_capture.user.js` 拖入油猴脚本管理页面并安装
3. 打开文泉书局任意书籍阅读页（`https://wqbook.wqxuetang.com/deep/read/*`），左下角出现控制面板即表示加载成功

### 2. 本地端（Python 脚本）

```bash
# （可选）创建并激活 conda 环境（推荐）
conda create -n wq2pdf python=3.11
conda activate wq2pdf

# 安装依赖
pip install -r requirements.txt
```

依赖说明：

- `Pillow>=12.3.0` — 图像拼合、旋转、灰度检测
- `img2pdf>=0.6.3` — 图片直嵌生成 PDF（无损 DCT 编码）
- `pymupdf>=1.28.2` — PDF 书签写入（仅在需要目录时引入）

---

## 使用流程

### Step 1：浏览器中捕获切片

1. 打开文泉书局，进入目标书籍的阅读页
2. 脚本自动开始捕获当前阅读范围内的切片，左下角面板实时显示进度
3. **正常阅读/滚动**即可，切片会随页面滚动自动入库；或点击 **「⏬ 自动滚动」** 
4. 阅读完毕后，点击 **「📦 打包下载」**，得到 `<bid>.zip`，内含：
- `<bid>.csv` — 页码与变换方式对照表
- `img/pNNNN_MM.webp` — 切片图片
- `<bid>_toc.json` — 目录快照
- `WARNING.txt` — 异常提示（如有缺片或疑似占位图）

> 使用 IndexedDB 本地存储，刷新页面不丢失已捕获数据；
>多标签页同时打开时，只捕获最后处于活动的标签页。

### Step 2：本地重组为 PDF

```bash
# 基础用法：自动解压、拼合、生成带书签的 PDF
python wq2pdf_reconstruct.py <bid>.zip
```

---

## 技术细节

### 切片与变换

文泉书局将每一页旋转90°~180°后，拆分为6个左右排列的切片，在阅读器对整组切片做统一变换回原图：

| 变换矩阵 | 含义 |
| --- | --- |
| `matrix(-1, 0, 0, -1, 0, 0)` | 180° 翻转 |
| `matrix(0, -1, 1, 0, 0, 0)` | 顺时针 90° |

脚本先按 `left` 坐标从左到右拼合切片，再整图旋转回正。

### 目录书签层级

自动请求 `/deep/book/v1/catatree?bid={bid}` 接口，解析 `label`（标题）、`level`（层级）、`pnum`（页码）生成 PyMuPDF 兼容的 `[level, title, page]` 书签列表。支持嵌套子章节。

### `wq2pdf_reconstruct.py`参数详解

| 参数 | 类型 | 说明 | 取值范围 | 默认 / 示例 |
| --- | --- | --- | --- | --- |
| `bid_zip` | 路径 | 油猴导出的切片压缩包，或已解压工作目录 | `<bid>.zip` 或已解压工作目录 | `<bid>.zip` |
| `-o, --out` | 路径 | 输出 PDF 路径 | 任意可写路径 | `<bid>/<bid>.pdf` |
| `--png-dir` | 路径 | 整页图输出目录 | 任意目录 |  e.g. `<bid>/<参数名>/` |
| `--reextract` | 开关 | 强制重新解压（已解压则默认跳过） | 出现即强制重解压 | e.g. `--reextract` |
| `--pages` | 字符串 | 只处理指定页 | 页码 `1~总页数`，形如 `1-3,5` | e.g. `--pages 1-3,5,6-9` |
| `--preview` | 字符串 | 仅重建这些页并存 PNG（不输出 PDF，目检用） | 同 `--pages` | e.g. `--preview 1,2,291` |
| `--img-format` | 枚举 | 整页图/PDF 内嵌编码 | `jpeg` 或 `png` | `--img-format jpeg` |
| `--jpeg-quality` | int | JPEG 质量（越高越清晰、体积越大） | `1`~`100` | `--jpeg-quality 95` |
| `--jpeg-subsampling` | int | 色度抽样（影响彩色文字清晰度） | `0`（无损4:4:4）/`1`（4:2:2）/`2`（4:2:0）（默认 `0`） | `--jpeg-subsampling 0` |
| `--gray-mode` | int | 灰度模式 | `1`=全灰 / `0`=全彩 / 其他值或缺省=自动 | e.g. `--gray-mode 1` |
| `--gray-delta` | int | 自动判灰的色差阈值 | `0`~`255` | `--gray-delta 48` |
| `--gray-frac` | float | 自动判灰的彩像素百分比阈值 | `0`~`1` | `--gray-frac 0.01` |
| `--dpi` | float | PDF 像素到物理尺寸比例（决定页面物理大小） | `>0`（常用 72~600；） | `--dpi 300` |
| `--no-toc` | 开关 | 不获取/不添加目录书签 | 出现即不加书签 | e.g. `--no-toc` |
| `--toc-json` | 路径 | 从指定本地 JSON 读目录 | 存在的本地目录 JSON | e.g. `--toc-json ./toc.json` |
| `--toc-cookie` | 字符串 | 请求目录接口时携带的 Cookie | 任意 Cookie 串 | e.g. `--toc-cookie "sessionid=xxx"` |

---

## 产物命名规则

脚本按**实际生效参数**自动命名：

| 场景 | PDF 文件名 | 整页图目录名 |
| --- | --- | --- |
| 全部默认 | `<bid>.pdf` | `<bid>_jpg/` |
| `--img-format png` | `<bid>_png.pdf` | `<bid>_png/` |
| `--gray-mode 1` | `<bid>_jpg_gray.pdf` | `<bid>_jpg_gray/` |
| `--img-format png --gray-mode 0` | `<bid>_png_fulc.pdf` | `<bid>_png_fulc/` |
| `--no-toc`（获取失败 ） | 自动追加 `_ntoc` | 自动追加 `_ntoc` |

---

## 文件结构

```javascript
.
├── wq2pdf_capture.user.js    # 油猴捕获脚本
├── wq2pdf_reconstruct.py     # PDF 还原脚本
├── requirements.txt          # Python 依赖
└── README.md                 # 本文件
```

---

## 许可与声明

本项目采用 MIT 许可证。代码仅供学习与技术研究。

**郑重声明**：
- 本工具仅为个人学习项目分享
- 只有**已合法购买或取得授权**的用户才能获取全部内容
- 生成的 PDF **仅限个人离线备份与学习使用**
- 产物应于24小时内删除，且**严禁**用于商业用途、无偿分享或公开传播
- 使用者须自行承担因违反平台服务条款或版权法而产生的法律责任

---

## 参考项目

[文泉书局电子书PDF下载](https://github.com/Soooda/wqbook_pdf_spider)；
[文泉书局导出PDF](https://github.com/xxlllq/PDFBooks)；
[wenquanshuju-pdf-downloader](https://github.com/WorkerAmo/wenquanshuju-pdf-downloader)；
[WQBookDownloader](https://github.com/zzsskyh/WQBookDownloader)；

---

## 第三方开源组件许可

本项目本身以 **MIT 许可证**发布，但运行时依赖以下第三方开源组件，其许可证条款随组件一同生效：

| 组件 | 版本要求 | 许可证全文 |
| --- | --- | --- |
| [Pillow](https://github.com/python-pillow/Pillow) | ≥12.3.0 | [LICENSE](https://github.com/python-pillow/Pillow/blob/main/LICENSE) |
| [img2pdf](https://github.com/josch/img2pdf) | ≥0.6.3 | [GNU LGPL v3](https://www.gnu.org/licenses/lgpl-3.0.html) |
| [PyMuPDF](https://github.com/pymupdf/PyMuPDF) | ≥1.28.2 | [GNU AGPL v3](https://www.gnu.org/licenses/agpl-3.0.html) |
