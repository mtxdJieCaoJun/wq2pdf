#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# wq2pdf_reconstruct.py — 文泉书局切片重组还原 PDF（含自动目录书签）。详见 README.md
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

from PIL import Image, ImageChops

FLIP_MATRIX = "matrix(-1, 0, 0, -1, 0, 0)"
ROT90_MATRIX = "matrix(0, -1, 1, 0, 0, 0)"
CATATREE_URL = "https://wqbook.wqxuetang.com/deep/book/v1/catatree?bid={bid}"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
def gray_token(gm: int | None) -> str:
    """灰度模式命名后缀: 1=全灰(gray) | 0=全彩(fulc) | 其他/None=自动(auto)。"""
    if gm == 1:
        return "gray"
    if gm == 0:
        return "fulc"
    return "auto"


#  解析

def parse_csv(csv_path: Path) -> dict[int, str]:
    """返回 {页码: 'flip' | 'rot90'}；未知变换直接报错。"""
    result: dict[int, str] = {}
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        for row in csv.reader(f):
            if not row or not row[0].strip() or row[0].strip() == "页码":
                continue  # 跳过空行与表头
            page = int(row[0].strip())
            transform = row[1].strip() if len(row) > 1 else ""
            if FLIP_MATRIX in transform:
                kind = "flip"
            elif ROT90_MATRIX in transform:
                kind = "rot90"
            else:
                raise ValueError(f"第 {page} 页未知变换: {transform!r}")
            result[page] = kind
    return result


def page_slices(img_dir: Path, page: int) -> list[Path]:
    """按显示序(文件名后缀升序)返回该页切片路径。"""
    paths = sorted(img_dir.glob(f"p{page:04d}_*.webp"))
    if not paths:
        raise FileNotFoundError(f"第 {page} 页找不到切片 p{page:04d}_*.webp")
    return paths


#  输入解包

def zip_bid(zip_path: Path) -> str | None:
    """从 zip 内的 csv 名取 bid（无需解压）；找不到返回 None。"""
    with zipfile.ZipFile(zip_path) as zf:
        name = next((n for n in zf.namelist()
                     if not n.endswith("/") and n.lower().endswith(".csv")), None)
    return Path(name).stem if name else None


def read_zip_toc(zip_path: Path):
    """读 zip 内的 toc.json 并解析为节点列表；没有则返回 None。"""
    with zipfile.ZipFile(zip_path) as zf:
        name = next((n for n in zf.namelist()
                     if not n.endswith("/") and Path(n).name.lower() == "toc.json"), None)
        if name is None:
            return None
        try:
            return extract_nodes(json.loads(zf.read(name).decode("utf-8")))
        except Exception as e:
            print(f"[警告] zip 内 {name} 解析失败: {e}", file=sys.stderr)
            return None


def extract_zip(zip_path: Path, work_dir: Path, force: bool = False) -> bool:
    """把切片包解压到 work_dir（防 zip-slip）；已解压且非强制则跳过。返回是否实际解压。"""
    if not force and any(work_dir.glob("*.csv")) and (work_dir / "img").is_dir():
        print(f"[解压] 已存在，跳过: {work_dir}")
        return False
    with zipfile.ZipFile(zip_path) as zf:
        root = work_dir.resolve()
        for info in zf.infolist():
            target = (work_dir / info.filename).resolve()
            if target != root and root not in target.parents:
                raise SystemExit(f"非法压缩包条目（路径穿越）: {info.filename}")
        work_dir.mkdir(parents=True, exist_ok=True)
        zf.extractall(work_dir)
    print(f"[解压] {zip_path.name} -> {work_dir}")
    return True


def locate_source(work_dir: Path) -> tuple[Path, Path]:
    """在工作目录里定位 csv 与 img/（兼容 zip 内带顶层目录）。"""
    csvs = sorted(work_dir.glob("*.csv"))
    if not csvs:
        csvs = sorted(work_dir.glob("**/*.csv"))
    if len(csvs) != 1:
        raise SystemExit(f"工作目录下应有且仅有一个 csv，实际 {len(csvs)} 个: {work_dir}")
    csv_path = csvs[0]
    img_dir = csv_path.parent / "img"
    if not img_dir.is_dir():
        raise SystemExit(f"缺少切片目录: {img_dir}")
    return csv_path, img_dir


#  目录获取

def extract_nodes(payload) -> list[dict]:
    """从接口/本地 JSON 响应里取出节点列表（兼容裸 data 数组与 {data:[...]}）。"""
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            return data
        raise ValueError(f"JSON 缺少 data 数组: {str(payload)[:160]}")
    if isinstance(payload, list):
        return payload
    raise ValueError(f"无法识别的 JSON 结构: {type(payload).__name__}")


def fetch_catalog(bid: str, cookie: str | None = None) -> list[dict]:
    """请求文泉 catatree 接口（实测匿名可访问，带 cookie 更稳）。失败抛异常。"""
    headers = {
        "User-Agent": UA,
        "Accept": "application/json",
        "Referer": f"https://wqbook.wqxuetang.com/deep/read/pdf?bid={bid}",
    }
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(CATATREE_URL.format(bid=bid), headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if isinstance(payload, dict) and payload.get("code") not in (0, None):
        raise ValueError(f"接口返回 code={payload.get('code')}: {str(payload)[:160]}")
    return extract_nodes(payload)


def build_toc(nodes: list, total_pages: int,
              page_map: dict[int, int] | None = None) -> tuple[list, int]:
    """树 → PyMuPDF 书签行 [level, label, 输出PDF页码]；超界 pnum 计入 dropped。"""
    lines: list[list] = []
    dropped = 0

    def walk(items: list) -> None:
        nonlocal dropped
        for node in items:
            if not isinstance(node, dict):
                continue
            try:
                level = int(node.get("level") or 1)
            except (TypeError, ValueError):
                level = 1
            label = str(node.get("label") or "").strip()
            try:
                pnum = int(node.get("pnum"))
            except (TypeError, ValueError):
                pnum = None
            if page_map is not None:
                local = page_map.get(pnum) if pnum is not None else None
            else:
                local = pnum if pnum is not None and 1 <= pnum <= total_pages else None
            if label and local is not None:
                lines.append([level, label, local])
            elif pnum is not None:
                dropped += 1  # 有页码但无有效标签/页码超界
            children = node.get("children")
            if isinstance(children, list):
                walk(children)

    walk(nodes)
    return lines, dropped


def resolve_toc(args, work_dir: Path, bid: str, total_pages: int,
                pages: list[int], zip_nodes: list | None = None) -> list:
    """目录优先级: zip 内 toc.json > 文件夹内(toc.json > <bid>_toc.json) > 接口(并写缓存)；失败降级空列表。"""
    if args.no_toc:
        print("[信息] --no-toc，PDF 不带书签")
        return []
    try:
        if args.toc_json:
            toc_path = Path(args.toc_json).resolve()
            nodes = extract_nodes(json.loads(toc_path.read_text(encoding="utf-8")))
            print(f"[目录] 来源: 指定 JSON {toc_path}")
        elif zip_nodes is not None:
            nodes = zip_nodes
            print("[目录] 来源: zip 内 toc.json")
        else:
            snapshot = work_dir / "toc.json"        # 文件夹内随包快照
            cached = work_dir / f"{bid}_toc.json"   # 本脚本接口缓存
            if snapshot.exists():
                nodes = extract_nodes(json.loads(snapshot.read_text(encoding="utf-8")))
                print(f"[目录] 来源: 文件夹内 {snapshot.name}")
            elif cached.exists():
                nodes = extract_nodes(json.loads(cached.read_text(encoding="utf-8")))
                print(f"[目录] 来源: 文件夹内缓存 {cached.name}")
            else:
                nodes = fetch_catalog(bid, args.toc_cookie)
                cached.write_text(json.dumps(nodes, ensure_ascii=False, indent=2),
                                  encoding="utf-8")
                print(f"[目录] 来源: 接口自动获取，已缓存 -> {cached}")
        page_map = {p: i for i, p in enumerate(pages, 1)} if len(pages) < total_pages else None
        toc_lines, dropped = build_toc(nodes, total_pages, page_map)
        print(f"[目录] 书签 {len(toc_lines)} 条, 层级最大 "
              f"{max((r[0] for r in toc_lines), default=0)}")
        if dropped:
            print(f"[目录] 跳过 {dropped} 条（无标签或页码超界）")
        for r in toc_lines[:6]:
            print(f"        {'  ' * (r[0] - 1)}- {r[1]}  (p{r[2]})")
        return toc_lines
    except Exception as e:  # 目录失败不影响主体 PDF
        print(f"[警告] 目录获取失败，将输出无书签 PDF: {e}", file=sys.stderr)
        return []


#  页面图输出

def save_png(im: Image.Image, path: Path) -> None:
    """落盘 PNG：zlib 最高级 + optimize 滤波择优，尽量压小（不改颜色模式）。"""
    im.save(path, format="PNG", compress_level=9, optimize=True)


def save_jpeg(im: Image.Image, path: Path, quality: int = 95,
              subsampling: int = 0) -> None:
    """落盘 JPEG（q95 + 4:4:4 无色度抽样 = 高保真；PDF 里由 img2pdf DCT 直嵌）。"""
    im.save(path, format="JPEG", quality=quality, subsampling=subsampling)


def is_grayscale(im: Image.Image, delta: int = 48, frac: float = 0.01) -> bool:
    """色差 Δ=|R-G|+|G-B| 超 delta 的像素占比 < frac 视为无彩页（判据标定见 README）。"""
    r, g, b = im.split()
    d = ImageChops.add(ImageChops.difference(r, g), ImageChops.difference(g, b))
    hist = d.histogram()
    total = sum(hist)
    colored_frac = sum(hist[delta + 1:]) / total if total else 0.0
    return colored_frac < frac


def save_page_image(im: Image.Image, path: Path, fmt: str,
                    quality: int = 95, subsampling: int = 0,
                    gray_mode: int = 2, gray_delta: int = 48,
                    gray_frac: float = 0.01) -> bool:
    """按 fmt 落盘复原整页（判灰后一步到位转目标格式）。gray_mode: 1=全灰/0=全彩/其他=自动。返回是否以灰度保存。"""
    if gray_mode == 1:
        gray = True
        if im.mode != "L":
            im = im.convert("L")  # 强制全灰
    elif gray_mode == 0:
        gray = False
        if im.mode == "L":
            im = im.convert("RGB")  # 强制全彩
    else:  # 自动
        gray = im.mode == "L" or is_grayscale(im, gray_delta, gray_frac)
        if gray and im.mode != "L":
            im = im.convert("L")
    if fmt == "jpeg":
        save_jpeg(im, path, quality, subsampling)
    else:
        save_png(im, path)
    return gray


#  拼合 + 旋转

def assemble_page(slice_paths: list[Path], kind: str) -> Image.Image:
    """把切片按显示序从左到右拼成完整图，再整图旋转回正。"""
    parts = [Image.open(p).convert("RGB") for p in slice_paths]
    heights = {im.height for im in parts}
    if len(heights) != 1:
        raise ValueError(f"切片高度不一致 {heights}，文件: {[p.name for p in slice_paths]}")
    width = sum(im.width for im in parts)
    height = heights.pop()

    canvas = Image.new("RGB", (width, height), "white")
    x = 0
    for im in parts:
        canvas.paste(im, (x, 0))
        x += im.width

    if kind == "flip":
        return canvas.transpose(Image.Transpose.ROTATE_180)
    if kind == "rot90":
        # ROTATE_90 = 逆时针 90°（整图旋转回正）
        return canvas.transpose(Image.Transpose.ROTATE_90)
    raise ValueError(f"未知类型: {kind}")


#  PDF 收尾（写书签）

def write_pdf(base_pdf: Path, out_pdf: Path, toc_lines: list) -> None:
    """把 img2pdf 基础 PDF 转正：有书签则 PyMuPDF set_toc 写 Outlines（图像流原样保留），无书签直接改名。"""
    if not toc_lines:
        base_pdf.replace(out_pdf)
        return
    import pymupdf  # 仅需加书签时引入

    doc = pymupdf.open(base_pdf)
    doc.set_toc(toc_lines)
    doc.save(out_pdf, garbage=0, deflate=False)  # 不重压图片流，保持无损原字节
    doc.close()
    base_pdf.unlink(missing_ok=True)
    print(f"[完成] 书签写入: {len(toc_lines)} 条")


#  命名（按实际参数）

def product_names(bid: str, fmt: str, gray_mode: int,
                  explicit_fmt: bool, explicit_gray: bool, ntoc: bool) -> tuple[str, str]:
    """按实参生成 PDF 基名与页面图目录名（顺序: 格式→灰度→ntoc；纯默认仅保留 bid）。

    ntoc = 实际无目录（显式 --no-toc 或目录获取失败），此时自动追加 ntoc 后缀。
    """
    fmt_tok = "jpg" if fmt == "jpeg" else "png"
    gray_tok = gray_token(gray_mode)
    explicit = explicit_fmt or explicit_gray or ntoc
    pdf_toks: list[str] = []
    if explicit:
        pdf_toks.append(fmt_tok)
        if explicit_gray:
            pdf_toks.append(gray_tok)
        if ntoc:
            pdf_toks.append("ntoc")
    pdf_base = bid if not pdf_toks else f"{bid}_{'_'.join(pdf_toks)}"

    dir_toks = [fmt_tok]
    if explicit_gray:
        dir_toks.append(gray_tok)
    if ntoc:
        dir_toks.append("ntoc")
    dir_name = f"{bid}_{'_'.join(dir_toks)}"
    return pdf_base, dir_name


#  主流程

def parse_pages_spec(spec: str | None, total: int) -> list[int]:
    """'1-3,5,10-12' -> [1,2,3,5,10,11,12]；None -> 1..total"""
    if not spec:
        return list(range(1, total + 1))
    pages: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        m = re.fullmatch(r"(\d+)(?:-(\d+))?", part)
        if not m:
            raise SystemExit(f"非法页范围片段: {part!r}")
        a = int(m.group(1))
        b = int(m.group(2)) if m.group(2) else a
        if a > b:
            raise SystemExit(f"页范围反向: {part!r}")
        pages.extend(range(a, b + 1))
    return sorted(set(pages))


def main() -> None:
    ap = argparse.ArgumentParser(description="文泉书局切片重组还原 PDF（自动目录+按参数命名）")
    ap.add_argument("bid_zip", help="油猴导出的切片压缩包，如 3224451.zip")
    ap.add_argument("-o", "--out", help="输出 PDF 路径（默认 <bid>/<bid>[后缀].pdf）")
    ap.add_argument("--png-dir", help="整页图输出目录（默认 <bid>/<参数名>/）")
    ap.add_argument("--reextract", action="store_true", help="强制重新解压（默认已解压则跳过）")
    ap.add_argument("--pages", help="只处理指定页，如 1-3,5")
    ap.add_argument("--preview", help="只重建这些页并存 PNG（便于目检方向/拼接），如 1,2,291")
    ap.add_argument("--img-format", choices=("png", "jpeg"), default=None,
                    help="整页图/PDF 内嵌编码: jpeg(默认, 非 JPEG 自动转 JPEG) | png(真无损)")
    ap.add_argument("--jpeg-quality", type=int, default=95, help="jpeg 质量（默认 95）")
    ap.add_argument("--jpeg-subsampling", type=int, default=0,
                    help="jpeg 色度抽样: 0=4:4:4 不抽样(默认, 文字最清晰) / 1=4:2:2 / 2=4:2:0")
    ap.add_argument("--gray-mode", type=int, default=None,
                    help="灰度模式: 1=全灰(gray) | 0=全彩(fulc) | 其他/缺省=自动(auto, 默认)")
    ap.add_argument("--gray-delta", type=int, default=48,
                    help="自动判据: 色差Δ=|R-G|+|G-B| 超此值计为彩像素（默认 48）")
    ap.add_argument("--gray-frac", type=float, default=0.01,
                    help="自动判据: 彩像素占比低于此值(0~1)才转灰度（默认 0.01 = 1%）")
    ap.add_argument("--dpi", type=float, default=300.0, help="PDF 像素→物理尺寸比例 dpi（默认 300）")
    toc = ap.add_mutually_exclusive_group()
    toc.add_argument("--no-toc", action="store_true", help="不获取/不添加目录书签")
    toc.add_argument("--toc-json", metavar="PATH",
                     help="从指定本地 JSON 读目录（默认本地缓存 <bid>_toc.json，无则接口抓取并缓存）")
    toc.add_argument("--toc-cookie", metavar="STR",
                     help="请求目录接口时携带 Cookie（匿名通常已可用，仅需登录书时使用）")
    args = ap.parse_args()

    src = Path(args.bid_zip).resolve()
    zip_nodes = None
    if src.is_dir():  # 兼容：直接传已解压的工作目录
        work_dir = src
    elif src.is_file():
        work_dir = src.parent / (zip_bid(src) or src.stem)  # 工作目录名 = bid
        zip_nodes = read_zip_toc(src)  # 解压前先取 zip 内目录（最高优先）
        extract_zip(src, work_dir, args.reextract)
    else:
        raise SystemExit(f"输入不存在: {src}")
    work_dir.mkdir(parents=True, exist_ok=True)

    csv_path, img_dir = locate_source(work_dir)
    bid = csv_path.stem
    if src.is_file() and bid != src.stem:
        print(f"[警告] csv 名({bid}) 与压缩包名({src.stem}) 不一致，产物按 csv 名命名",
              file=sys.stderr)

    table = parse_csv(csv_path)
    total_pages = len(table)
    print(f"[信息] 共 {total_pages} 页（{bid}）")

    # 解析有效参数（None = 未显式传参，走默认并影响命名）
    fmt = args.img_format if args.img_format else "jpeg"
    gray_mode = args.gray_mode if args.gray_mode is not None else 2
    explicit_fmt = args.img_format is not None
    explicit_gray = args.gray_mode is not None

    if args.preview:
        pages = parse_pages_spec(args.preview, total_pages)
        png_dir = Path(args.png_dir) if args.png_dir else work_dir / "preview"
        png_dir.mkdir(parents=True, exist_ok=True)
        for p in pages:
            kind = table[p]
            page_im = assemble_page(page_slices(img_dir, p), kind)
            out_png = png_dir / f"p{p:04d}_{kind}.png"
            save_png(page_im, out_png)
            print(f"[预览] p{p:04d}  {kind:5s}  {page_im.width}x{page_im.height}  ->  {out_png}")
        return

    pages = parse_pages_spec(args.pages, total_pages)
    if max(pages) > total_pages:
        raise SystemExit(f"页码超界: {max(pages)} > {total_pages}")

    # ---- 目录（书签）优先于命名：无目录时自动追加 ntoc 后缀 ----
    toc_lines = resolve_toc(args, work_dir, bid, total_pages, pages, zip_nodes)

    pdf_base, dir_name = product_names(bid, fmt, gray_mode,
                                       explicit_fmt, explicit_gray, not toc_lines)
    page_dir = Path(args.png_dir) if args.png_dir else work_dir / dir_name
    out_pdf = Path(args.out) if args.out else work_dir / f"{pdf_base}.pdf"
    base_pdf = out_pdf.with_name(out_pdf.stem + ".base" + out_pdf.suffix)
    page_ext = ".jpg" if fmt == "jpeg" else ".png"

    # ---- 逐页拼合→判断灰度→直接落盘 JPEG/PNG ----
    page_dir.mkdir(parents=True, exist_ok=True)
    import img2pdf  # 仅完整导出时需要

    page_images: list[Path] = []
    gray_count = 0
    for i, p in enumerate(pages, 1):
        kind = table[p]
        page_im = assemble_page(page_slices(img_dir, p), kind)
        img_path = page_dir / f"p{p:04d}{page_ext}"
        if save_page_image(page_im, img_path, fmt,
                           quality=args.jpeg_quality, subsampling=args.jpeg_subsampling,
                           gray_mode=gray_mode,
                           gray_delta=args.gray_delta, gray_frac=args.gray_frac):
            gray_count += 1
        page_images.append(img_path)
        page_im.close()
        print(f"[{i:3d}/{len(pages)}] 第 {p} 页 {kind:5s} {page_im.width}x{page_im.height}")

    # ---- img2pdf 直嵌 → PyMuPDF 写书签 ----
    layout = img2pdf.get_fixed_dpi_layout_fun((args.dpi, args.dpi))
    with open(base_pdf, "wb") as f:
        f.write(img2pdf.convert([str(x) for x in page_images], layout_fun=layout))
    write_pdf(base_pdf, out_pdf, toc_lines)

    tag = "含书签" if toc_lines else "无书签"
    if fmt == "jpeg":
        codec = (f"jpeg q{args.jpeg_quality}(灰度 {gray_count}页/彩色 "
                 f"{len(page_images) - gray_count}页)" if gray_count
                 else f"jpeg q{args.jpeg_quality}")
    elif gray_count:
        codec = f"png(自动灰度 {gray_count}页 / 彩色 {len(page_images)-gray_count}页)"
    else:
        codec = "png 全彩"
    print(f"[完成] PDF: {out_pdf}  ({len(page_images)} 页, dpi={args.dpi:g}, {codec}, {tag})")
    print(f"[完成] 整页图目录: {page_dir}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
