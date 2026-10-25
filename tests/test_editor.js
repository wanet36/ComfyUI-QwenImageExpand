/**
 * 前端编辑器逻辑测试（jsdom）
 * 覆盖：注册 → 按钮 → 弹窗 → 导入图片 → 拖动矩形四条边外扩 / 向内收缩 → 比例预设 →
 *      目标画布 → 填充灰度 → 确定写回 → 重开读回 → 节点预览绘制
 *
 * 运行：node tests/test_editor.js
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { JSDOM } = require("C:/Users/wanet/AppData/Local/Temp/workbuddy-update-x64/plm_harness/node_modules/jsdom");

const PKG_DIR = path.resolve(__dirname, "..");
const SRC = path.join(PKG_DIR, "web", "js", "qwen_image_expand.js");

let passed = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
  console.log("  ✓ " + msg);
};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const dom = new JSDOM(`<!DOCTYPE html><html><body><canvas id="graph"></canvas></body></html>`, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "http://localhost:8188/",
});
const { window } = dom;
const { document } = window;

/* ---------- 最小 Canvas 2D 桩（measureText 需要返回宽度） ---------- */
const makeCtx = () =>
  new Proxy(
    {},
    {
      get(t, k) {
        if (k === "measureText") return (s) => ({ width: String(s).length * 6 });
        if (k === "createPattern") return () => ({});
        if (k in t) return t[k];
        return () => {};
      },
      set(t, k, v) {
        t[k] = v;
        return true;
      },
    }
  );
window.HTMLCanvasElement.prototype.getContext = function () {
  return makeCtx();
};
window.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, right: 1024, bottom: 1024, width: 1024, height: 1024 };
};
window.confirm = () => true;

/* ---------- Image / fetch 桩 ---------- */
let uploadSeq = 0;
const sizes = {};
window.Image = class FakeImage {
  constructor() {
    this.width = 0;
    this.height = 0;
  }
  set src(v) {
    this._src = v;
    const name = decodeURIComponent(v).match(/filename=([^&]+)/)?.[1] || "x.png";
    const s = sizes[name] || { w: 200, h: 100 };
    setTimeout(() => {
      this.width = s.w;
      this.height = s.h;
      this.onload && this.onload();
    }, 0);
  }
  get src() {
    return this._src;
  }
};

window.fetch = async (url, init) => {
  if (!String(url).includes("/upload/image")) throw new Error("unexpected fetch " + url);
  const file = init.body.get("image");
  uploadSeq++;
  const name = `uploaded_${uploadSeq}_${file.name}`;
  sizes[name] = { w: 400, h: 300 };
  return { ok: true, status: 200, json: async () => ({ name, subfolder: "qwen_image_expand", type: "input" }) };
};

/* ---------- app / api 桩 ---------- */
const extensions = [];
window.__app = {
  registerExtension: (ext) => extensions.push(ext),
  graph: { setDirtyCanvas() {} },
};
window.__api = { apiURL: (p) => p };

/* ---------- 加载被测代码 ---------- */
let code = fs.readFileSync(SRC, "utf8").replace(/^import[^;]*;\s*$/gm, "");
code = `const app = window.__app; const api = window.__api;\n${code}\nwindow.__qie = { editor: () => activeEditor, openEditor, previewBox, buildPreviewCanvas };\n`;
window.eval(code);

ok(extensions.length === 1, "扩展已注册");
const ext = extensions[0];
ok(ext.name === "QwenImageExpand.Editor", "扩展名称正确");

/* ---------- 伪造 ComfyUI 节点 ---------- */
function makeNodeType() {
  function NodeType() {}
  NodeType.prototype.onNodeCreated = function () {};
  NodeType.prototype.onConfigure = function () {};
  NodeType.prototype.onDrawForeground = function () {};
  NodeType.prototype.onRemoved = function () {};
  return NodeType;
}

function makeNode(NodeType) {
  const node = new NodeType();
  node.comfyClass = "QwenImageExpand";
  node.size = new Float32Array([360, 340]);
  node.widgets = [
    { type: "number", name: "pad_left", value: 0 },
    { type: "number", name: "pad_top", value: 0 },
    { type: "number", name: "pad_right", value: 0 },
    { type: "number", name: "pad_bottom", value: 0 },
    { type: "number", name: "fill_gray", value: 128 },
    { type: "text", name: "expand_json", value: '{"version":1}' },
    { type: "number", name: "src_scale", value: 1 },
  ];
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  node.widgets[5].element = textarea;
  node.addWidget = function (type, name, value, callback, options) {
    const w = { type, name, value, callback, options: options || {} };
    this.widgets.push(w);
    return w;
  };
  node.setSize = function (s) {
    this.size = new Float32Array(s);
  };
  node.setDirtyCanvas = function () {};
  return node;
}

const W = (node, name) => node.widgets.find((w) => w.name === name).value;
const drag = (ed, from, dx, dy) => {
  const canvas = document.querySelector(".qie-canvas");
  canvas.dispatchEvent(new window.MouseEvent("pointerdown", { clientX: from[0], clientY: from[1], button: 0, bubbles: true }));
  canvas.dispatchEvent(new window.MouseEvent("pointermove", { clientX: from[0] + dx, clientY: from[1] + dy, bubbles: true }));
  canvas.dispatchEvent(new window.MouseEvent("pointerup", { clientX: from[0] + dx, clientY: from[1] + dy, button: 0, bubbles: true }));
};

(async () => {
  const NodeType = makeNodeType();
  await ext.beforeRegisterNodeDef(NodeType, { name: "QwenImageExpand" });
  ok(typeof NodeType.prototype.onNodeCreated === "function", "prototype 已挂钩");

  const node = makeNode(NodeType);
  node.onNodeCreated();
  ext.nodeCreated(node);

  /* 1. 按钮 & 隐藏 JSON widget */
  const btn = node.widgets.find((w) => w.name.includes("扩展编辑器"));
  ok(!!btn, "已添加编辑器按钮：" + btn.name);
  ok(btn.serialize === false && btn.options.serialize === false, "按钮不参与序列化");
  ok(node.widgets.find((w) => w.name === "expand_json").element.style.display === "none", "expand_json 输入框已隐藏");

  /* 2. 打开弹窗（空态） */
  btn.callback();
  await tick(30);
  let ed = window.__qie.editor();
  ok(!!ed && document.querySelector(".qie-mask"), "点击按钮打开编辑器弹窗");
  ok(ed.w === 0 && ed.pads.left === 0, "未导入图片时状态为空");
  ok(/导入图片后显示输出尺寸/.test(document.querySelector(".qie-out").textContent), "空态给出提示文案");

  /* 3. 导入图片 */
  const fileInput = document.querySelector('.qie-toolbar input[type="file"]');
  Object.defineProperty(fileInput, "files", {
    value: [new window.File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" })],
    configurable: true,
  });
  fileInput.dispatchEvent(new window.Event("change"));
  await tick(40);

  ok(ed.w === 400 && ed.h === 300, `导入后原图尺寸 400×300（实际 ${ed.w}×${ed.h}）`);
  ok(ed.image.includes("qwen_image_expand/"), "上传到 qwen_image_expand 子目录：" + ed.image);
  ok(ed.pads.left === 0 && ed.pads.right === 0 && ed.pads.top === 0, "导入后四边边距为 0");
  ok(/400 × 300/.test(document.querySelector(".qie-out").textContent), "侧栏显示输出 400 × 300");
  ok(/photo\.png/.test(document.querySelector(".qie-src").textContent), "侧栏显示原图文件名");

  /* 3.5 原图缩放 */
  const scaleInput = document.querySelector('[data-k="scale"]');
  scaleInput.value = "50";
  scaleInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  ok(Math.abs(ed.scale - 0.5) < 1e-9 && ed.w === 200 && ed.h === 150, `缩放 50% → 200 × 150（实际 ${ed.w}×${ed.h}）`);
  ok(/200 × 150/.test(document.querySelector(".qie-out").textContent), "输出尺寸跟随缩放");

  document.querySelector('[data-scale="0.25"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok(Math.abs(ed.scale - 0.25) < 1e-9 && ed.w === 100 && ed.h === 75, `点 25% → 100 × 75（实际 ${ed.w}×${ed.h}）`);

  document.querySelector('[data-act="scale-reset"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok(ed.scale === 1 && ed.w === 400, "点 100% 复位到原尺寸");

  // 按画布 MP 反算：400×300=0.11MP → 1MP 需要约 2.96 倍放大
  document.querySelector('[data-mp="1"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const mpCanvas = (ed.w + ed.pads.left + ed.pads.right) * (ed.h + ed.pads.top + ed.pads.bottom) / 1048576;
  ok(Math.abs(ed.scale - 2.96) < 0.1, `1MP 反算得到缩放 ${(ed.scale * 100).toFixed(0)}%`);
  ok(Math.abs(mpCanvas - 1) < 0.05, `反算后画布 ${mpCanvas.toFixed(2)} MP ≈ 1.00 MP`);
  ok(document.querySelector(".qie-warn").classList.contains("on"), "放大 >2 倍时给出告警");

  // 缩放后边距仍按画布像素保留并重新对齐
  ed.pads = { left: 64, top: 32, right: 64, bottom: 32 };
  scaleInput.value = "40";
  scaleInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  ok(ed.w === 160 && ed.h === 120, `缩到 40% → ${ed.w} × ${ed.h}`);
  ok((ed.w + ed.pads.left + ed.pads.right) % 32 === 0, "缩放后画布仍对齐 32");

  document.querySelector('[data-act="scale-reset"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ed.pads = { left: 0, top: 0, right: 0, bottom: 0 };

  /* 4. 向外拖右边 → 右侧扩展，且输出宽度落在 16 的倍数上 */
  const before = { ...ed.pads };
  const rightEdge = ed.handlePoints().e;
  drag(ed, rightEdge, 120, 0);
  ok(ed.pads.right > before.right, `右侧手柄外拉 → pad_right ${before.right} → ${ed.pads.right}`);
  ok((ed.w + ed.pads.left + ed.pads.right) % 32 === 0, `输出宽度 ${ed.w + ed.pads.left + ed.pads.right} 是 32 的倍数（Qwen 2.1 要求）`);
  ok(ed.pads.right > 0 && (400 + ed.pads.right) % 32 === 0, `向右拉 120px → 扩展 ${ed.pads.right}px，总宽落在 32 栅格`);
  ok(ed.pads.left === 0 && ed.pads.top === 0, "只影响被拖动的那一边");
  ok(/输出 480 × 300/.test(document.querySelector(".qie-status").textContent), "状态栏回显输出尺寸");

  /* 5. 向内拖回 → 收缩到 0，不为负 */
  drag(ed, ed.handlePoints().e, -1200, 0);
  ok(ed.pads.right === 0, `向内拖动收缩到 0（实际 ${ed.pads.right}）`);

  /* 6. 左边 + 左上角 */
  drag(ed, ed.handlePoints().w, -80, 0);
  ok(ed.pads.left > 0 && ed.pads.right === 0, `左侧外拉 → pad_left = ${ed.pads.left}`);
  const leftBefore = ed.pads.left;
  drag(ed, ed.handlePoints().nw, -48, -48);
  ok(ed.pads.top > 0 && ed.pads.left > leftBefore, `左上角外拉 → 上 ${ed.pads.top} / 左 ${ed.pads.left}`);
  ok((ed.h + ed.pads.top + ed.pads.bottom) % 32 === 0, "输出高度也是 32 的倍数");

  /* 7. 清零 / +64 四边 */
  document.querySelector('[data-act="reset"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok(ed.pads.left === 0 && ed.pads.top === 0 && ed.pads.right === 0 && ed.pads.bottom === 0, "清零边距生效");
  document.querySelector('[data-act="grow"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok(ed.pads.left > 0 && ed.pads.top > 0 && ed.pads.right > 0 && ed.pads.bottom > 0, "四边 +64 生效");

  /* 8. 目标画布：原图居中，四边均分 */
  const tw = document.querySelector('[data-k="tw"]');
  const th = document.querySelector('[data-k="th"]');
  tw.value = "800";
  th.value = "600";
  document.querySelector('[data-act="target"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok(ed.pads.left === 200 && ed.pads.right === 200, `800×600 目标：左右各 200（${ed.pads.left}/${ed.pads.right}）`);
  ok(
    ed.pads.top === ed.pads.bottom && ed.pads.top >= 150,
    `800×600 目标：上下均分，600 不是 16 的倍数 → 608，上下各 ${ed.pads.top}`
  );
  ok((ed.h + ed.pads.top + ed.pads.bottom) % 32 === 0, "目标画布高度自动对齐到 32");

  // 超过 LoRA 训练范围（1-2MP）时给出告警
  tw.value = "3000";
  th.value = "2400";
  document.querySelector('[data-act="target"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const warn = document.querySelector(".qie-warn");
  ok(warn.classList.contains("on") && /MP/.test(warn.textContent), "超 2MP 时告警：" + warn.textContent.slice(0, 40));
  tw.value = "800";
  th.value = "600";
  document.querySelector('[data-act="target"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  /* 9. 比例预设 */
  const preset = (r) =>
    document.querySelector(`[data-ratio="${r}"]`).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  preset("1:1");
  let outW = ed.w + ed.pads.left + ed.pads.right;
  let outH = ed.h + ed.pads.top + ed.pads.bottom;
  ok(outW === outH, `1:1 → ${outW} × ${outH}`);
  ok(Math.abs(ed.pads.top - ed.pads.bottom) <= 16, "1:1 时原图纵向居中");
  ok(ed.pads.left <= 32 && ed.pads.right <= 32, `1:1 时横向只补最少边距（${ed.pads.left}/${ed.pads.right}）`);

  preset("16:9");
  outW = ed.w + ed.pads.left + ed.pads.right;
  outH = ed.h + ed.pads.top + ed.pads.bottom;
  ok(outW >= 400 && outH >= 300, `16:9 画布包含原图：${outW} × ${outH}`);
  ok(Math.abs(outW / outH - 16 / 9) < 0.06, `16:9 比例近似成立（${(outW / outH).toFixed(3)}）`);
  ok(outW % 32 === 0 && outH % 32 === 0, "预设尺寸仍落在 32 栅格上");

  preset("9:16");
  outW = ed.w + ed.pads.left + ed.pads.right;
  outH = ed.h + ed.pads.top + ed.pads.bottom;
  ok(outH > outW, `9:16 → 竖向画布 ${outW} × ${outH}`);
  ok(Math.abs(outW / outH - 9 / 16) < 0.06, `9:16 比例近似成立（${(outW / outH).toFixed(3)}）`);

  /* 10. 填充灰度 */
  const fillInput = document.querySelector('[data-k="fill"]');
  fillInput.value = "200";
  fillInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  ok(ed.fill === 200, "填充灰度改为 200");
  fillInput.value = "128";
  fillInput.dispatchEvent(new window.Event("change", { bubbles: true }));

  /* 11. 侧栏数字输入 */
  const padRightInput = document.querySelector('[data-pad="right"]');
  padRightInput.value = "150";
  padRightInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  ok(ed.pads.right > 0 && (ed.w + ed.pads.left + ed.pads.right) % 32 === 0, `数字输入 150 → 对齐后 ${ed.pads.right}`);
  padRightInput.value = "-30";
  padRightInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  ok(ed.pads.right >= 0 && (400 + ed.pads.left + ed.pads.right) % 32 === 0, `负数输入不产生负边距，输出仍对齐（右 ${ed.pads.right}）`);

  /* 12. 确定 → 写回 widget */
  ed.pads = { left: 32, top: 16, right: 64, bottom: 16 };
  document.querySelector('[data-act="ok"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(40);

  ok(!document.querySelector(".qie-mask"), "确定后弹窗关闭");
  ok(W(node, "pad_left") === 32 && W(node, "pad_top") === 16, "pad_left / pad_top 已写入");
  ok(W(node, "pad_right") > 0 && W(node, "pad_bottom") >= 0, `pad_right / pad_bottom 已写入（${W(node, "pad_right")}/${W(node, "pad_bottom")}，确定时按 32 对齐过）`);
  const saved = JSON.parse(W(node, "expand_json"));
  ok(saved.image === ed.image && saved.width === 400 && saved.height === 300, "expand_json 记录原图与尺寸");
  ok(saved.pads.right === W(node, "pad_right") && saved.align === 32, "expand_json 记录边距与对齐（32 栅格）");
  ok(W(node, "src_scale") === 1 && saved.scale === 1, "src_scale widget 与 JSON 同步（默认 1）");
  const outAfter = 400 + saved.pads.left + saved.pads.right;
  const outAfterH = 300 + saved.pads.top + saved.pads.bottom;
  ok(outAfter % 32 === 0 && outAfterH % 32 === 0, `落盘时强制对齐 32（${outAfter}×${outAfterH}）`);
  ok(/→ 512×320/.test(btn.name), "按钮标题显示输出尺寸：" + btn.name);

  /* 13. 后端可消费前端产物 */
  const py = execSync(
    `python -c "import sys,json;sys.path.insert(0,'${PKG_DIR.replace(/\\/g, "/")}');import expand;st=expand.parse_state(sys.stdin.read());print(st['image'] and st['width'], st['pads']['right'], st['pads']['left'])"`,
    { input: JSON.stringify(saved), encoding: "utf8" }
  );
  ok(py.trim() === `400 ${saved.pads.right} ${saved.pads.left}`, "后端 parse_state 正确解析前端 JSON：" + py.trim());

  /* 14. 重新打开能读回 */
  btn.callback();
  await tick(40);
  ed = window.__qie.editor();
  ok(ed.w === 400 && ed.h === 300, "重开读回原图尺寸");
  ok(
    ed.pads.left === saved.pads.left && ed.pads.right === saved.pads.right && ed.pads.top === saved.pads.top,
    `重开读回四边边距（${ed.pads.left}/${ed.pads.right}/${ed.pads.top}）`
  );
  const seen = document.querySelector('[data-pad="left"]').value;
  ok(seen === "32", "侧栏输入框回填：" + seen);
  ed.close(true);

  /* 15. onConfigure（工作流加载）→ 预览 + 绘制不抛错 */
  const node2 = makeNode(NodeType);
  node2.widgets.find((w) => w.name === "pad_right").value = 64;
  node2.widgets.find((w) => w.name === "pad_left").value = 32;
  node2.widgets.find((w) => w.name === "pad_top").value = 16;
  node2.widgets.find((w) => w.name === "pad_bottom").value = 16;
  node2.widgets.find((w) => w.name === "expand_json").value = JSON.stringify(saved);
  node2.onConfigure({});
  await tick(80);
  ok(node2.__qiePreview && node2.__qiePreview.width > 0, "工作流加载后生成节点预览");
  ok(node2.size[1] >= 340, "有预览时节点保留展示高度");

  node2.onDrawForeground(makeCtx());
  ok(true, "onDrawForeground 正常绘制预览（无异常）");

  /* 16. 预览画布几何：灰度底 + 原图偏移 */
  const pv = window.__qie.buildPreviewCanvas(
    { image: "a.png", width: 400, height: 300, fill: 128 },
    { left: 40, top: 0, right: 40, bottom: 0 },
    null,
    512
  );
  ok(pv.width === 480 && pv.height === 300, `预览画布尺寸 = 输出尺寸（${pv.width}×${pv.height}）`);

  /* 17. 预览框几何 */
  node2.setSize([360, 340]);
  const b1 = window.__qie.previewBox(node2);
  node2.setSize([360, 640]);
  const b2 = window.__qie.previewBox(node2);
  ok(!!b1 && !!b2 && b2.y === b1.y, "预览框顶边固定在 widget 下方");
  ok(Math.abs(b2.h - b1.h - 300) < 1e-6, `节点拉高 300px → 预览框高度 ${b1.h} → ${b2.h}`);
  node2.setSize([360, 150]);
  ok(window.__qie.previewBox(node2) === null || window.__qie.previewBox(node2).h < 60, "节点过矮时不画预览");

  console.log(`\n✅ 前端逻辑全部通过（${passed} 项断言）`);
  process.exit(0);
})().catch((err) => {
  console.error("\n❌ " + err.message);
  process.exit(1);
});
