"""ComfyUI 节点：Qwen 图像扩展（扩边 / outpainting 预处理）。

节点只做一件事：把导入的原图放进一张更大的画布，画布其余部分填充灰度
rgb(128,128,128)，输出 IMAGE 交给 Qwen-Image-Edit 之类模型做扩图。
"""

from __future__ import annotations

import json
from typing import Any, Dict, Tuple

import numpy as np
import torch
from PIL import Image

try:  # 在 ComfyUI 运行时可用；单独跑测试时为 None
    import folder_paths
except ImportError:  # pragma: no cover
    folder_paths = None  # type: ignore[assignment]

from .expand import (
    DEFAULT_FILL,
    MAX_PAD,
    compose,
    empty_state,
    load_source,
    pads_summary,
    parse_state,
)

DEFAULT_STATE_JSON = json.dumps(empty_state(), ensure_ascii=False)
FALLBACK_SIZE = 1024


class QwenImageExpand:
    """灰度扩边节点：点击按钮打开编辑器，拖动矩形四条边向外扩展画布。"""

    @classmethod
    def INPUT_TYPES(cls) -> Dict[str, Any]:
        return {
            "required": {
                "pad_left": (
                    "INT",
                    {"default": 0, "min": 0, "max": MAX_PAD, "step": 1, "tooltip": "左侧扩展宽度（像素），填充灰度"},
                ),
                "pad_top": (
                    "INT",
                    {"default": 0, "min": 0, "max": MAX_PAD, "step": 1, "tooltip": "上方扩展高度（像素）"},
                ),
                "pad_right": (
                    "INT",
                    {"default": 0, "min": 0, "max": MAX_PAD, "step": 1, "tooltip": "右侧扩展宽度（像素）"},
                ),
                "pad_bottom": (
                    "INT",
                    {"default": 0, "min": 0, "max": MAX_PAD, "step": 1, "tooltip": "下方扩展高度（像素）"},
                ),
                "fill_gray": (
                    "INT",
                    {
                        "default": DEFAULT_FILL,
                        "min": 0,
                        "max": 255,
                        "step": 1,
                        "tooltip": "扩展区域的灰度值，默认 128 = rgb(128,128,128)",
                    },
                ),
                "expand_json": (
                    "STRING",
                    {
                        "default": DEFAULT_STATE_JSON,
                        "multiline": False,
                        "tooltip": "原图与编辑器状态（由编辑器自动维护，请勿手改）",
                    },
                ),
                # 新参数一律加在末尾：ComfyUI 的 widgets_values 是按位置读写的，
                # 插在中间会让老工作流的控件值整体错位。
                "src_scale": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.05,
                        "max": 8.0,
                        "step": 0.01,
                        "tooltip": "原图缩放倍数：先缩放再扩边（1.0 = 原尺寸；0.5 = 长宽减半）",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "expand"
    CATEGORY = "image/expand"
    DESCRIPTION = "Qwen 图像扩展：点击按钮打开编辑器，导入图片后向外拖动矩形边，延伸区域填充 rgb(128,128,128)"

    @classmethod
    def IS_CHANGED(cls, **kwargs: Any) -> float:
        # 上传的图片可能被同名覆盖，始终重新执行，避免命中旧缓存
        return float("nan")

    def expand(
        self,
        pad_left: int,
        pad_top: int,
        pad_right: int,
        pad_bottom: int,
        fill_gray: int,
        expand_json: str,
        src_scale: float = 1.0,
    ) -> Tuple[torch.Tensor]:
        state = parse_state(expand_json)
        pads = {"left": pad_left, "top": pad_top, "right": pad_right, "bottom": pad_bottom}

        # widget 为准；老工作流缺这个控件时回落到 JSON 里存的值
        try:
            scale = float(src_scale)
        except (TypeError, ValueError):
            scale = state["scale"]

        base_dir = ""
        if folder_paths is not None:
            try:
                base_dir = folder_paths.get_input_directory()
            except Exception as exc:  # pragma: no cover
                print(f"[QwenImageExpand] 无法定位 input 目录：{exc}")

        source = None
        if state["image"]:
            try:
                source = load_source(state["image"], base_dir or ".", fill_gray)
            except Exception as exc:  # noqa: BLE001 - 缺图时降级为纯灰画布
                print(f"[QwenImageExpand] 原图加载失败：{state['image']}（{exc}）")

        if source is None:
            w = state["width"] or FALLBACK_SIZE
            h = state["height"] or FALLBACK_SIZE
            source = Image.new("RGB", (max(1, w), max(1, h)), (int(fill_gray),) * 3)
            if not state["image"]:
                print("[QwenImageExpand] 还没有导入图片，输出灰度画布（请点击节点按钮打开编辑器）")

        canvas, info = compose(source, pads, fill_gray, scale)
        for msg in info["warnings"]:
            print(f"[QwenImageExpand] {msg}")

        scale_note = "" if abs(info["scale"] - 1.0) < 1e-6 else f"（缩放 {info['scale'] * 100:.1f}%）"
        print(
            f"[QwenImageExpand] 原图 {info['source_width']}x{info['source_height']}{scale_note}"
            f" → 输出 {info['canvas_width']}x{info['canvas_height']}"
            f"（{pads_summary(info['pads'])}，填充 {int(fill_gray)}）"
        )

        arr = np.asarray(canvas, dtype=np.float32) / 255.0
        return (torch.from_numpy(arr).unsqueeze(0),)


NODE_CLASS_MAPPINGS = {"QwenImageExpand": QwenImageExpand}
NODE_DISPLAY_NAME_MAPPINGS = {"QwenImageExpand": "Qwen 图像扩展 (Image Expand)"}

__all__ = [
    "QwenImageExpand",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
