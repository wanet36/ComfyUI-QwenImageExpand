# ComfyUI-QwenImageExpand

[![tests](https://github.com/wanet36/ComfyUI-QwenImageExpand/actions/workflows/tests.yml/badge.svg)](https://github.com/wanet36/ComfyUI-QwenImageExpand/actions/workflows/tests.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**中文** → [README.md](README.md) · **English** (this file)

Two ComfyUI nodes for **outpainting with Qwen-Image 2.1**, sharing one visual editor:
import an image → drag the frame outwards → the extended area is filled with `rgb(128,128,128)` (`#808080`).

| Node | What it does | Pick it when |
| --- | --- | --- |
| **Qwen 图像扩展 (Image Expand)** | Outputs the padded canvas only (single `IMAGE`) | You want to wire the model yourself or swap samplers |
| **Qwen 图像扩展 · 一体出图 (Outpaint All-in-One)** | Loads UNET / CLIP / VAE / LoRA → pads → encodes → samples → decodes → saves, all inside one node | You want one-click outpainting (same result as the 10-node chain) |

![Node: Outpaint All-in-One](docs/node.png)

> The second button `⇄` toggles the card between the generated result and the original (grey padded) canvas.

## Install

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/wanet36/ComfyUI-QwenImageExpand.git
# restart ComfyUI
```

No extra dependencies (only PIL + numpy, already bundled with ComfyUI).
Both nodes live under the `image/expand` category.

## Quick start — Image Expand

1. Add **Qwen 图像扩展 (Image Expand)**, click `🖼 Edit / Expand`
2. Click **＋ Import / Replace image** (drag & drop also works)
3. (optional) **Scale source**: type a percentage, or hit **Canvas 1MP / 1.5MP / 2MP** to solve the scale
   from a target pixel budget — this keeps big photos inside the LoRA's training range
4. The image is framed; drag the four edges / corners **outwards**:
   - the new area turns into 128 grey immediately (that is what the model is asked to paint)
   - the sidebar shows the output size, MP and per-side padding live
5. (optional) **Target canvas** / preset ratios `1:1 · 4:3 · 3:4 · 16:9 · 9:16` centre the photo on a standard canvas
6. Click **OK** → the node outputs the `IMAGE`

![Editor](docs/editor.png)

> The screenshot shows the **All-in-One** node's sidebar (hence the extra Model / Prompt / Sampling / Save groups).
> The canvas-only node has the same editor minus those four groups.

## Parameters

| Parameter | Meaning |
| --- | --- |
| `pad_left` / `pad_top` / `pad_right` / `pad_bottom` | Pixels added on each side (written back by the editor, editable by hand) |
| `fill_gray` | Grey level of the extended area, default `128` = `rgb(128,128,128)` |
| `expand_json` | Source file name / size / scale / alignment (maintained by the editor, don't edit) |
| `src_scale` | Source scale factor, default `1.0` (0.05–8): canvas = round(source × scale) + padding |

Output: **IMAGE**, size = source × `src_scale` + padding.

## All-in-One node

Everything from *UNET / CLIP / VAE / LoRA loading* to *saving the PNG* happens inside one node.

| Area | Content |
| --- | --- |
| Node body | `🖼 Edit / Params`, `⇄ grey canvas / result` toggle, the four `pad_*` + `fill_gray` + `src_scale`, and a result card (size line, progress bar, single preview) |
| Editor · canvas | import, scale, drag to expand, target canvas, alignment, grey level |
| Editor · sidebar | **Model** (unet / clip / vae / lora / strength), **Prompt** (positive / negative), **Sampling** (seed + randomise, steps, CFG, sampler, scheduler, reference resolution), **Save** (toggle, filename prefix) |

Generated result (default view) and the grey canvas it was generated from:

![Result](docs/pipeline_result.png)

![Grey canvas](docs/pipeline_canvas.png)

Parameters that stay on the node are identical to the canvas-only node; the model/prompt/sampling/save widgets
are hidden on the node body but still serialised, so workflows keep working.

Model weights are cached in-process by *file name + LoRA + strength*, so changing the seed or prompt
does not reload 20 GB; switching models calls `soft_empty_cache()` first.

## Examples

Both files can be dragged straight into ComfyUI:

| File | Content |
| --- | --- |
| `examples/qwen21_outpaint_single.json` | Minimal: one All-in-One node |
| `examples/qwen21_outpaint_workflow.json` | Exploded: UNET / CLIP / VAE / LoRA + this node + Text Encode Qwen Image 2.1 + KSampler + VAE Decode + SaveImage (+ an unwired All-in-One for comparison) |

They reference `input/qwen_image_expand/ComfyUI_00031.png` (my test photo).
**Click "＋ Import / Replace image" after loading** and pick your own file, otherwise the node falls back to a plain grey canvas.
The 12-node example also uses rgthree's `Image Comparer`; delete that node if you don't have the pack.

## Requirements of Qwen-Image-2.1-Outpaint-LoRA

Built for [ausboss/Qwen-Image-2.1-Outpaint-LoRA](https://huggingface.co/ausboss/Qwen-Image-2.1-Outpaint-LoRA).
Its model card requires:

| Requirement | This node |
| --- | --- |
| Grey `#808080` background | ✅ `fill_gray=128` |
| Canvas multiple of **32** | ✅ alignment defaults to 32 |
| 1–2 MP total | ⚠ warns in the sidebar above 2 MP |
| Source pixels untouched | ✅ padding never resamples the source |
| Reference size = output size | ✅ encoder `resolution = 0` |

Prompt — the first sentence must be the trigger, a `Scene: …` description may follow:

```
Outpaint the image: replace the solid gray areas with a seamless continuation of the scene, keeping the existing picture unchanged.
```

Sampling: 25 steps / CFG 1 / euler / simple / denoise 1 for the full model; 4–8 steps with CFG 1 for turbo builds.
Do **not** use `Set Latent Noise Mask` to "protect" the known area — on Qwen 2.1 it paints a visible rectangle.
The LoRA is released under the Qwen Research License (**non-commercial**).

## Troubleshooting

**Output is 32×32 / tiny?**
`Text Encode Qwen Image 2.1` → `resolution` is the *reference image size*; `32` shrinks the reference to 32×32.
Set it to **0** (keep canvas size). This is a different parameter from `resolution_steps` in *Scale Image to Total Pixels*.

**Output is 1–31 px smaller than the canvas, or the photo is offset?**
The canvas is not a multiple of 32. Clicking **OK** re-aligns automatically; you can also re-apply a target canvas.

**Visible seams / duplicated subject?**
Remove `Set Latent Noise Mask`, keep LoRA strength 1.0 and CFG 1.

## Editor shortcuts

| Action | Effect |
| --- | --- |
| Drag edge / corner | Expand outwards, shrink inwards (down to the source size) |
| Wheel | Zoom |
| Drag empty space | Pan |
| `Esc` | Close (asks before discarding changes) |
| Sidebar pads | Type exact pixel values, snapped to the alignment grid |
| Target canvas + ratio buttons | Centre the photo on a given size / ratio |

## Tests

```bash
python tests/test_expand.py        # backend: grey fill, pixel alignment, JSON tolerance, path traversal, node tensor
node   tests/test_editor.js        # editor: import, scale, drag-expand, presets, write-back, preview (jsdom, 68 asserts)
node   tests/test_editor_params.js # sidebar params: 4 groups, values, write-back, seed, view toggle (29 asserts)
python tests/api_smoke.py          # real ComfyUI: submit → SaveImage, verify size / grey / alignment
node   tests/cdp_ui.mjs            # real UI, headless Chrome: create node, open modal, drag border, write-back (26 asserts)
node   tests/cdp_pipeline.mjs      # real UI + one generation: card shape, toggle views, graphToPrompt (26 asserts)
```

The last two need ComfyUI running on `127.0.0.1:8188` with the plugin installed in `custom_nodes`.
GitHub Actions runs the first three (backend + jsdom).

## Layout

```
ComfyUI-QwenImageExpand/
├─ __init__.py            # node registration + WEB_DIRECTORY
├─ nodes.py               # Image Expand node (IMAGE output)
├─ expand.py              # padding core (pure PIL, testable standalone)
├─ pipeline.py            # All-in-One node (load → pad → encode → sample → decode → save)
├─ web/js/qwen_image_expand.js   # editor UI
├─ examples/              # ready-to-run workflows
├─ docs/                  # screenshots
├─ tests/                 # backend + jsdom + real-ComfyUI tests
├─ pyproject.toml         # ComfyUI Registry metadata
└─ LICENSE                # MIT
```

## Limitations

- One image at a time (use several nodes for batches).
- The node does not write prompts; put the outpainting instruction in the prompt field / Text Encode node.
- EXIF orientation is handled by the browser when decoding; the backend pastes pixels as-is.
