"""真机 API 冒烟：向运行中的 ComfyUI 提交 QwenImageExpand → SaveImage，校验输出尺寸与灰度。

用法：python tests/api_smoke.py
（需要 ComfyUI 在 127.0.0.1:8188 运行，且本插件已装到 custom_nodes；
  ComfyUI 根目录默认 D:/AI/ComfyUI_windows_portable-G312/ComfyUI，可用环境变量 COMFY_ROOT 覆盖）
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
import uuid

from PIL import Image, ImageDraw

COMFY = "http://127.0.0.1:8188"
ROOT = os.environ.get("COMFY_ROOT", "D:/AI/ComfyUI_windows_portable-G312/ComfyUI")
INPUT_SUB = "qwen_image_expand"
SRC_W, SRC_H = 300, 200
PADS = {"left": 32, "top": 0, "right": 96, "bottom": 16}


def post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        COMFY + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"{path} → HTTP {exc.code}: {exc.read().decode()[:500]}") from exc


def get(path: str) -> dict:
    with urllib.request.urlopen(COMFY + path, timeout=30) as resp:
        return json.loads(resp.read())


def main() -> int:
    os.makedirs(os.path.join(ROOT, "input", INPUT_SUB), exist_ok=True)
    src = Image.new("RGB", (SRC_W, SRC_H), (30, 90, 200))
    d = ImageDraw.Draw(src)
    d.rectangle([0, 0, 149, 99], fill=(230, 80, 60))
    d.rectangle([200, 140, 299, 199], fill=(20, 180, 90))
    src.save(os.path.join(ROOT, "input", INPUT_SUB, "api_test.png"))

    state = {
        "version": 1,
        "image": f"{INPUT_SUB}/api_test.png",
        "width": SRC_W,
        "height": SRC_H,
        "fill": 128,
        "align": 16,
        "pads": PADS,
    }
    prompt = {
        "1": {
            "class_type": "QwenImageExpand",
            "inputs": {
                "pad_left": PADS["left"],
                "pad_top": PADS["top"],
                "pad_right": PADS["right"],
                "pad_bottom": PADS["bottom"],
                "fill_gray": 128,
                "expand_json": json.dumps(state, ensure_ascii=False),
                "src_scale": 1.0,
            },
        },
        "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0], "filename_prefix": "qwen_expand_api"}},
    }
    run(prompt, SRC_W + PADS["left"] + PADS["right"], SRC_H + PADS["top"] + PADS["bottom"])

    # 第二个用例：src_scale = 0.5，先缩后扩
    prompt["1"]["inputs"]["src_scale"] = 0.5
    hw = (SRC_W + 1) // 2
    hh = (SRC_H + 1) // 2
    run(prompt, hw + PADS["left"] + PADS["right"], hh + PADS["top"] + PADS["bottom"], scale=0.5)
    print("✅ API 冒烟通过：尺寸、灰度填充、原图对位、src_scale 缩放全部正确")
    return 0


def run(prompt: dict, exp_w: int, exp_h: int, scale: float = 1.0) -> None:
    res = post("/prompt", {"prompt": prompt, "client_id": uuid.uuid4().hex})
    pid = res["prompt_id"]
    print("prompt_id:", pid)

    for _ in range(60):
        time.sleep(1)
        hist = get(f"/history/{pid}")
        if pid in hist:
            entry = hist[pid]
            status = entry.get("status", {})
            assert status.get("status_str") == "success", f"执行失败: {status}"
            images = entry["outputs"]["2"]["images"]
            print("outputs:", images)
            break
    else:
        raise TimeoutError("等待执行结果超时")

    out_path = os.path.join(ROOT, "output", images[0]["subfolder"], images[0]["filename"])
    with Image.open(out_path) as im:
        im.load()
        tag = f"scale={scale}" if scale != 1.0 else "scale=1"
        print(f"[{tag}] 输出尺寸 {im.size}，期望 ({exp_w}, {exp_h})")
        assert im.size == (exp_w, exp_h), "输出尺寸不对"
        assert im.getpixel((0, 0)) == (128, 128, 128), f"左上灰边异常 {im.getpixel((0, 0))}"
        assert im.getpixel((exp_w - 1, exp_h - 1)) == (128, 128, 128), f"右下灰边异常 {im.getpixel((exp_w - 1, exp_h - 1))}"
        assert im.getpixel((PADS["left"], PADS["top"])) == (230, 80, 60), "原图左上角必对位"
        name = "api_output.png" if scale == 1.0 else f"api_output_scale{scale}.png"
        im.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", name))


if __name__ == "__main__":
    raise SystemExit(main())
