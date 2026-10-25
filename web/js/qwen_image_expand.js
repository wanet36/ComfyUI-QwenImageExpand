/**
 * QwenImageExpand —— Qwen 图像扩展（扩边 / outpainting 预处理）节点编辑器
 *
 * 交互：点击节点按钮 → 弹窗 → 导入图片 → 图片被矩形框住 → 拖动矩形四条边 / 四角向外拉
 *      向外拉出的部分即扩图区域，固定填充 rgb(128,128,128)，确定后写回 pad_* widget。
 * 数据：expand_json 存 { version, image, width, height, fill, align, pads:{left,top,right,bottom} }
 *      输出尺寸 = 原图尺寸 + 对应方向 pads，后端只做「灰度画布 + 贴图」。
 */

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_CLASSES = ["QwenImageExpand", "Qwen21Outpaint"];
// 一体节点只从编辑器改扩边参数，节点上不显示这些控件（值仍在，序列化不受影响）
const HIDDEN_WIDGETS = {
  // 一体节点把「除按钮外的一切」都收进编辑器右侧栏，节点上只留结果卡片
  Qwen21Outpaint: [
    // 模型 / 提示词 / 采样 / 存盘 → 只在编辑器右侧栏
    "unet_name", "clip_name", "vae_name", "lora_name", "strength_model",
    "prompt", "negative_prompt", "seed", "control_after_generate", "steps", "cfg",
    "sampler_name", "scheduler", "resolution",
    "save_image", "filename_prefix",
    // pad_* / fill_gray / src_scale 与「Qwen 图像扩展」节点一致，显示在节点本体上
  ],
};

// 编辑器右侧「参数」区分组（顺序即界面顺序）
const PARAM_GROUPS = [
  { key: "model", title: "模型", open: false, fields: [
    ["unet_name", "主模型"], ["clip_name", "文本编码器"], ["vae_name", "VAE"],
    ["lora_name", "扩图 LoRA"], ["strength_model", "LoRA 强度"],
  ] },
  { key: "prompt", title: "提示词", open: false, fields: [
    ["prompt", "正向"], ["negative_prompt", "反向"],
  ] },
  { key: "sample", title: "采样", open: false, fields: [
    ["seed", "种子"], ["steps", "步数"], ["cfg", "CFG"],
    ["sampler_name", "采样器"], ["scheduler", "调度器"], ["resolution", "参考图分辨率"],
  ] },
  { key: "output", title: "存盘", open: false, fields: [
    ["save_image", "保存到 output"], ["filename_prefix", "文件名前缀"],
  ] },
];
const UPLOAD_SUBFOLDER = "qwen_image_expand";
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 8;
const HANDLE_R = 10; // 手柄命中半径（屏幕像素）
const DEFAULT_FILL = 128;
const MAX_EDGE = 16384;
const PAD_KEYS = ["left", "top", "right", "bottom"];
const PAD_DIR = { left: "w", right: "e", top: "n", bottom: "s" };

/* ------------------------------------------------------------------ 工具 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r0 = (v) => Math.round(Number(v) || 0);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function getWidget(node, name) {
  return node?.widgets?.find((w) => w.name === name);
}

function setWidgetValue(node, name, value) {
  const w = getWidget(node, name);
  if (!w) return;
  w.value = value;
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

/** 读编辑器状态（原图 / 填充 / 对齐），非法 JSON 一律降级为空状态 */
function readState(node) {
  const w = getWidget(node, "expand_json");
  let data = {};
  if (w && typeof w.value === "string" && w.value.trim()) {
    try {
      const parsed = JSON.parse(w.value);
      if (parsed && typeof parsed === "object") data = parsed;
    } catch (err) {
      console.warn("[QwenImageExpand] expand_json 解析失败", err);
    }
  }
  const pads = data.pads && typeof data.pads === "object" ? data.pads : data;
  return {
    image: String(data.image || "").trim(),
    width: Math.max(0, r0(data.width)),
    height: Math.max(0, r0(data.height)),
    scale: clamp(Number.isFinite(Number(data.scale)) ? Number(data.scale) : 1, 0.05, 8),
    fill: clamp(r0(Number.isFinite(Number(data.fill)) ? data.fill : DEFAULT_FILL), 0, 255),
    align: clamp(r0(data.align) || 32, 1, 512),
    pads: Object.fromEntries(PAD_KEYS.map((k) => [k, Math.max(0, r0(pads[k]))])),
  };
}

/** 读四边边距：以 widget 为准，widget 缺失时回落到 JSON */
function readPads(node) {
  const st = readState(node);
  const out = {};
  for (const k of PAD_KEYS) {
    const w = getWidget(node, `pad_${k}`);
    out[k] = w && Number.isFinite(Number(w.value)) ? Math.max(0, r0(w.value)) : st.pads[k];
  }
  return out;
}

function writeState(node, st, pads) {
  const w = getWidget(node, "expand_json");
  if (w) {
    w.value = JSON.stringify({
      version: 1,
      image: st.image || "",
      width: r0(st.width),
      height: r0(st.height),
      scale: Math.round(clamp(Number(st.scale) || 1, 0.05, 8) * 1000) / 1000,
      fill: clamp(r0(st.fill), 0, 255),
      align: clamp(r0(st.align) || 32, 1, 512),
      pads: Object.fromEntries(PAD_KEYS.map((k) => [k, Math.max(0, r0(pads[k]))])),
    });
  }
  for (const k of PAD_KEYS) setWidgetValue(node, `pad_${k}`, Math.max(0, r0(pads[k])));
  updateButtonLabel(node);
}

/** 原图按 scale 缩放后的像素尺寸（与后端 expand.scaled_size 同一套规则） */
function scaledSize(st) {
  const k = clamp(Number(st.scale) || 1, 0.05, 8);
  return {
    w: Math.max(1, Math.round(st.width * k)),
    h: Math.max(1, Math.round(st.height * k)),
  };
}

function outputSize(st, pads) {
  const s = scaledSize(st);
  return {
    w: Math.max(1, s.w + pads.left + pads.right),
    h: Math.max(1, s.h + pads.top + pads.bottom),
  };
}

function updateButtonLabel(node) {
  const btn = node.__qieBtn;
  if (!btn) return;
  if (node.comfyClass === "Qwen21Outpaint") {
    btn.name = "🖼 编辑 / 参数";
    node.setDirtyCanvas?.(true, true);
    return;
  }
  const st = readState(node);
  if (!st.image || !st.width) {
    btn.name = "🖼 打开扩展编辑器";
  } else {
    const out = outputSize(st, readPads(node));
    const s = scaledSize(st);
    const pct = Math.abs((st.scale || 1) - 1) < 1e-6 ? `${st.width}×${st.height}` : `${s.w}×${s.h}·${Math.round(st.scale * 100)}%`;
    btn.name = `🖼 编辑扩展（${pct} → ${out.w}×${out.h}）`;
  }
  node.setDirtyCanvas?.(true, true);
}

/* -------------------------------------------------------------- 图片接口 */

function splitName(name) {
  const clean = String(name).replace(/\\/g, "/");
  const i = clean.lastIndexOf("/");
  return i >= 0 ? { subfolder: clean.slice(0, i), filename: clean.slice(i + 1) } : { subfolder: "", filename: clean };
}

function apiUrl(path) {
  try {
    if (api?.apiURL) return api.apiURL(path);
  } catch (e) {
    /* ignore */
  }
  return path;
}

function viewUrl(name) {
  const { subfolder, filename } = splitName(name);
  const q = new URLSearchParams({ filename, type: "input", subfolder });
  return apiUrl(`/view?${q.toString()}`);
}

/** 执行结果里的 {filename, subfolder, type} → /view 地址 */
function viewUrlOf(file) {
  if (typeof file === "string") return viewUrl(file);
  const q = new URLSearchParams({
    filename: file.filename || "",
    type: file.type || "output",
    subfolder: file.subfolder || "",
  });
  return apiUrl(`/view?${q.toString()}`);
}

function loadImageUrl(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(`图片加载失败：${url}`));
    im.src = url;
  });
}

async function uploadImage(file) {
  const fd = new FormData();
  fd.append("image", file, file.name);
  fd.append("type", "input");
  fd.append("subfolder", UPLOAD_SUBFOLDER);
  // 不传 overwrite：同名文件由后端自动改名，避免覆盖 input 目录里已有的图
  const res = await fetch(apiUrl("/upload/image"), { method: "POST", body: fd });
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}`);
  const data = await res.json();
  const name = data.name || file.name;
  return data.subfolder ? `${data.subfolder}/${name}` : name;
}

function loadImage(name) {
  return loadImageUrl(viewUrl(name));
}

function imageCache(node) {
  return node.__qieImages || (node.__qieImages = new Map());
}

/* ------------------------------------------------------------ 节点预览 */

/** 把「灰度画布 + 原图」渲成一张缩略 canvas（节点上的预览与弹窗共用同一套几何） */
function buildPreviewCanvas(st, pads, im, maxEdge = 512) {
  const sc = scaledSize(st);
  const cw = Math.max(1, sc.w + pads.left + pads.right);
  const ch = Math.max(1, sc.h + pads.top + pads.bottom);
  const k = Math.min(1, maxEdge / Math.max(cw, ch));
  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.round(cw * k));
  off.height = Math.max(1, Math.round(ch * k));
  const g = off.getContext("2d");
  if (!g) return off;
  g.fillStyle = `rgb(${clamp(r0(st.fill), 0, 255)},${clamp(r0(st.fill), 0, 255)},${clamp(r0(st.fill), 0, 255)})`;
  g.fillRect(0, 0, off.width, off.height);
  if (im && im.width) {
    g.imageSmoothingQuality = "high";
    g.drawImage(im, pads.left * k, pads.top * k, sc.w * k, sc.h * k);
  }
  return off;
}

/** 上一轮生成结果（用于节点上的对比视图） */
async function ensureResultImage(node) {
  const res = node.__qieResult;
  if (!res) return null;
  const url = viewUrlOf(res);
  if (node.__qieResultImg && node.__qieResultImg.__qieUrl === url) return node.__qieResultImg;
  try {
    const im = await loadImageUrl(url);
    im.__qieUrl = url;
    node.__qieResultImg = im;
  } catch (err) {
    node.__qieResultImg = null;
    console.warn("[QwenImageExpand]", err.message);
  }
  node.setDirtyCanvas?.(true, true);
  return node.__qieResultImg;
}

async function refreshPreview(node) {
  const st = readState(node);
  const pads = readPads(node);
  if (!st.image || !st.width) {
    node.__qiePreview = null;
    node.setDirtyCanvas?.(true, true);
    return;
  }
  const cache = imageCache(node);
  let im = cache.get(st.image);
  if (!im) {
    try {
      im = await loadImage(st.image);
      cache.set(st.image, im);
    } catch (err) {
      cache.set(st.image, null);
      console.warn("[QwenImageExpand]", err.message);
    }
  }
  node.__qiePreview = buildPreviewCanvas(st, pads, im);
  node.setDirtyCanvas?.(true, true);
}

/* ---------------------------------------------------------------- 样式 */

function injectCSS() {
  if (document.getElementById("qie-style")) return;
  const style = document.createElement("style");
  style.id = "qie-style";
  style.textContent = `
.qie-mask{position:fixed;inset:0;z-index:2147482000;background:rgba(6,6,10,.74);display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
.qie-panel{width:min(1280px,95vw);height:min(880px,92vh);background:#1b1b21;color:#e8e8ee;border:1px solid #35353f;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.65);}
.qie-head{display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid #2c2c35;background:#202027;}
.qie-title{font-size:15px;font-weight:600;letter-spacing:.3px;}
.qie-tag{font-size:11px;color:#9aa7c7;background:#262b3a;border:1px solid #37405a;border-radius:999px;padding:2px 8px;}
.qie-sub{font-size:12px;color:#8b8b9c;}
.qie-close{margin-left:auto;width:28px;height:28px;line-height:1;font-size:18px;border-radius:6px;background:transparent;color:#b9b9c8;border:1px solid transparent;cursor:pointer;}
.qie-close:hover{background:#2f2f39;color:#fff;}
.qie-body{flex:1;display:flex;min-height:0;}
.qie-stage{flex:1;display:flex;flex-direction:column;min-width:0;background:#101015;}
.qie-wrap{flex:1;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;}
.qie-wrap.drop{outline:2px dashed #6f8dff;outline-offset:-8px;background:#171725;}
.qie-canvas{display:block;touch-action:none;}
.qie-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 14px;border-top:1px solid #2c2c35;background:#1c1c23;font-size:12px;color:#a9a9ba;}
.qie-hint{margin-left:auto;color:#6f6f80;}
.qie-btn{padding:6px 12px;border-radius:6px;border:1px solid #3a3a46;background:#2a2a33;color:#dcdce8;font-size:12px;cursor:pointer;white-space:nowrap;}
.qie-btn:hover{background:#34343f;}
.qie-btn.primary{background:#3f5bd9;border-color:#4a67ea;color:#fff;font-weight:600;}
.qie-btn.primary:hover{background:#4a67ea;}
.qie-btn:disabled{opacity:.5;cursor:not-allowed;}
.qie-side{width:318px;flex:0 0 318px;border-left:1px solid #2c2c35;background:#1c1c23;display:flex;flex-direction:column;overflow-y:auto;}
.qie-sec{padding:9px 12px;border-bottom:1px solid #26262f;display:flex;flex-direction:column;gap:6px;}
.qie-sec-t{font-size:11px;color:#8b8b9c;letter-spacing:.4px;}
.qie-src{font-size:11.5px;color:#d6d6e2;line-height:1.5;word-break:break-all;}
.qie-src b{color:#fff;font-weight:600;}
.qie-src .qie-dim{color:#7fd1a0;}
.qie-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.qie-grid label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:#8b8b9c;}
.qie-row{display:flex;align-items:center;gap:8px;font-size:12px;color:#a9a9ba;}
.qie-row .qie-mid{color:#6f6f80;}
.qie-chips{display:flex;gap:6px;flex-wrap:wrap;}
.qie-chips button{flex:1 1 0;min-width:44px;padding:4px 0;border:1px solid #3a3a46;background:#23232b;color:#b9b9c8;border-radius:5px;cursor:pointer;font-size:11px;}
.qie-chips button:hover{background:#33333f;color:#fff;border-color:#4a5da8;}
.qie-pads input,.qie-row input,.qie-row select{background:#26262f;border:1px solid #3a3a46;color:#e8e8ee;border-radius:5px;padding:4px 6px;font-size:12px;outline:none;width:100%;box-sizing:border-box;}
.qie-row input{width:78px;}
.qie-row select{width:auto;}
.qie-out{font-size:11.5px;color:#d6d6e2;background:#23232b;border:1px solid #33333d;border-radius:6px;padding:6px 9px;line-height:1.55;}
.qie-out b{color:#8fb0ff;}
.qie-scale-tip{font-size:10.5px;color:#6f6f80;line-height:1.45;}
.qie-warn{color:#e5c07b;font-size:11px;line-height:1.5;display:none;}
.qie-warn.on{display:block;}

.qie-top{position:sticky;top:0;z-index:3;display:flex;flex-direction:column;gap:7px;padding:10px 12px;background:#1c1c23;border-bottom:1px solid #26262f;}
.qie-import{width:100%;padding:8px 0;font-size:12.5px;}
.qie-params{display:flex;flex-direction:column;}
.qie-tip{display:none;margin:12px;padding:10px 12px;border:1px dashed #3a4356;border-radius:8px;background:#1d2130;color:#9aa7c7;font-size:11.5px;line-height:1.6;}
.qie-tip.on{display:block;}
.qie-tip b{color:#c9d6ff;}
.qie-fold{border-bottom:1px solid #26262f;}
.qie-fold>summary{cursor:pointer;padding:9px 12px;font-size:11px;color:#9a9aab;display:flex;align-items:center;gap:7px;list-style:none;user-select:none;}
.qie-fold>summary::-webkit-details-marker{display:none;}
.qie-fold>summary:before{content:"▸";font-size:10px;color:#6f6f80;transform:rotate(0deg);transition:transform .15s;}
.qie-fold[open]>summary:before{transform:rotate(90deg);}
.qie-fold>summary:hover{background:#23232b;}
.qie-fold-sum{margin-left:auto;font-weight:400;color:#6f6f80;font-size:10.5px;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qie-fold-body{padding:2px 12px 10px;display:flex;flex-direction:column;gap:6px;}
.qie-field{display:flex;flex-direction:column;gap:3px;font-size:11px;color:#8b8b9c;}
.qie-field.qie-inline{flex-direction:row;align-items:center;gap:8px;}
.qie-field.qie-inline input{width:auto;}
.qie-field select,.qie-field input[type=text],.qie-field input[type=number],.qie-field textarea{background:#26262f;border:1px solid #3a3a46;color:#e8e8ee;border-radius:5px;padding:4px 6px;font-size:11.5px;outline:none;width:100%;box-sizing:border-box;font-family:inherit;}
.qie-field textarea{resize:vertical;line-height:1.45;}
.qie-seedrow{display:flex;gap:6px;align-items:center;}
.qie-seedrow input{flex:1;}
.qie-seedrow .qie-btn{padding:4px 10px;}
.qie-foot{display:flex;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid #2c2c35;background:#202027;}
.qie-status{font-size:12px;color:#8b8b9c;}
.qie-actions{margin-left:auto;display:flex;gap:8px;}
`;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------- 编辑器 */

let activeEditor = null;

class ExpandEditor {
  constructor(node) {
    this.node = node;
    const st = readState(node);
    this.image = st.image;
    this.srcW = st.width;
    this.srcH = st.height;
    this.scale = st.scale;
    this.w = 0;
    this.h = 0;
    this.syncScaled();
    this.fill = st.fill;
    this.align = st.align;
    this.pads = readPads(node);
    this.images = imageCache(node);
    this.img = this.images.get(this.image) || null;

    this.view = 1;
    this.ox = 0;
    this.oy = 0;
    this.cssW = 800;
    this.cssH = 600;
    this.dpr = window.devicePixelRatio || 1;
    this.drag = null;
    this.dirty = false;

    this.build();
    this.fitView();
    this.syncSide();
    this.draw();
    this.ensureImageThenDraw();
  }

  /* ---------- 派生尺寸 ---------- */

  /** 原图 × 缩放 = 当前参与布局的尺寸 */
  syncScaled() {
    this.w = this.srcW ? Math.max(1, Math.round(this.srcW * this.scale)) : 0;
    this.h = this.srcH ? Math.max(1, Math.round(this.srcH * this.scale)) : 0;
  }

  get canvasW() {
    return Math.max(1, this.w + this.pads.left + this.pads.right);
  }

  get canvasH() {
    return Math.max(1, this.h + this.pads.top + this.pads.bottom);
  }

  /* ---------- DOM ---------- */

  build() {
    const root = document.createElement("div");
    root.className = "qie-mask";
    root.innerHTML = `
<div class="qie-panel">
  <div class="qie-head">
    <div class="qie-title">Qwen 图像扩展</div>
    <span class="qie-tag">outpainting 预处理</span>
    <div class="qie-sub"></div>
    <button class="qie-close" title="关闭 (Esc)">×</button>
  </div>
  <div class="qie-body">
    <div class="qie-stage">
      <div class="qie-wrap"><canvas class="qie-canvas"></canvas></div>
      <div class="qie-toolbar">
        <button class="qie-btn primary" data-act="import">＋ 导入图片</button>
        <button class="qie-btn" data-act="fit" title="缩放到适合窗口">⤢ 适应窗口</button>
        <button class="qie-btn" data-act="reset" title="四边边距清零">↺ 清零边距</button>
        <button class="qie-btn" data-act="grow" title="四边各加 64px">＋64 四边</button>
        <span class="qie-hint">拖动矩形四条边 / 四角向外扩展 · 滚轮缩放 · 空白处拖动平移</span>
        <input type="file" accept="image/*" style="display:none">
      </div>
    </div>
    <aside class="qie-side">
      <div class="qie-top">
        <button class="qie-btn primary qie-import" data-act="import">＋ 导入 / 替换图片</button>
        <div class="qie-src">未导入</div>
      </div>
      <div class="qie-tip"></div>
      <div class="qie-params"></div>
      <div class="qie-sec">
        <div class="qie-sec-t" title="「画布 N MP」按总像素反算缩放（含当前边距）· Outpaint LoRA 训练范围 1–2MP">原图缩放</div>
        <div class="qie-row">
          <input type="number" data-k="scale" min="5" max="800" step="1" style="width:72px">
          <span class="qie-mid">%</span>
          <button class="qie-btn" data-act="scale-reset">100%</button>
        </div>
        <div class="qie-chips">
          <button data-scale="0.75">75%</button>
          <button data-scale="0.5">50%</button>
          <button data-scale="0.25">25%</button>
          <button data-scale="1.5">150%</button>
        </div>
        <div class="qie-chips">
          <button data-mp="1">画布 1MP</button>
          <button data-mp="1.5">1.5MP</button>
          <button data-mp="2">2MP</button>
        </div>
      </div>
      <div class="qie-sec qie-pads">
        <div class="qie-sec-t">扩展边距（px）</div>
        <div class="qie-grid">
          <label>左<input type="number" data-pad="left" min="0" step="1"></label>
          <label>上<input type="number" data-pad="top" min="0" step="1"></label>
          <label>右<input type="number" data-pad="right" min="0" step="1"></label>
          <label>下<input type="number" data-pad="bottom" min="0" step="1"></label>
        </div>
      </div>
      <div class="qie-sec">
        <div class="qie-sec-t">目标画布（原图居中扩展）</div>
        <div class="qie-row">
          <input type="number" data-k="tw" min="1" max="16384" step="16">
          <span class="qie-mid">×</span>
          <input type="number" data-k="th" min="1" max="16384" step="16">
          <button class="qie-btn" data-act="target">应用</button>
        </div>
        <div class="qie-chips">
          <button data-ratio="1:1">1:1</button>
          <button data-ratio="4:3">4:3</button>
          <button data-ratio="3:4">3:4</button>
          <button data-ratio="16:9">16:9</button>
          <button data-ratio="9:16">9:16</button>
        </div>
      </div>
      <div class="qie-sec">
        <div class="qie-sec-t">输出</div>
        <div class="qie-row">
          <span>对齐</span>
          <select data-k="align" style="flex:1">
            <option value="32">32（Qwen 2.1 推荐）</option>
            <option value="16">16</option>
            <option value="8">8</option>
            <option value="64">64</option>
            <option value="1">不对齐</option>
          </select>
        </div>
        <div class="qie-row">
          <span>填充灰度</span>
          <input type="number" data-k="fill" min="0" max="255" step="1" style="width:72px">
        </div>
        <div class="qie-out"></div>
        <div class="qie-warn"></div>
      </div>
    </aside>
  </div>
  <div class="qie-foot">
    <span class="qie-status"></span>
    <div class="qie-actions">
      <button class="qie-btn" data-act="cancel">取消</button>
      <button class="qie-btn primary" data-act="ok">确定</button>
    </div>
  </div>
</div>`;

    this.root = root;
    document.body.appendChild(root);

    const q = (s) => root.querySelector(s);
    this.dom = {
      sub: q(".qie-sub"),
      wrap: q(".qie-wrap"),
      canvas: q(".qie-canvas"),
      file: q('input[type="file"]'),
      src: q(".qie-src"),
      scale: q('[data-k="scale"]'),
      tw: q('[data-k="tw"]'),
      th: q('[data-k="th"]'),
      align: q('[data-k="align"]'),
      fill: q('[data-k="fill"]'),
      out: q(".qie-out"),
      warn: q(".qie-warn"),
      params: q(".qie-params"),
      tip: q(".qie-tip"),
      status: q(".qie-status"),
      ok: q('[data-act="ok"]'),
    };
    this.ctx = this.dom.canvas.getContext("2d");
    this.renderParams();
    if (this.dom.tip) {
      // 只有「只出画布」的节点需要这条指引
      if (!getWidget(this.node, "unet_name")) {
        this.dom.tip.innerHTML =
          "此节点只输出灰度扩边画布。<br>要在一个节点里直接出图（模型 / 提示词 / 采样 / 存盘都在右侧栏），请用「<b>Qwen 图像扩展 · 一体出图</b>」。";
        this.dom.tip.classList.add("on");
      } else {
        this.dom.tip.classList.remove("on");
      }
    }

    const alignOpt = String(this.align);
    this.dom.align.value = [...this.dom.align.options].some((o) => o.value === alignOpt) ? alignOpt : "32";
    this.align = r0(this.dom.align.value);
    this.dom.fill.value = String(this.fill);

    this.bind();
    this.fitView();
    requestAnimationFrame(() => {
      this.fitView();
      this.draw();
    });
  }

  bind() {
    const d = this.dom;
    const c = d.canvas;

    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e));
    c.addEventListener("pointercancel", (e) => this.onUp(e));
    c.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    c.addEventListener("contextmenu", (e) => e.preventDefault());

    this.root.addEventListener("click", (e) => {
      const ratio = e.target.closest("[data-ratio]")?.dataset.ratio;
      if (ratio) {
        this.applyPreset(ratio);
        return;
      }
      const scalePreset = e.target.closest("[data-scale]")?.dataset.scale;
      if (scalePreset) {
        this.setScale(Number(scalePreset));
        return;
      }
      const mpPreset = e.target.closest("[data-mp]")?.dataset.mp;
      if (mpPreset) {
        this.applyTargetMP(Number(mpPreset));
        return;
      }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "import") d.file.click();
      else if (act === "fit") {
        this.fitView();
        this.draw();
      } else if (act === "reset") {
        this.pads = { left: 0, top: 0, right: 0, bottom: 0 };
        this.dirty = true;
        this.fitView();
        this.syncSide();
        this.draw();
        this.setStatus("四边边距已清零");
      } else if (act === "roll-seed") {
        const w = getWidget(this.node, "seed");
        const max = Math.min(Number(w?.options?.max ?? 1e15), 1e15);
        const el = this.dom.params.querySelector('[data-param="seed"]');
        if (el) {
          el.value = String(Math.floor(Math.random() * max));
          this.setStatus("已随机种子（点「确定」生效）");
        }
      } else if (act === "scale-reset") {
        this.setScale(1);
      } else if (act === "grow") {
        this.growAll(64);
      } else if (act === "target") {
        this.setTarget(Number(d.tw.value), Number(d.th.value));
      } else if (act === "ok") {
        this.commit();
      } else if (act === "cancel") {
        this.tryClose();
      }
    });

    this.root.querySelector(".qie-close").addEventListener("click", () => this.tryClose());

    d.file.addEventListener("change", () => {
      this.importFiles(d.file.files);
      d.file.value = "";
    });

    for (const k of PAD_KEYS) {
      const input = this.root.querySelector(`[data-pad="${k}"]`);
      input.addEventListener("change", () => this.onPadInput(k, input));
    }

    d.scale.addEventListener("change", () => {
      const pct = clamp(Number(d.scale.value) || 100, 5, 800);
      this.setScale(pct / 100);
    });

    d.align.addEventListener("change", () => {
      this.align = clamp(r0(d.align.value) || 1, 1, 512);
      this.pads = this.snap({ ...this.pads }, "");
      this.dirty = true;
      this.syncSide();
      this.draw();
      this.setStatus(`对齐已设为 ${this.align === 1 ? "不对齐" : this.align + "px"}，输出尺寸已按此对齐`);
    });

    d.fill.addEventListener("change", () => {
      this.fill = clamp(r0(d.fill.value), 0, 255);
      this.dom.fill.value = String(this.fill);
      this.dirty = true;
      this.updateOut();
      this.draw();
    });

    d.wrap.addEventListener("dragover", (e) => {
      e.preventDefault();
      d.wrap.classList.add("drop");
    });
    d.wrap.addEventListener("dragleave", () => d.wrap.classList.remove("drop"));
    d.wrap.addEventListener("drop", (e) => {
      e.preventDefault();
      d.wrap.classList.remove("drop");
      this.importFiles(e.dataTransfer?.files);
    });

    this.onKey = (e) => this.handleKey(e);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onResize);
  }

  onResize = () => {
    if (!this.root.isConnected) return;
    this.fitView();
    this.draw();
  };

  handleKey(e) {
    if (!this.root.isConnected) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.tryClose();
    }
  }

  /* ---------- 视图 / 变换 ---------- */

  fitView() {
    const wrap = this.dom.wrap;
    const W = clamp(r0(wrap.clientWidth) || 800, 120, 8192);
    const H = clamp(r0(wrap.clientHeight) || 600, 120, 8192);
    const bw = this.canvasW;
    const bh = this.canvasH;
    this.view = clamp(Math.min((W - 48) / bw, (H - 48) / bh), MIN_ZOOM, MAX_ZOOM);
    // 让「输出画布矩形」在视口居中
    const cx = -this.pads.left + bw / 2;
    const cy = -this.pads.top + bh / 2;
    this.ox = W / 2 - cx * this.view;
    this.oy = H / 2 - cy * this.view;
    this.resizeCanvas();
  }

  resizeCanvas() {
    const wrap = this.dom.wrap;
    const W = clamp(r0(wrap.clientWidth) || 800, 120, 8192);
    const H = clamp(r0(wrap.clientHeight) || 600, 120, 8192);
    const c = this.dom.canvas;
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = W;
    this.cssH = H;
    c.style.width = `${W}px`;
    c.style.height = `${H}px`;
    c.width = Math.max(1, Math.round(W * this.dpr));
    c.height = Math.max(1, Math.round(H * this.dpr));
    this.ctx = c.getContext("2d");
    this.ctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** 图片坐标系 → 屏幕坐标 */
  sx(x) {
    return this.ox + x * this.view;
  }

  sy(y) {
    return this.oy + y * this.view;
  }

  /** 输出画布矩形（屏幕坐标，单位 px） */
  rectScreen() {
    return {
      x: this.sx(-this.pads.left),
      y: this.sy(-this.pads.top),
      w: this.canvasW * this.view,
      h: this.canvasH * this.view,
    };
  }

  imgScreen() {
    return { x: this.sx(0), y: this.sy(0), w: this.w * this.view, h: this.h * this.view };
  }

  handlePoints() {
    const r = this.rectScreen();
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const x2 = r.x + r.w;
    const y2 = r.y + r.h;
    return {
      nw: [r.x, r.y],
      n: [cx, r.y],
      ne: [x2, r.y],
      w: [r.x, cy],
      e: [x2, cy],
      sw: [r.x, y2],
      s: [cx, y2],
      se: [x2, y2],
    };
  }

  ptScreen(e) {
    const r = this.dom.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  hitHandle(p) {
    if (!this.w) return null;
    const pts = this.handlePoints();
    for (const [dir, [x, y]] of Object.entries(pts)) {
      if (Math.abs(p.x - x) <= HANDLE_R && Math.abs(p.y - y) <= HANDLE_R) return dir;
    }
    return null;
  }

  cursorFor(dir) {
    if (!dir) return "default";
    if (dir === "n" || dir === "s") return "ns-resize";
    if (dir === "e" || dir === "w") return "ew-resize";
    if (dir === "nw" || dir === "se") return "nwse-resize";
    return "nesw-resize";
  }

  /* ---------- 绘制 ---------- */

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const W = this.cssW;
    const H = this.cssH;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#101015";
    ctx.fillRect(0, 0, W, H);

    if (!this.w) {
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = "13px system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("还没有导入图片：点击「＋ 导入图片」或把图片拖进来", W / 2, H / 2);
      ctx.textAlign = "left";
      return;
    }

    const r = this.rectScreen();
    const im = this.imgScreen();

    // 1. 输出画布：整体填充灰度（也就是最终输出的底色）
    ctx.fillStyle = `rgb(${this.fill},${this.fill},${this.fill})`;
    ctx.fillRect(r.x, r.y, r.w, r.h);

    // 2. 扩展区域：淡蓝罩 + 斜纹，提示「这部分是新增的」
    this.drawPads(ctx, r, im);

    // 3. 原图
    if (this.img && this.img.width) {
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.img, im.x, im.y, im.w, im.h);
    } else {
      ctx.strokeStyle = "rgba(224,108,117,.85)";
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(im.x, im.y, im.w, im.h);
      ctx.setLineDash([]);
    }

    // 4. 原图边界（可拉伸区域的基准线）
    ctx.strokeStyle = "rgba(122,152,255,.9)";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1;
    ctx.strokeRect(im.x + 0.5, im.y + 0.5, im.w - 1, im.h - 1);
    ctx.setLineDash([]);

    // 5. 输出画布外框
    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);

    // 6. 边距标注
    this.drawPadLabels(ctx, r, im);

    // 7. 尺寸徽标
    this.drawBadge(ctx, `${this.canvasW} × ${this.canvasH}`, r.x, r.y - 8, "#7a98ff");

    // 8. 八个拖拽手柄
    this.drawHandles(ctx);
  }

  drawPads(ctx, r, im) {
    const bands = [];
    const L = this.pads.left * this.view;
    const T = this.pads.top * this.view;
    const R = this.pads.right * this.view;
    const B = this.pads.bottom * this.view;
    if (L > 0.5) bands.push([r.x, r.y, L, r.h]);
    if (R > 0.5) bands.push([im.x + im.w, r.y, R, r.h]);
    if (T > 0.5) bands.push([im.x, r.y, im.w, T]);
    if (B > 0.5) bands.push([im.x, im.y + im.h, im.w, B]);
    if (!bands.length) return;

    ctx.save();
    for (const [x, y, w, h] of bands) {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      // 只画稀疏斜纹：底色保持真实的 rgb(128,128,128)，不改变取色结果
      ctx.strokeStyle = "rgba(122,152,255,.16)";
      ctx.lineWidth = 1;
      const step = 16;
      for (let i = -h; i < w + h; i += step) {
        ctx.beginPath();
        ctx.moveTo(x + i, y);
        ctx.lineTo(x + i + h, y + h);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawPadLabels(ctx, r, im) {
    const label = (text, x, y, dim) => {
      if (dim < 24) return;
      ctx.save();
      ctx.font = "11px system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const w = ctx.measureText(text).width + 12;
      ctx.fillStyle = "rgba(12,14,22,.72)";
      ctx.fillRect(x - w / 2, y - 9, w, 18);
      ctx.fillStyle = "rgba(200,214,255,.95)";
      ctx.fillText(text, x, y + 0.5);
      ctx.restore();
    };
    const L = this.pads.left * this.view;
    const T = this.pads.top * this.view;
    const R = this.pads.right * this.view;
    const B = this.pads.bottom * this.view;
    label(`+${this.pads.left}`, r.x + L / 2, r.y + r.h / 2, L);
    label(`+${this.pads.right}`, im.x + im.w + R / 2, r.y + r.h / 2, R);
    label(`+${this.pads.top}`, im.x + im.w / 2, r.y + T / 2, T);
    label(`+${this.pads.bottom}`, im.x + im.w / 2, im.y + im.h + B / 2, B);
  }

  drawBadge(ctx, text, x, y, color) {
    ctx.save();
    ctx.font = "11px system-ui,sans-serif";
    ctx.textBaseline = "alphabetic";
    const w = ctx.measureText(text).width + 14;
    const h = 18;
    const bx = x;
    const by = Math.max(4, y - h);
    ctx.fillStyle = "rgba(12,14,22,.8)";
    ctx.fillRect(bx, by, w, h);
    ctx.strokeStyle = "rgba(122,152,255,.45)";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
    ctx.fillStyle = color;
    ctx.fillText(text, bx + 7, by + 13);
    ctx.restore();
  }

  drawHandles(ctx) {
    const pts = this.handlePoints();
    ctx.save();
    for (const [, [x, y]] of Object.entries(pts)) {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "rgba(20,24,36,.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(x - 4, y - 4, 8, 8);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------- 指针 ---------- */

  onDown(e) {
    if (e.button === 2) return;
    e.preventDefault();
    const p = this.ptScreen(e);
    const dir = this.hitHandle(p);
    if (dir) {
      this.drag = { mode: "resize", dir, start: p, pads: { ...this.pads }, view: this.view };
      this.setStatus(`拖动「${dir.toUpperCase()}」方向扩展画布`);
    } else {
      this.drag = { mode: "pan", start: p, ox: this.ox, oy: this.oy };
    }
    this.dom.canvas.setPointerCapture?.(e.pointerId);
    this.dom.canvas.style.cursor = dir ? this.cursorFor(dir) : "grabbing";
  }

  onMove(e) {
    if (!this.drag) {
      const dir = this.hitHandle(this.ptScreen(e));
      this.dom.canvas.style.cursor = dir ? this.cursorFor(dir) : this.w ? "grab" : "default";
      return;
    }
    e.preventDefault();
    const p = this.ptScreen(e);

    if (this.drag.mode === "pan") {
      this.ox = this.drag.ox + (p.x - this.drag.start.x);
      this.oy = this.drag.oy + (p.y - this.drag.start.y);
      this.draw();
      return;
    }

    const dx = (p.x - this.drag.start.x) / this.drag.view;
    const dy = (p.y - this.drag.start.y) / this.drag.view;
    const base = this.drag.pads;
    const out = { ...base };
    const d = this.drag.dir;
    const lim = (v) => clamp(Math.round(v), 0, MAX_EDGE);
    if (d.includes("e")) out.right = lim(base.right + dx);
    if (d.includes("w")) out.left = lim(base.left - dx);
    if (d.includes("s")) out.bottom = lim(base.bottom + dy);
    if (d.includes("n")) out.top = lim(base.top - dy);

    this.pads = this.snap(out, d);
    this.dirty = true;
    this.syncPads();
    this.updateOut();
    this.draw();
  }

  onUp(e) {
    if (!this.drag) return;
    const wasResize = this.drag.mode === "resize";
    this.drag = null;
    this.dom.canvas.releasePointerCapture?.(e.pointerId);
    this.dom.canvas.style.cursor = "grab";
    if (wasResize) {
      // 扩展后画布可能超出视口：只在需要时重新适配，避免拖动过程抖动
      const r = this.rectScreen();
      const outX = r.x < -8 || r.x + r.w > this.cssW + 8;
      const outY = r.y < -8 || r.y + r.h > this.cssH + 8;
      if (outX || outY) this.fitView();
      this.syncSide();
      const o = outputSize(this.readStateLocal(), this.pads);
      this.setStatus(`输出 ${o.w} × ${o.h}（左${this.pads.left} 上${this.pads.top} 右${this.pads.right} 下${this.pads.bottom}）`);
      this.draw();
    }
  }

  onWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!this.w) return;
    const p = this.ptScreen(e);
    const k = Math.exp(-e.deltaY * 0.0012);
    const nv = clamp(this.view * k, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(nv - this.view) < 1e-6) return;
    this.ox = p.x - (p.x - this.ox) * (nv / this.view);
    this.oy = p.y - (p.y - this.oy) * (nv / this.view);
    this.view = nv;
    this.draw();
  }

  /* ---------- 边距操作 ---------- */

  readStateLocal() {
    return {
      image: this.image,
      width: this.srcW,
      height: this.srcH,
      scale: this.scale,
      fill: this.fill,
      align: this.align,
    };
  }

  /** 按 align 对齐输出画布：调整被拖动（或指定）的那一边 */
  snap(pads, dir = "") {
    const a = Math.max(1, Math.round(Number(this.align) || 1));
    const out = { ...pads };
    if (a <= 1 || !this.w) return out;

    const snapAxis = (base, keyA, keyB, side) => {
      const total = base + out[keyA] + out[keyB];
      // 这一侧完全收回（等于原图尺寸）时不强行对齐，否则用户永远拉不回 0
      if (total <= base) return;
      const target = Math.max(base, Math.round(total / a) * a);
      const other = side === keyA ? keyB : keyA;
      out[side] = Math.max(0, Math.round(target - base - out[other]));
    };

    if (!dir || dir.includes("e") || dir.includes("w")) {
      snapAxis(this.w, "left", "right", dir.includes("w") ? "left" : "right");
    }
    if (!dir || dir.includes("n") || dir.includes("s")) {
      snapAxis(this.h, "top", "bottom", dir.includes("n") ? "top" : "bottom");
    }
    return out;
  }

  onPadInput(key, input) {
    const v = clamp(r0(input.value), 0, MAX_EDGE);
    const before = this.pads[key];
    this.pads = this.snap({ ...this.pads, [key]: v }, PAD_DIR[key]);
    this.dirty = true;
    input.value = String(this.pads[key]);
    this.syncSide();
    this.draw();
    if (v !== before && v !== this.pads[key]) {
      this.setStatus(`为对齐 ${this.align}px 栅格：${key} ${v} → ${this.pads[key]}`);
    }
  }

  /** 设置原图缩放（0.05–8）；边距按画布像素保留，随后重新对齐栅格 */
  setScale(value, statusText) {
    if (!this.srcW) {
      this.setStatus("先导入图片再缩放");
      return;
    }
    this.scale = clamp(Number(value) || 1, 0.05, 8);
    this.syncScaled();
    this.pads = this.snap({ ...this.pads }, "");
    this.dirty = true;
    this.fitView();
    this.syncSide();
    this.draw();
    this.setStatus(statusText || `原图缩放 ${Math.round(this.scale * 1000) / 10}% → ${this.w} × ${this.h}`);
  }

  /** 按「画布总像素」反算缩放：解 (s·W + 左右 pad)(s·H + 上下 pad) = 目标像素 */
  applyTargetMP(mp) {
    if (!this.srcW) {
      this.setStatus("先导入图片再按 MP 反算");
      return;
    }
    const a = this.srcW;
    const b = this.srcH;
    const pw = this.pads.left + this.pads.right;
    const ph = this.pads.top + this.pads.bottom;
    const target = mp * 1048576;
    const A = a * b;
    const B = a * ph + b * pw;
    const C = pw * ph - target;
    const disc = Math.max(0, B * B - 4 * A * C);
    const k = (-B + Math.sqrt(disc)) / (2 * A);
    this.setScale(k, `按画布 ${mp} MP 反算：原图缩放 ${(k * 100).toFixed(1)}%`);
  }

  growAll(px) {
    const next = {};
    for (const k of PAD_KEYS) next[k] = Math.min(MAX_EDGE, r0(this.pads[k]) + px);
    this.pads = this.snap(next, "");
    this.dirty = true;
    this.fitView();
    this.syncSide();
    this.draw();
    this.setStatus(`四边各 +${px}px`);
  }

  /** 目标画布：原图居中放置，四边均分剩余空间 */
  setTarget(w, h) {
    if (!this.w) {
      this.setStatus("先导入图片，再设置目标画布");
      return;
    }
    const a = Math.max(1, Math.round(Number(this.align) || 1));
    const roundUp = (v) => (a > 1 ? Math.ceil(v / a) * a : Math.round(v));
    let W = clamp(roundUp(Number(w) || 0), 1, MAX_EDGE);
    let H = clamp(roundUp(Number(h) || 0), 1, MAX_EDGE);
    if (W < this.w) W = roundUp(this.w);
    if (H < this.h) H = roundUp(this.h);

    const left = Math.floor((W - this.w) / 2);
    const top = Math.floor((H - this.h) / 2);
    this.pads = { left, top, right: W - this.w - left, bottom: H - this.h - top };
    this.dirty = true;
    this.fitView();
    this.syncSide();
    this.draw();
    this.setStatus(`目标画布 ${W} × ${H}：原图居中扩展`);
  }

  /** 比例预设：在「包含原图 + 两边落在对齐格」的前提下，挑比例最接近目标的那组尺寸 */
  applyPreset(text) {
    const [rw, rh] = String(text).split(":").map((n) => Number(n));
    if (!rw || !rh) return;
    if (!this.w) {
      this.setStatus("先导入图片，再选比例");
      return;
    }
    const a = Math.max(1, Math.round(Number(this.align) || 1));
    const up = (v) => (a > 1 ? Math.ceil(v / a) * a : Math.round(v));
    const near = (v) => (a > 1 ? Math.round(v / a) * a : Math.round(v));
    const r = rw / rh;

    // 栅格越粗，能同时满足「整除 + 精确比例」的尺寸越稀疏，所以往后多试几档
    let best = null;
    const start = up(Math.max(this.w, this.h * r));
    for (let i = 0; i <= 24; i++) {
      const W = start + i * a;
      const H = Math.max(up(this.h), near(W / r));
      const err = Math.abs(W / H - r) / r;
      if (!best || err < best.err - 1e-9) best = { W, H, err };
      if (err < 0.008) break;
    }
    this.setTarget(best.W, best.H);
    this.setStatus(
      `按 ${rw}:${rh} 扩展为 ${best.W} × ${best.H}（比例误差 ${(best.err * 100).toFixed(1)}%）`
    );
  }

  /* ---------- 右侧参数区（模型 / 提示词 / 采样 / 存盘） ---------- */

  /** 生成单个字段的控件（按 widget 类型决定 select / number / textarea / checkbox） */
  paramFieldHtml(name, label) {
    const w = getWidget(this.node, name);
    if (!w) return "";
    const v = w.value;
    const val = v === null || v === undefined ? "" : v;

    if (Array.isArray(w.options?.values)) {
      const opts = w.options.values
        .map((o) => `<option value="${esc(o)}"${String(o) === String(val) ? " selected" : ""}>${esc(o)}</option>`)
        .join("");
      return `<label class="qie-field"><span>${esc(label)}</span><select data-param="${name}">${opts}</select></label>`;
    }
    if (w.type === "toggle" || typeof v === "boolean") {
      return `<label class="qie-field qie-inline"><span>${esc(label)}</span><input type="checkbox" data-param="${name}"${v ? " checked" : ""}></label>`;
    }
    if (name === "prompt" || name === "negative_prompt") {
      return `<label class="qie-field"><span>${esc(label)}</span><textarea rows="${name === "prompt" ? 4 : 3}" data-param="${name}">${esc(val)}</textarea></label>`;
    }
    if (typeof v === "number") {
      const step = w.options?.step ?? 1;
      const row = name === "seed";
      const input = `<input type="number" data-param="${name}" value="${esc(val)}" step="${esc(step)}"${
        w.options?.min !== undefined ? ` min="${w.options.min}"` : ""
      }${w.options?.max !== undefined ? ` max="${w.options.max}"` : ""}>`;
      return row
        ? `<label class="qie-field"><span>${esc(label)}</span><div class="qie-seedrow">${input}<button class="qie-btn" data-act="roll-seed" title="换一个随机种子">随机</button></div></label>`
        : `<label class="qie-field"><span>${esc(label)}</span>${input}</label>`;
    }
    return `<label class="qie-field"><span>${esc(label)}</span><input type="text" data-param="${name}" value="${esc(val)}"></label>`;
  }

  paramSummary(key) {
    const g = PARAM_GROUPS.find((x) => x.key === key);
    if (!g) return "";
    const bite = (name, max = 22) => {
      const w = getWidget(this.node, name);
      if (!w) return "";
      const t = String(w.value ?? "");
      const shortName = t.split(/[\\/]/).pop() || t;
      return shortName.length > max ? shortName.slice(0, max - 1) + "…" : shortName;
    };
    if (key === "model") return bite("unet_name", 20) + (getWidget(this.node, "lora_name")?.value && !/^无/.test(String(getWidget(this.node, "lora_name").value)) ? " +LoRA" : "");
    if (key === "prompt") {
      const t = String(getWidget(this.node, "prompt")?.value || "").replace(/\s+/g, " ").trim();
      return t.length > 18 ? t.slice(0, 18) + "…" : t;
    }
    if (key === "sample") {
      const st = getWidget(this.node, "steps")?.value;
      const cfg = getWidget(this.node, "cfg")?.value;
      const smp = getWidget(this.node, "sampler_name")?.value;
      return `${st}步 · CFG ${cfg} · ${smp}`;
    }
    if (key === "output") return getWidget(this.node, "save_image")?.value ? "保存" : "不保存";
    return "";
  }

  renderParams() {
    if (!this.dom.params) return;
    const groups = PARAM_GROUPS.filter((g) => g.fields.some(([name]) => !!getWidget(this.node, name)));
    if (!groups.length) {
      this.dom.params.innerHTML = "";
      return;
    }
    this.dom.params.innerHTML = groups
      .map((g) => {
        const body = g.fields.map(([name, label]) => this.paramFieldHtml(name, label)).join("");
        if (!body) return "";
        return `<details class="qie-fold" data-group="${g.key}"${g.open ? " open" : ""}>
  <summary><span>${esc(g.title)}</span><b class="qie-fold-sum">${esc(this.paramSummary(g.key))}</b></summary>
  <div class="qie-fold-body">${body}</div>
</details>`;
      })
      .join("");
  }

  /** 把右侧参数写回节点 widget（点「确定」时调用） */
  applyParams() {
    if (!this.dom.params) return 0;
    let n = 0;
    for (const el of this.dom.params.querySelectorAll("[data-param]")) {
      const name = el.dataset.param;
      const w = getWidget(this.node, name);
      if (!w) continue;
      let v = el.type === "checkbox" ? el.checked : el.value;
      if (w.type === "number" || typeof w.value === "number") {
        const num = Number(v);
        if (!Number.isFinite(num)) continue;
        v = num;
      }
      setWidgetValue(this.node, name, v);
      n++;
    }
    return n;
  }

  /* ---------- 侧栏同步 ---------- */

  syncPads() {
    for (const k of PAD_KEYS) {
      const input = this.root.querySelector(`[data-pad="${k}"]`);
      if (input) input.value = String(this.pads[k]);
    }
  }

  syncSide() {
    this.syncPads();
    if (this.w) {
      const out = outputSize(this.readStateLocal(), this.pads);
      this.dom.tw.value = String(out.w);
      this.dom.th.value = String(out.h);
      this.dom.scale.value = String(Math.round(this.scale * 1000) / 10);
    }
    const zoomed = Math.abs(this.scale - 1) > 1e-6;
    this.dom.src.innerHTML = this.w
      ? `<b>${esc(this.image.split("/").pop())}</b><br>原图 <span class="qie-dim">${this.srcW} × ${this.srcH}</span>` +
        (zoomed ? ` → 缩放后 <span class="qie-dim">${this.w} × ${this.h}</span>` : "")
      : "未导入";
    this.updateOut();
  }

  updateOut() {
    if (!this.w) {
      this.dom.out.textContent = "导入图片后显示输出尺寸";
      this.dom.warn.classList.remove("on");
      return;
    }
    const out = outputSize(this.readStateLocal(), this.pads);
    const mp = (out.w * out.h) / 1048576;
    this.dom.out.innerHTML =
      `<b>${out.w} × ${out.h}</b> · ${mp.toFixed(2)} MP · 扩边 ${this.pads.left}/${this.pads.top}/${this.pads.right}/${this.pads.bottom}` +
      `<br>扩展区域填充 rgb(${this.fill},${this.fill},${this.fill})`;

    const a = Math.max(1, Math.round(Number(this.align) || 1));
    const warns = [];
    if (a > 1 && (out.w % a || out.h % a)) {
      warns.push(`输出尺寸不是 ${a} 的倍数，Qwen 2.1 要求画布是 32 的倍数；可用「目标画布」对齐`);
    }
    if (mp > 2.0) {
      warns.push(`输出 ${mp.toFixed(2)} MP，超出 Qwen 2.1 Outpaint LoRA 训练范围（v1 ≤1MP / v2 1–2MP），点「画布 1MP」可自动把原图缩下来`);
    }
    if (this.scale > 2.0) {
      warns.push(`原图被放大 ${this.scale.toFixed(1)} 倍：放大不会增加细节，建议保持 ≤100%`);
    }
    this.dom.warn.innerHTML = warns.map((t) => `⚠ ${esc(t)}`).join("<br>");
    this.dom.warn.classList.toggle("on", warns.length > 0);
    this.dom.sub.textContent = `${this.w} × ${this.h} → ${out.w} × ${out.h} · ${mp.toFixed(2)}MP`;
  }

  setStatus(text) {
    this.dom.status.textContent = text || "";
  }

  /* ---------- 导入 ---------- */

  async importFiles(fileList) {
    const files = Array.from(fileList || []).filter(
      (f) => f.type?.startsWith("image/") || /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(f.name || "")
    );
    if (!files.length) return;

    this.dom.ok.disabled = true;
    this.setStatus(`正在上传：${files[0].name}`);
    try {
      const name = await uploadImage(files[0]);
      const im = await loadImage(name);
      this.images.set(name, im);
      const same = im.width === this.srcW && im.height === this.srcH;
      this.image = name;
      this.srcW = im.width;
      this.srcH = im.height;
      this.img = im;
      if (!same) {
        // 换图后旧的边距/缩放没有意义，重置重新开始
        this.pads = { left: 0, top: 0, right: 0, bottom: 0 };
        this.scale = 1;
      }
      this.syncScaled();
      this.dirty = true;
      this.fitView();
      this.syncSide();
      this.draw();
      this.setStatus(`已导入 ${im.width} × ${im.height}，拖动矩形四条边向外扩展`);
    } catch (err) {
      console.error("[QwenImageExpand] 导入失败", err);
      this.setStatus(`导入失败：${files[0].name}`);
    } finally {
      this.dom.ok.disabled = false;
    }
  }

  async ensureImageThenDraw() {
    if (!this.image || !this.w) return;
    if (!this.img) {
      try {
        this.img = await loadImage(this.image);
        this.images.set(this.image, this.img);
      } catch (err) {
        console.warn("[QwenImageExpand]", err.message);
      }
    }
    this.syncSide();
    this.draw();
  }

  /* ---------- 提交 ---------- */

  commit() {
    // 落盘前再对齐一次：从旧工作流读进来的边距可能不是 32 的倍数
    // （Qwen 2.1 编码器会把参考图取整到 32，导致输出比画布少 1~31px、原图位移）
    this.pads = this.snap({ ...this.pads }, "");
    const pads = Object.fromEntries(PAD_KEYS.map((k) => [k, Math.max(0, r0(this.pads[k]))]));
    const st = {
      image: this.image,
      width: this.srcW,
      height: this.srcH,
      scale: Math.round(clamp(this.scale, 0.05, 8) * 1000) / 1000,
      fill: this.fill,
      align: this.align,
    };
    this.node.__qieImages = this.images;
    setWidgetValue(this.node, "fill_gray", clamp(r0(this.fill), 0, 255));
    setWidgetValue(this.node, "src_scale", st.scale);
    this.applyParams();
    // 参数或画布变了，上一轮的对比图失效
    this.node.__qieResult = null;
    this.node.__qieResultImg = null;
    this.node.__qieError = null;
    this.node.__qieProgress = null;
    this.node.__qieView = "result";
    updateToggleLabel(this.node);
    writeState(this.node, st, pads);
    refreshPreview(this.node);
    this.close();
  }

  tryClose() {
    if (this.dirty && this.w && !window.confirm("放弃本次图像扩展修改？")) return;
    this.close();
  }

  close(silent) {
    if (this._closed) return;
    this._closed = true;
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onResize);
    this.root.remove();
    if (activeEditor === this) activeEditor = null;
    if (silent !== true) this.node.setDirtyCanvas?.(true, true);
  }
}

function openEditor(node) {
  if (activeEditor) {
    if (activeEditor.node === node) return;
    activeEditor.close(true);
  }
  activeEditor = new ExpandEditor(node);
  // 调试钩子：只有页面显式设了 window.__QIE_DEBUG__ 才暴露，方便 CDP 自动化测试
  if (window.__QIE_DEBUG__) window.__qieEditor = activeEditor;
}

/* ------------------------------------------------------------- 节点外壳 */

function hideWidget(node, name) {
  const w = getWidget(node, name);
  if (!w || w.__qieHidden) return;
  w.__qieHidden = true;
  w.computeSize = () => [0, -4];
  if (!w.element) w.draw = () => {};
  if (w.element && w.element.style) {
    w.element.style.display = "none";
    w.element.style.height = "0px";
  }
}

function hideAllExtraWidgets(node) {
  hideWidget(node, "expand_json");
  const list = HIDDEN_WIDGETS[node?.comfyClass] || [];
  for (const name of list) hideWidget(node, name);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 计算 widget 区域底边，用于让预览框从 widget 下方一直铺到节点底部 */
function nodeContentBottom(node) {
  const width = node?.size?.[0] || 320;
  const widgets = node?.widgets || [];
  let bottom = 0;

  for (const w of widgets) {
    if (w.__qieHidden) continue;
    const ly = Number(w.last_y);
    if (!Number.isFinite(ly) || ly <= 0) continue;
    let hgt = 24;
    try {
      const cs = w.computeSize?.(width);
      if (cs && cs[1] > 0) hgt = cs[1];
    } catch (err) {
      /* 某些 widget 的 computeSize 需要更多参数，忽略 */
    }
    bottom = Math.max(bottom, ly + hgt);
  }

  const visible = widgets.filter((w) => !w.__qieHidden).length;
  return Math.max(bottom, 30 + visible * 28);
}

function previewBox(node) {
  const size = node?.size;
  if (!size || size.length < 2) return null;

  const pad = 10;
  const w = size[0];
  const h = size[1];
  const boxW = w - pad * 2;
  const boxY = nodeContentBottom(node) + 6;
  const boxH = h - boxY - pad;
  if (boxW < 60 || boxH < 40) return null;
  return { x: pad, y: boxY, w: boxW, h: boxH };
}

/** 一体节点卡片用的尺寸信息 */
function pipelineInfo(node) {
  const st = readState(node);
  const pads = readPads(node);
  if (!st.width) return null;
  const sc = scaledSize(st);
  const out = outputSize(st, pads);
  return {
    srcW: st.width,
    srcH: st.height,
    w: sc.w,
    h: sc.h,
    outW: out.w,
    outH: out.h,
    scale: st.scale,
    mp: (out.w * out.h) / 1048576,
  };
}

/** 当前该显示哪张：'result'（生成结果）或 'canvas'（灰底画布 = 原图 + 128 灰边） */
function viewMode(node) {
  if (!(node.__qieResultImg && node.__qieResultImg.width)) return "canvas"; // 还没生成，只能看画布
  return node.__qieView === "canvas" ? "canvas" : "result";
}

/** 切换按钮的文案跟着当前视图走（文案是「点了会看到什么」） */
function updateToggleLabel(node) {
  const btn = node.__qieToggle;
  if (!btn) return;
  const mode = viewMode(node);
  const hasResult = !!(node.__qieResultImg && node.__qieResultImg.width);
  btn.name = hasResult ? (mode === "result" ? "⇄ 看灰底画布" : "⇄ 看生成结果") : "⇄ 看生成结果（还没生成）";
  node.setDirtyCanvas?.(true, true);
}

function toggleView(node) {
  if (!(node.__qieResultImg && node.__qieResultImg.width)) {
    node.__qieView = "canvas";
    updateToggleLabel(node);
    return;
  }
  node.__qieView = viewMode(node) === "result" ? "canvas" : "result";
  updateToggleLabel(node);
}

/** 把图片按比例 fit 进矩形，返回实际绘制区域 */
function drawFitted(ctx, x, y, w, h, img) {
  const k = Math.min(w / img.width, h / img.height);
  const dw = Math.max(1, img.width * k);
  const dh = Math.max(1, img.height * k);
  const px = x + (w - dw) / 2;
  const py = y + (h - dh) / 2;
  ctx.drawImage(img, px, py, dw, dh);
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 0.5, py + 0.5, dw - 1, dh - 1);
  return { x: px, y: py, w: dw, h: dh };
}

/** 左上角的小标签 */
function drawTag(ctx, text, x, y, align = "left") {
  ctx.save();
  ctx.font = "10px system-ui,sans-serif";
  const tw = ctx.measureText(text).width + 12;
  const bx = align === "right" ? x - tw : x;
  ctx.fillStyle = "rgba(8,8,12,.72)";
  ctx.fillRect(bx, y, tw, 16);
  ctx.fillStyle = "rgba(226,232,245,.94)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + 6, y + 9);
  ctx.restore();
}

/** 一体节点：进度 + 原图→输出尺寸 + 生成完切成「灰底输入 / 生成结果」对比 */
function drawPipelineCard(node, ctx) {
  const box = previewBox(node);
  if (!box) return;

  const pad = 8;
  const x = box.x + pad;
  const y = box.y + pad;
  const w = box.w - pad * 2;
  const h = box.h - pad * 2;
  if (w < 60 || h < 50) return;

  ctx.save();
  ctx.fillStyle = "#0e0e13";
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  ctx.stroke();

  const info = pipelineInfo(node);
  const prog = node.__qieProgress;
  const headH = 20;
  ctx.font = "11px system-ui,sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255,255,255,0.62)";
  const head = info
    ? `原图 ${info.srcW}×${info.srcH}${Math.abs(info.scale - 1) > 1e-6 ? ` · ${Math.round(info.scale * 100)}%` : ""} → 输出 ${info.outW}×${info.outH} · ${info.mp.toFixed(2)}MP`
    : "点上方按钮：导入图片并拖边框扩展";
  ctx.fillText(head, x + 9, y + 11);

  let bodyY = y + headH;
  if (prog) {
    const bx = x + 9;
    const by = y + headH + 5;
    const bw = w - 18;
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(bx, by, bw, 4);
    const ratio = prog.max > 0 ? Math.min(1, prog.value / prog.max) : 0.08;
    ctx.fillStyle = "#4a67ea";
    ctx.fillRect(bx, by, bw * ratio, 4);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.textAlign = "right";
    ctx.fillText(prog.max > 0 ? `生成中 ${prog.value}/${prog.max}` : "生成中…", x + w - 9, y + 11);
    ctx.textAlign = "left";
    bodyY = by + 11;
  }

  const bw2 = w - 18;
  const bh2 = y + h - bodyY - 8;
  if (bh2 < 24) {
    ctx.restore();
    return;
  }

  const mode = viewMode(node);
  const img = mode === "result" ? node.__qieResultImg : node.__qiePreview;
  if (img && img.width) {
    const area = drawFitted(ctx, x + 9, bodyY, bw2, bh2, img);
    if (area.h > 34 && area.w > 90) {
      drawTag(ctx, mode === "result" ? "生成结果" : "灰底画布（原图 + 灰边）", area.x + 5, area.y + 5, "left");
    }
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.32)";
    ctx.textAlign = "center";
    ctx.fillText("还没有画布，点上方按钮导入图片", x + w / 2, bodyY + bh2 / 2);
    ctx.textAlign = "left";
  }

  if (node.__qieError) {
    ctx.fillStyle = "rgba(224,108,117,.95)";
    ctx.textAlign = "center";
    ctx.fillText("执行失败，详见控制台", x + w / 2, y + h - 8);
    ctx.textAlign = "left";
  }
  ctx.restore();
}

function drawNodePreview(node, ctx) {
  const box = previewBox(node);
  if (!box) return;

  const pv = node.__qiePreview;
  const { x: boxX, y: boxY, w: boxW, h: boxH } = box;

  ctx.save();
  ctx.fillStyle = "#101015";
  roundRect(ctx, boxX, boxY, boxW, boxH, 6);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  ctx.stroke();

  if (pv && pv.width && pv.height) {
    const k = Math.min(boxW / pv.width, boxH / pv.height);
    const dw = pv.width * k;
    const dh = pv.height * k;
    const dx = boxX + (boxW - dw) / 2;
    const dy = boxY + (boxH - dh) / 2;
    ctx.drawImage(pv, dx, dy, dw, dh);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.strokeRect(dx, dy, dw, dh);
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("点击上方按钮导入图片并扩展", boxX + boxW / 2, boxY + boxH / 2 + 4);
    ctx.textAlign = "left";
  }
  ctx.restore();
}

let runtimeBound = false;

/** 执行状态 → 节点卡片（进度条 / 对比视图 / 错误提示）。全局只绑一次。 */
function bindRuntimeEvents() {
  if (runtimeBound || typeof api?.addEventListener !== "function") return;
  runtimeBound = true;

  const findNode = (id) => {
    if (id === null || id === undefined) return null;
    const n = app.graph?.getNodeById?.(Number(id));
    return n && n.comfyClass === "Qwen21Outpaint" ? n : null;
  };

  api.addEventListener("executing", (ev) => {
    const n = findNode(ev.detail);
    if (!n) return;
    // 开始跑：清掉上一轮结果，进入进度态
    n.__qieResult = null;
    n.__qieResultImg = null;
    n.__qieError = null;
    n.__qieProgress = { value: 0, max: 0 };
    n.__qieView = "canvas"; // 生成过程中先看灰底画布
    updateToggleLabel(n);
    n.setDirtyCanvas?.(true, true);
    refreshPreview(n);
  });

  api.addEventListener("progress", (ev) => {
    const d = ev.detail || {};
    const n = findNode(d.node);
    if (!n) return;
    n.__qieProgress = { value: Number(d.value) || 0, max: Number(d.max) || 0 };
    n.setDirtyCanvas?.(true, true);
  });

  api.addEventListener("execution_error", (ev) => {
    const n = findNode(ev.detail?.node_id);
    if (!n) return;
    n.__qieProgress = null;
    n.__qieError = ev.detail?.exception_message || "执行失败";
    n.setDirtyCanvas?.(true, true);
  });
}

function setupNode(node) {
  if (node.__qieReady) return;
  node.__qieReady = true;
  node.__qieImages = node.__qieImages || new Map();

  hideAllExtraWidgets(node);
  bindRuntimeEvents();

  const btn = node.addWidget("button", "🖼 打开扩展编辑器", null, () => openEditor(node));
  btn.serialize = false;
  btn.serialize_widget = false;
  btn.options = Object.assign(btn.options || {}, { serialize: false });
  // 按钮挪到控件最上方，别被一长串参数挤到节点底部（serialize=false，不影响存档）
  const idx = node.widgets.indexOf(btn);
  if (idx > 0) {
    node.widgets.splice(idx, 1);
    node.widgets.unshift(btn);
  }
  node.__qieBtn = btn;

  const pipeline = node.comfyClass === "Qwen21Outpaint";
  if (pipeline) {
    // 只看一张图：按钮在原图（灰底画布）与生成结果之间切换
    const tg = node.addWidget("button", "⇄ 看生成结果（还没生成）", null, () => toggleView(node));
    tg.serialize = false;
    tg.serialize_widget = false;
    tg.options = Object.assign(tg.options || {}, { serialize: false });
    const i2 = node.widgets.indexOf(tg);
    if (i2 >= 0) node.widgets.splice(i2, 1);
    const i1 = node.widgets.indexOf(btn);
    node.widgets.splice(i1 >= 0 ? i1 + 1 : 0, 0, tg);
    node.__qieToggle = tg;
    updateToggleLabel(node);
  }
  const minH = pipeline ? 520 : 220;
  if (!node.size || node.size[1] < minH) {
    node.setSize?.(pipeline ? [430, 700] : [380, 380]);
  }
  updateButtonLabel(node);
  setTimeout(() => hideAllExtraWidgets(node), 60);
}

app.registerExtension({
  name: "QwenImageExpand.Editor",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_CLASSES.includes(nodeData?.name)) return;
    injectCSS();

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      setupNode(this);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      hideAllExtraWidgets(this);
      this.__qieImages = this.__qieImages || new Map();
      updateButtonLabel(this);
      refreshPreview(this);
      setTimeout(() => hideAllExtraWidgets(this), 60);
      return r;
    };

    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = onDrawForeground?.apply(this, arguments);
      try {
        if (this.comfyClass === "Qwen21Outpaint") drawPipelineCard(this, ctx);
        else drawNodePreview(this, ctx);
      } catch (err) {
        /* 预览绘制失败不影响节点本身 */
      }
      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted?.apply(this, arguments);
      // 后端把结果放在自定义 ui key（qie_preview），避免前端在节点下方再挂一张大图
      const imgs = message?.qie_preview || message?.images;
      if (this.comfyClass === "Qwen21Outpaint" && Array.isArray(imgs) && imgs.length) {
        this.__qieResult = imgs[0];
        this.__qieProgress = null;
        this.__qieView = "result"; // 生成完默认显示结果
        ensureResultImage(this).then(() => updateToggleLabel(this));
        updateToggleLabel(this);
      }
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      if (activeEditor && activeEditor.node === this) activeEditor.close(true);
      return onRemoved?.apply(this, arguments);
    };
  },

  nodeCreated(node) {
    if (NODE_CLASSES.includes(node.comfyClass)) setupNode(node);
  },
});
