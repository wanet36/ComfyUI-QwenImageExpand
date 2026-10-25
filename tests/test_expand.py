"""扩边核心逻辑 + 节点冒烟测试。

覆盖：画布尺寸推导、灰度填充 rgb(128,128,128)、原图像素不被改动、
零边距时与原图完全一致、JSON 容错、路径穿越拦截、节点端到端张量形状。

运行：python tests/test_expand.py
产物：tests/out/*.png
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import types

import numpy as np
from PIL import Image, ImageDraw

PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
sys.path.insert(0, PKG_DIR)

import expand as core  # noqa: E402


def load_nodes():
    """加载 nodes.py（它依赖 ComfyUI 的 torch / folder_paths，这里做最小桩）。"""
    if "torch" not in sys.modules:
        fake = types.ModuleType("torch")

        class _Tensor:
            def __init__(self, arr):
                self.arr = arr

            def unsqueeze(self, dim):
                return _Tensor(np.expand_dims(self.arr, dim))

        fake.from_numpy = lambda a: _Tensor(a)
        sys.modules["torch"] = fake

    pkg = types.ModuleType("qie_pkg")
    pkg.__path__ = [PKG_DIR]
    sys.modules["qie_pkg"] = pkg
    spec = importlib.util.spec_from_file_location("qie_pkg.nodes", os.path.join(PKG_DIR, "nodes.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["qie_pkg.nodes"] = mod
    spec.loader.exec_module(mod)
    return mod


def make_asset() -> Image.Image:
    os.makedirs(OUT_DIR, exist_ok=True)
    img = Image.new("RGB", (200, 120), (40, 120, 200))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 99, 59], fill=(230, 80, 60))
    d.rectangle([150, 90, 199, 119], fill=(20, 180, 90))
    img.save(os.path.join(OUT_DIR, "source.png"))
    return img


def px(img, x, y):
    return tuple(int(v) for v in img.getpixel((x, y)))


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    src = make_asset()
    gray = (128, 128, 128)

    # 1) 尺寸推导
    assert core.canvas_size(200, 120, {"left": 0, "top": 0, "right": 64, "bottom": 0}) == (264, 120)
    assert core.canvas_size(200, 120, {"left": 10, "top": 20, "right": 30, "bottom": 40}) == (240, 180)
    print("✓ 画布尺寸 = 原图 + 四边边距")

    # 2) 四边扩展：延伸区域必须是 rgb(128,128,128)，原图像素保持原样
    pads = {"left": 16, "top": 24, "right": 40, "bottom": 8}
    canvas, info = core.compose(src, pads, 128)
    canvas.save(os.path.join(OUT_DIR, "expand_all_sides.png"))
    assert canvas.size == (200 + 56, 120 + 32), canvas.size
    assert info["canvas_width"] == canvas.width and info["canvas_height"] == canvas.height
    assert not info["warnings"], info["warnings"]

    assert px(canvas, 0, 0) == gray, f"左上角扩展区应为 128 灰，实际 {px(canvas, 0, 0)}"
    assert px(canvas, canvas.width - 1, canvas.height - 1) == gray, "右下角扩展区应为 128 灰"
    assert px(canvas, 16 + 50, 24 + 20) == px(src, 50, 20) == (230, 80, 60), "原图像素必须原样保留"
    assert px(canvas, 16 + 180, 24 + 110) == px(src, 180, 110) == (20, 180, 90), "原图右下角像素必对位"
    assert px(canvas, 16, 24) == px(src, 0, 0), "原图左上角像素必对位"
    print("✓ 扩展区域填充 rgb(128,128,128)，原图像素零改动（(16,24) 处精确对位）")

    # 3) 只向右扩：左边界应与原图左边界重合
    right_only, _ = core.compose(src, {"left": 0, "top": 0, "right": 64, "bottom": 0}, 128)
    right_only.save(os.path.join(OUT_DIR, "expand_right_64.png"))
    assert right_only.size == (264, 120)
    assert px(right_only, 0, 0) == px(src, 0, 0), "左边界未扩展时不应出现灰边"
    assert px(right_only, 263, 60) == gray, "右侧新增 64px 应全为灰"
    print("✓ 单边扩展：新增部分 64px 全灰，其余不动")

    # 3.5) 原图缩放：先缩放再扩边
    half, info_half = core.compose(src, {"left": 10, "top": 0, "right": 10, "bottom": 0}, 128, 0.5)
    half.save(os.path.join(OUT_DIR, "expand_scaled_50.png"))
    assert half.size == (100 + 20, 60), half.size
    assert info_half["scale"] == 0.5 and info_half["source_width"] == 100, info_half
    assert px(half, 0, 0) == gray, "缩放后扩展区仍是 128 灰"
    assert px(half, 10, 10) != gray, "缩放后的原图应贴在 (10,0) 处"
    assert core.scaled_size(400, 300, 0.33) == (132, 99), core.scaled_size(400, 300, 0.33)
    assert core.scaled_size(401, 301, 0.5) == (201, 151), "半像素向上取整（与前端 Math.round 一致）"
    assert core.scaled_size(400, 300, 0) == (20, 15), "scale 下限 0.05"
    print(f"✓ 原图缩放：50% → {half.size}（含边距），取整规则与前端一致")

    # 4) 零边距 = 原图
    same, _ = core.compose(src, {"left": 0, "top": 0, "right": 0, "bottom": 0}, 128)
    assert same.size == src.size
    assert np.array_equal(np.asarray(same), np.asarray(src)), "零边距输出必须与原图逐像素一致"
    print("✓ 零边距时输出与原图逐像素一致")

    # 5) 自定义灰度 + RGB 三通道一致
    dark, _ = core.compose(src, {"left": 8, "top": 0, "right": 0, "bottom": 0}, 33)
    assert px(dark, 0, 0) == (33, 33, 33), px(dark, 0, 0)
    print("✓ 填充灰度可调（33,33,33）")

    # 6) 带透明通道的 PNG 先压到灰度底上，不出现黑边
    rgba = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
    ImageDraw.Draw(rgba).ellipse([0, 0, 39, 39], fill=(200, 40, 40, 255))
    flat, _ = core.compose(rgba, {"left": 4, "top": 4, "right": 4, "bottom": 4}, 128)
    assert px(flat, 0, 0) == gray, "透明区域应透出灰度底而不是黑"
    print("✓ 带 alpha 的图片压在灰度底上，无黑边")

    # 7) parse_state 容错
    st = core.parse_state(json.dumps({"image": "a/b.png", "width": 512, "height": 256,
                                      "fill": 200, "align": 32, "pads": {"left": 8, "right": 16}}))
    assert st["image"] == "a/b.png" and st["fill"] == 200 and st["pads"]["left"] == 8, st
    assert core.parse_state("not json")["image"] == ""
    assert core.parse_state("")["pads"] == {"left": 0, "top": 0, "right": 0, "bottom": 0}
    assert core.parse_state({"image": "x.png", "left": 12})["pads"]["left"] == 12, "扁平 pads 也要认"
    assert core.parse_state({"image": "x.png", "scale": 0.4})["scale"] == 0.4
    assert core.parse_state({"image": "x.png", "scale": 0})["scale"] == core.MIN_SCALE, "scale 下限 0.05"
    assert core.parse_state({"image": "x.png", "scale": 99})["scale"] == core.MAX_SCALE, "scale 上限 8"
    print("✓ expand_json 容错：坏 JSON / 空值 / 扁平 pads 均不崩")

    # 8) 路径穿越拦截
    try:
        core.resolve_source_path("../../secret.png", OUT_DIR)
        raise AssertionError("路径穿越未被拦截")
    except ValueError as exc:
        assert "越界" in str(exc) or "非法" in str(exc), exc
    try:
        core.resolve_source_path("missing.png", OUT_DIR)
        raise AssertionError("缺图未报错")
    except FileNotFoundError:
        pass
    print("✓ 路径穿越 / 缺图均被拦截")

    # 9) 超限回收
    pads_big, warns = core.clamp_pads(4000, 4000, {"left": 8000, "top": 0, "right": 8000, "bottom": 0})
    assert pads_big["right"] + pads_big["left"] <= core.MAX_CANVAS_EDGE - 4000, pads_big
    assert warns, "超限应给出警告"
    print(f"✓ 画布超限自动回收边距：{pads_big}")

    # 10) 节点端到端（torch 用桩替代）
    nodes = load_nodes()
    node = nodes.QwenImageExpand()
    types_ = node.INPUT_TYPES()["required"]
    for key in ("pad_left", "pad_top", "pad_right", "pad_bottom", "fill_gray", "expand_json"):
        assert key in types_, key
    assert nodes.NODE_CLASS_MAPPINGS["QwenImageExpand"] is nodes.QwenImageExpand

    cwd = os.getcwd()
    os.chdir(OUT_DIR)  # folder_paths 缺失时后端以 cwd 为 input 根目录
    try:
        state = json.dumps({"version": 1, "image": "source.png", "width": 200, "height": 120,
                            "fill": 128, "align": 16, "pads": {}})
        out = node.expand(0, 0, 0, 0, 128, state)[0].arr
        assert out.shape == (1, 120, 200, 3), out.shape
        assert out.dtype == np.float32 and 0.0 <= out.min() and out.max() <= 1.0

        out2 = node.expand(24, 0, 40, 8, 128, state)[0].arr
        assert out2.shape == (1, 128, 264, 3), out2.shape
        assert np.allclose(out2[0, 0, 0], 128 / 255.0), out2[0, 0, 0]
        assert np.allclose(out2[0, 40, 100], out[0, 40, 76]), "扩展后原图位置应保持"

        # 原图缩放参数（第 7 个输入）
        out3 = node.expand(0, 0, 0, 0, 128, state, 0.5)[0].arr
        assert out3.shape == (1, 60, 100, 3), out3.shape

        # 图片丢失 → 降级成纯灰画布，不崩
        bad = json.dumps({"image": "gone.png", "width": 64, "height": 48, "pads": {}})
        grey = node.expand(16, 0, 0, 0, 128, bad)[0].arr
        assert grey.shape == (1, 48, 80, 3), grey.shape
    finally:
        os.chdir(cwd)
    print("✓ 节点端到端：张量形状 / 数值范围正确，缺图降级为灰度画布")

    print("\n✅ all expand checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
