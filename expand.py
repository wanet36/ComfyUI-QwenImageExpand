"""Qwen 图像扩展（扩边 / outpainting 预处理）核心逻辑。

纯 PIL 实现，不依赖 ComfyUI / torch，方便单独测试。

约定：
- pads = 原图四条边外侧新增区域的宽度（像素），键为 left / top / right / bottom
- 输出画布尺寸 = 原图尺寸 + 对应方向两边的 pads
- 扩展区域统一填充灰度 fill（默认 128，即 rgb(128,128,128)），作为 Qwen-Image-Edit 的扩图输入
"""

from __future__ import annotations

import json
import math
import os
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

MAX_PAD = 8192
MAX_CANVAS_EDGE = 16384
DEFAULT_FILL = 128
DEFAULT_ALIGN = 32  # Qwen-Image-2.1-Outpaint-LoRA 训练在 /32 网格上
MIN_SCALE = 0.05
MAX_SCALE = 8.0
PAD_KEYS = ("left", "top", "right", "bottom")
PAD_LABELS = {"left": "左", "top": "上", "right": "右", "bottom": "下"}


def _int(value: Any, default: int = 0, lo: Optional[int] = None, hi: Optional[int] = None) -> int:
    try:
        if value is None or value == "":
            raise ValueError
        out = int(round(float(value)))
    except (TypeError, ValueError):
        out = default
    if lo is not None:
        out = max(lo, out)
    if hi is not None:
        out = min(hi, out)
    return out


def _round_half_up(value: float) -> int:
    """与前端 Math.round 对齐（Python 的 round 是银行家舍入）。"""
    return int(math.floor(float(value) + 0.5))


def _f(value: Any, default: float = 1.0, lo: float = MIN_SCALE, hi: float = MAX_SCALE) -> float:
    try:
        if value is None or value == "":
            raise ValueError
        out = float(value)
    except (TypeError, ValueError):
        out = default
    if not math.isfinite(out):
        out = default
    return min(hi, max(lo, out))


def scaled_size(width: int, height: int, scale: float = 1.0) -> Tuple[int, int]:
    """原图按 scale 缩放后的像素尺寸（与前端同一套取整规则）。"""
    s = _f(scale)
    return (
        max(1, _round_half_up(max(1, int(width)) * s)),
        max(1, _round_half_up(max(1, int(height)) * s)),
    )


def normalize_pads(raw: Any) -> Dict[str, int]:
    """把各种形状的输入规整成 {left,top,right,bottom} 非负整数。"""
    data = raw if isinstance(raw, dict) else {}
    nested = data.get("pads")
    if isinstance(nested, dict):
        data = nested
    return {k: _int(data.get(k, data.get(f"pad_{k}")), 0, 0, MAX_PAD) for k in PAD_KEYS}


def empty_state() -> Dict[str, Any]:
    return {
        "image": "",
        "width": 0,
        "height": 0,
        "scale": 1.0,
        "fill": DEFAULT_FILL,
        "align": DEFAULT_ALIGN,
        "pads": {k: 0 for k in PAD_KEYS},
    }


def parse_state(raw: Any) -> Dict[str, Any]:
    """解析前端写入的 expand_json；非法输入一律降级为空状态，不抛异常。"""
    data: Any = raw
    if isinstance(raw, str):
        text = raw.strip()
        data = None
        if text:
            try:
                data = json.loads(text)
            except (ValueError, TypeError):
                data = None
    if not isinstance(data, dict):
        return empty_state()

    image = str(data.get("image") or data.get("name") or "").strip().replace("\\", "/")
    return {
        "image": image,
        "width": _int(data.get("width"), 0, 0, MAX_CANVAS_EDGE),
        "height": _int(data.get("height"), 0, 0, MAX_CANVAS_EDGE),
        "scale": _f(data.get("scale"), 1.0),
        "fill": _int(data.get("fill"), DEFAULT_FILL, 0, 255),
        "align": _int(data.get("align"), DEFAULT_ALIGN, 1, 512),
        "pads": normalize_pads(data),
    }


def clamp_pads(
    width: int, height: int, pads: Dict[str, int], max_edge: int = MAX_CANVAS_EDGE
) -> Tuple[Dict[str, int], List[str]]:
    """保证输出画布不超过 max_edge：超限时按 右→左 / 下→上 的顺序回收。"""
    p = {k: max(0, int(pads.get(k, 0))) for k in PAD_KEYS}
    warnings: List[str] = []

    def shrink(total: int, first: str, second: str, axis: str) -> None:
        over = total - max_edge
        if over <= 0:
            return
        cut = 0
        for key in (first, second):
            if over <= 0:
                break
            take = min(over, p[key])
            p[key] -= take
            over -= take
            cut += take
        warnings.append(f"输出{axis}超出 {max_edge}px 上限，已回收 {cut}px 边距")

    shrink(width + p["left"] + p["right"], "right", "left", "宽度")
    shrink(height + p["top"] + p["bottom"], "bottom", "top", "高度")
    return p, warnings


def canvas_size(width: int, height: int, pads: Dict[str, int]) -> Tuple[int, int]:
    return (
        max(1, int(width)) + pads["left"] + pads["right"],
        max(1, int(height)) + pads["top"] + pads["bottom"],
    )


def resolve_source_path(name: str, base_dir: str) -> str:
    """把上传文件名解析成 input 目录下的绝对路径，并阻止路径穿越。"""
    clean = str(name).replace("\\", "/").strip()
    if clean.startswith("[input]"):
        clean = clean[len("[input]"):]
    clean = clean.lstrip("/")
    if not clean:
        raise ValueError("图片文件名为空")

    base = os.path.abspath(base_dir)
    path = os.path.abspath(os.path.join(base, clean))
    try:
        if os.path.commonpath([base, path]) != base:
            raise ValueError(f"图片路径越界: {name}")
    except ValueError:
        raise ValueError(f"图片路径非法: {name}")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"找不到图片文件: {name}")
    return path


def load_source(name: str, base_dir: str, fill: int = DEFAULT_FILL) -> Image.Image:
    """读取原图并转成 RGB（带 alpha 的图先压到灰度底上）。"""
    path = resolve_source_path(name, base_dir)
    with Image.open(path) as raw:
        raw.load()
        img = raw.convert("RGBA")
    if img.getchannel("A").getextrema()[0] < 255:
        bg = Image.new("RGB", img.size, (fill, fill, fill))
        bg.paste(img, (0, 0), img)
        return bg
    return img.convert("RGB")


def compose(
    image: Image.Image, pads: Dict[str, int], fill: int = DEFAULT_FILL, scale: float = 1.0
) -> Tuple[Image.Image, Dict[str, Any]]:
    """先把原图按 scale 缩放，再贴到灰度画布的 (left, top)，返回 (RGB 画布, 信息字典)。

    pads 是「缩放后」原图外侧新增的像素量，所以画布 = round(原图*scale) + 两侧 pads。
    """
    fill = _int(fill, DEFAULT_FILL, 0, 255)
    src = image if image.mode == "RGB" else image.convert("RGB")
    warnings: List[str] = []

    sw, sh = scaled_size(src.width, src.height, scale)
    if (sw, sh) != (src.width, src.height):
        src = src.resize((sw, sh), Image.LANCZOS)
        if sw * sh > 4096 * 4096:
            warnings.append(f"缩放后尺寸 {sw}x{sh} 很大，注意显存")

    safe_pads, pad_warnings = clamp_pads(sw, sh, pads)
    warnings.extend(pad_warnings)

    cw, ch = canvas_size(sw, sh, safe_pads)
    out_w, out_h = min(cw, MAX_CANVAS_EDGE), min(ch, MAX_CANVAS_EDGE)
    if (out_w, out_h) != (cw, ch):
        warnings.append(f"输出尺寸被截断为 {out_w}x{out_h}")

    canvas = Image.new("RGB", (out_w, out_h), (fill, fill, fill))
    canvas.paste(src, (safe_pads["left"], safe_pads["top"]))
    return canvas, {
        "pads": safe_pads,
        "canvas_width": out_w,
        "canvas_height": out_h,
        "source_width": src.width,
        "source_height": src.height,
        "scale": _f(scale),
        "warnings": warnings,
    }


def pads_summary(pads: Dict[str, int]) -> str:
    return " ".join(f"{PAD_LABELS[k]}{int(pads.get(k, 0))}" for k in PAD_KEYS)
