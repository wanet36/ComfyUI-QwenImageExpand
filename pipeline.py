"""把「Qwen 2.1 图像扩展」整套工作流收成一个节点。

链路：扩边画布 → 加载 UNET/CLIP/VAE + Outpaint LoRA → TextEncodeQwenImage21 编码
     → KSampler 采样 → VAE 解码 → 输出 IMAGE（可选直接存盘）

实现原则：所有子步骤都调用 ComfyUI 上游的实现（nodes.UNETLoader / CLIPLoader / VAELoader /
LoraLoader、nodes.common_ksampler、comfy_extras.nodes_qwen.TextEncodeQwenImage21），
不复制算法，ComfyUI 升级后行为自动跟随。

模型权重按「文件名 + 参数」缓存在进程内：改 seed / prompt 不会重新加载 20GB 权重。
"""

from __future__ import annotations

import json
from typing import Any, Dict, Tuple

import numpy as np
import torch
from PIL import Image

import comfy.model_management as model_management
import comfy.samplers
import latent_preview
import folder_paths
import nodes as comfy_nodes

from comfy_extras.nodes_qwen import QwenImage21Cache, TextEncodeQwenImage21

from .expand import (
    DEFAULT_FILL,
    MAX_PAD,
    compose,
    empty_state,
    load_source,
    pads_summary,
    parse_state,
)

DEFAULT_PROMPT = (
    "Outpaint the image: replace the solid gray areas with a seamless continuation of the scene, "
    "keeping the existing picture unchanged."
)
DEFAULT_NEGATIVE = (
    "artifacts, gpt-image, washed-out colors, low quality, low resolution, AI slop, deviantart, "
    "sloppy lines, rough sketch, blurry, indistinct, missing fingers, badly drawn hands, "
    "wrong number of fingers"
)
DEFAULT_STATE_JSON = json.dumps(empty_state(), ensure_ascii=False)
NO_LORA = "无（不加载）"

# 模型缓存：{key: (model, clip, vae)}，只保留一份，换模型时先腾显存
_MODEL_CACHE: Dict[tuple, Tuple[Any, Any, Any]] = {}


def _flush_models() -> None:
    if not _MODEL_CACHE:
        return
    _MODEL_CACHE.clear()
    model_management.soft_empty_cache()


def _load_models(
    unet_name: str,
    clip_name: str,
    vae_name: str,
    lora_name: str,
    strength_model: float,
) -> Tuple[Any, Any, Any]:
    key = (unet_name, clip_name, vae_name, lora_name, round(float(strength_model), 4))
    hit = _MODEL_CACHE.get(key)
    if hit is not None:
        print("[Qwen21Outpaint] 复用已加载的模型")
        return hit

    _flush_models()
    print(f"[Qwen21Outpaint] 加载模型：{unet_name} + {clip_name} + {vae_name}")
    model = comfy_nodes.UNETLoader().load_unet(unet_name, "default")[0]
    clip = comfy_nodes.CLIPLoader().load_clip(clip_name, "qwen_image", "default")[0]
    vae = comfy_nodes.VAELoader().load_vae(vae_name)[0]

    if lora_name and lora_name not in (NO_LORA, "None", "none"):
        print(f"[Qwen21Outpaint] 应用 LoRA：{lora_name}（强度 {strength_model}）")
        model, clip = comfy_nodes.LoraLoader().load_lora(model, clip, lora_name, strength_model, strength_model)

    _MODEL_CACHE[key] = (model, clip, vae)
    return model, clip, vae


class Qwen21Outpaint:
    """单节点版 Qwen 2.1 扩图：点按钮编辑画布，运行时自动跑完整条链路。"""

    @classmethod
    def INPUT_TYPES(cls) -> Dict[str, Any]:
        return {
            "required": {
                "unet_name": (
                    folder_paths.get_filename_list("diffusion_models"),
                    {"tooltip": "Qwen Image 2.1 主模型（diffusion_models 目录）"},
                ),
                "clip_name": (
                    folder_paths.get_filename_list("text_encoders"),
                    {"tooltip": "Qwen3-VL 文本/视觉编码器"},
                ),
                "vae_name": (
                    folder_paths.get_filename_list("vae"),
                    {"tooltip": "Qwen Image 2.1 VAE（解码出 RGBA）"},
                ),
                "lora_name": (
                    [NO_LORA] + folder_paths.get_filename_list("loras"),
                    {"default": NO_LORA, "tooltip": "扩图 LoRA（如 qwen-image-2.1-outpaint-v2）"},
                ),
                "strength_model": (
                    "FLOAT",
                    {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.01, "tooltip": "LoRA 强度（model/clip 同一值）"},
                ),
                "prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": DEFAULT_PROMPT,
                        "tooltip": "第一句必须是 LoRA 触发句，后面可跟 Scene: 描述",
                    },
                ),
                "negative_prompt": (
                    "STRING",
                    {"multiline": True, "default": DEFAULT_NEGATIVE, "tooltip": "CFG=1 时基本无效，留着备用"},
                ),
                "seed": (
                    "INT",
                    {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True},
                ),
                "steps": (
                    "INT",
                    {"default": 8, "min": 1, "max": 200, "step": 1, "tooltip": "turbo 模型 4~8，非 turbo 约 25"},
                ),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.01}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "simple"}),
                "resolution": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 4096,
                        "step": 32,
                        "tooltip": "参考图缩放目标：0 = 用画布原尺寸（推荐）；填 1024 会把参考图缩到约 1024×1024",
                    },
                ),
                "pad_left": ("INT", {"default": 0, "min": 0, "max": MAX_PAD, "step": 1}),
                "pad_top": ("INT", {"default": 0, "min": 0, "max": MAX_PAD, "step": 1}),
                "pad_right": ("INT", {"default": 0, "min": 0, "max": MAX_PAD, "step": 1}),
                "pad_bottom": ("INT", {"default": 0, "min": 0, "max": MAX_PAD, "step": 1}),
                "fill_gray": ("INT", {"default": DEFAULT_FILL, "min": 0, "max": 255, "step": 1}),
                "expand_json": ("STRING", {"default": DEFAULT_STATE_JSON, "multiline": False}),
                "src_scale": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.05, "max": 8.0, "step": 0.01, "tooltip": "原图缩放倍数：先缩放再扩边"},
                ),
                "save_image": ("BOOLEAN", {"default": True, "tooltip": "直接存到 output 目录（带工作流元数据）"}),
                "filename_prefix": ("STRING", {"default": "QwenOutpaint"}),
            },
            # 注意：required 里已经有 prompt（文本），hidden 不能再用 "prompt" 这个 key，
            # 否则 ComfyUI 会用整个 API prompt 覆盖掉文本框的值。这里只取 extra_pnginfo。
            "hidden": {"extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("image", "canvas")
    OUTPUT_TOOLTIPS = ("扩图结果", "送进模型的灰度画布（可用于对比）")
    FUNCTION = "run"
    # 节点自己存盘，不接任何下游也应该被执行（等价于 SaveImage 的定位）
    OUTPUT_NODE = True
    CATEGORY = "image/expand"
    DESCRIPTION = "Qwen 2.1 图像扩展一体节点：加载模型 → 灰度扩边 → 编码 → 采样 → 解码，一个节点出图"

    def run(
        self,
        unet_name: str,
        clip_name: str,
        vae_name: str,
        lora_name: str,
        strength_model: float,
        prompt: str,
        negative_prompt: str,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        resolution: int,
        pad_left: int,
        pad_top: int,
        pad_right: int,
        pad_bottom: int,
        fill_gray: int,
        expand_json: str,
        src_scale: float = 1.0,
        save_image: bool = True,
        filename_prefix: str = "QwenOutpaint",
        extra_pnginfo: Any = None,
    ) -> Dict[str, Any]:
        state = parse_state(expand_json)
        pads = {"left": pad_left, "top": pad_top, "right": pad_right, "bottom": pad_bottom}
        try:
            scale = float(src_scale)
        except (TypeError, ValueError):
            scale = state["scale"]

        # ---------- 1. 灰度扩边 ----------
        base_dir = ""
        try:
            base_dir = folder_paths.get_input_directory()
        except Exception as exc:  # pragma: no cover
            print(f"[Qwen21Outpaint] 无法定位 input 目录：{exc}")

        source = None
        if state["image"]:
            try:
                source = load_source(state["image"], base_dir or ".", fill_gray)
            except Exception as exc:  # noqa: BLE001
                print(f"[Qwen21Outpaint] 原图加载失败：{state['image']}（{exc}）")
        if source is None:
            from PIL import Image

            w = state["width"] or 1024
            h = state["height"] or 1024
            source = Image.new("RGB", (max(1, w), max(1, h)), (int(fill_gray),) * 3)
            print("[Qwen21Outpaint] 还没有导入图片，使用纯灰画布（请点节点按钮打开编辑器）")

        canvas_img, info = compose(source, pads, fill_gray, scale)
        for msg in info["warnings"]:
            print(f"[Qwen21Outpaint] {msg}")
        canvas_np = np.asarray(canvas_img, dtype=np.float32) / 255.0
        canvas_t = torch.from_numpy(canvas_np).unsqueeze(0)
        print(
            f"[Qwen21Outpaint] 画布 {info['canvas_width']}x{info['canvas_height']}"
            f"（{pads_summary(info['pads'])}，原图 {info['source_width']}x{info['source_height']}"
            f"{'' if abs(info['scale'] - 1) < 1e-6 else f'，缩放 {info['scale'] * 100:.1f}%'}）"
        )

        # ---------- 2. 模型 + LoRA ----------
        model, clip, vae = _load_models(unet_name, clip_name, vae_name, lora_name, strength_model)
        model = QwenImage21Cache.execute(model, "auto", "default").result[0]

        # ---------- 3. 编码（参考图 = 画布） ----------
        positive, negative, latent = TextEncodeQwenImage21.execute(
            clip=clip,
            prompt=prompt,
            negative_prompt=negative_prompt,
            vae=vae,
            resolution=int(resolution),
            images={"image_1": canvas_t},
        ).result

        # ---------- 4. 采样 + 解码 ----------
        print(
            f"[Qwen21Outpaint] 采样 {steps} 步 / CFG {cfg} / {sampler_name} / {scheduler}"
            f" / 分辨率参数 {resolution} / seed {seed}"
        )
        # 关掉采样过程中的 latent 预览：节点卡片自己画进度条和对比图，
        # 否则前端会在节点上再挂一张模糊的预览图，和卡片叠在一起。
        latent_preview.set_preview_method("none")
        try:
            samples = comfy_nodes.common_ksampler(
                model, int(seed), int(steps), float(cfg), sampler_name, scheduler,
                positive, negative, latent, denoise=1.0,
            )[0]
        finally:
            latent_preview.set_preview_method(None)
        # 注意参数顺序是 (vae, samples)，和 INPUT_TYPES 里的显示顺序相反
        image = comfy_nodes.VAEDecode().decode(vae=vae, samples=samples)[0]

        # ---------- 5. 存盘 ----------
        ui_images = []
        if save_image:
            try:
                out = comfy_nodes.SaveImage().save_images(
                    image, filename_prefix or "QwenOutpaint", None, extra_pnginfo
                )
                ui_images = out.get("ui", {}).get("images") or []
                names = [i.get("filename") for i in ui_images]
                print(f"[Qwen21Outpaint] 已保存：{', '.join(n for n in names if n)}")
            except Exception as exc:  # noqa: BLE001 - 存盘失败不该让出图整个失败
                print(f"[Qwen21Outpaint] 保存失败（结果仍会从输出口给出）：{exc}")

        # 用自定义 ui key（不是 "images"）：节点卡片自己画「灰底输入 / 生成结果」对比，
        # 若用 "images" 前端会在节点下方再挂一张大图，和卡片重复。
        return {"ui": {"qie_preview": ui_images}, "result": (image, canvas_t)}


NODE_CLASS_MAPPINGS = {"Qwen21Outpaint": Qwen21Outpaint}
NODE_DISPLAY_NAME_MAPPINGS = {"Qwen21Outpaint": "Qwen 图像扩展 · 一体出图 (Outpaint All-in-One)"}
