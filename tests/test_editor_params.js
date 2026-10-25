/**
 * 前端参数面板测试（jsdom）：一体节点把模型/提示词/采样/存盘搬进编辑器右侧栏
 *
 * 覆盖：四个折叠分组渲染 → 控件值来自节点 widget → 修改后点「确定」写回 widget
 *      → 随机种子按钮 → 摘要行
 *
 * 运行：node tests/test_editor_params.js
 */
const fs = require("fs");
const path = require("path");
// jsdom 来源：环境变量 → 本地 node_modules → 开发机缓存路径（CI 里用 `npm i jsdom`）
function loadJsdom() {
  const candidates = [
    process.env.JSDOM_PATH,
    "jsdom",
    "C:/Users/wanet/AppData/Local/Temp/workbuddy-update-x64/plm_harness/node_modules/jsdom",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      return require(c);
    } catch (err) {
      /* 试下一个 */
    }
  }
  throw new Error("找不到 jsdom：请先 `npm i jsdom`，或设置环境变量 JSDOM_PATH 指向它的目录");
}
const { JSDOM } = loadJsdom();

const SRC = path.resolve(__dirname, "..", "web", "js", "qwen_image_expand.js");

let passed = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
  console.log("  ✓ " + msg);
};
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "http://localhost:8188/",
});
const { window } = dom;
const { document } = window;

const makeCtx = () =>
  new Proxy(
    {},
    {
      get(t, k) {
        if (k === "measureText") return (s) => ({ width: String(s).length * 6 });
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

window.Image = class FakeImage {
  constructor() {
    this.width = 0;
    this.height = 0;
  }
  set src(v) {
    this._src = v;
    setTimeout(() => {
      this.width = 300;
      this.height = 200;
      this.onload && this.onload();
    }, 0);
  }
  get src() {
    return this._src;
  }
};
window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ name: "x.png", subfolder: "qwen_image_expand" }) });

const extensions = [];
window.__app = { registerExtension: (ext) => extensions.push(ext), graph: { setDirtyCanvas() {}, getNodeById: () => null } };
window.__api = { apiURL: (p) => p };

let code = fs.readFileSync(SRC, "utf8").replace(/^import[^;]*;\s*$/gm, "");
code = `const app = window.__app; const api = window.__api;\n${code}\nwindow.__qie = { editor: () => activeEditor };\n`;
window.eval(code);

const UNET = "qwen_image_2.1_turbo_int8_convrot.safetensors";
const LORA = "Qwen2.1\\Qwen21-图像扩展qwen-image-2.1-outpaint-v2.safetensors";
const PROMPT = "Outpaint the image: replace the solid gray areas with a seamless continuation.";

function makeNode(NodeType) {
  function N() {}
  N.prototype = new NodeType();
  const node = new N();
  node.comfyClass = "Qwen21Outpaint";
  node.size = new Float32Array([430, 560]);
  node.widgets = [
    { type: "combo", name: "unet_name", value: UNET, options: { values: [UNET, "other.safetensors"] } },
    { type: "combo", name: "clip_name", value: "qwen3vl_8b_bf16.safetensors", options: { values: ["qwen3vl_8b_bf16.safetensors"] } },
    { type: "combo", name: "vae_name", value: "qwen_image_2.1_vae_bf16.safetensors", options: { values: ["qwen_image_2.1_vae_bf16.safetensors"] } },
    { type: "combo", name: "lora_name", value: LORA, options: { values: ["无（不加载）", LORA] } },
    { type: "number", name: "strength_model", value: 1, options: { min: -10, max: 10, step: 0.01 } },
    { type: "customtext", name: "prompt", value: PROMPT, options: {} },
    { type: "customtext", name: "negative_prompt", value: "blurry, low quality", options: {} },
    { type: "number", name: "seed", value: 12345, options: { min: 0, max: 1e15, step: 1 } },
    { type: "combo", name: "control_after_generate", value: "randomize", options: { values: ["fixed", "randomize"], serialize: false } },
    { type: "number", name: "steps", value: 4, options: { min: 1, max: 200, step: 1 } },
    { type: "number", name: "cfg", value: 1, options: { min: 0, max: 20, step: 0.01 } },
    { type: "combo", name: "sampler_name", value: "euler", options: { values: ["euler", "dpmpp_2m"] } },
    { type: "combo", name: "scheduler", value: "simple", options: { values: ["simple", "karras"] } },
    { type: "number", name: "resolution", value: 0, options: { min: 0, max: 4096, step: 32 } },
    { type: "number", name: "pad_left", value: 26, options: { min: 0, max: 8192, step: 1 } },
    { type: "number", name: "pad_top", value: 28, options: { min: 0, max: 8192, step: 1 } },
    { type: "number", name: "pad_right", value: 26, options: { min: 0, max: 8192, step: 1 } },
    { type: "number", name: "pad_bottom", value: 28, options: { min: 0, max: 8192, step: 1 } },
    { type: "number", name: "fill_gray", value: 128, options: { min: 0, max: 255, step: 1 } },
    { type: "text", name: "expand_json", value: JSON.stringify({ version: 1, image: "qwen_image_expand/api_test.png", width: 300, height: 200, scale: 1, fill: 128, align: 32, pads: { left: 26, top: 28, right: 26, bottom: 28 } }), options: {} },
    { type: "number", name: "src_scale", value: 1, options: { min: 0.05, max: 8, step: 0.01 } },
    { type: "toggle", name: "save_image", value: true, options: {} },
    { type: "text", name: "filename_prefix", value: "QwenOutpaint", options: {} },
  ];
  for (const w of node.widgets) {
    const el = document.createElement("input");
    document.body.appendChild(el);
    if (w.name === "expand_json" || w.name === "prompt" || w.name === "negative_prompt") w.element = el;
  }
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

(async () => {
  const ext = extensions[0];
  ok(!!ext, "扩展已注册");
  const NodeType = function () {};
  NodeType.prototype.onNodeCreated = function () {};
  NodeType.prototype.onConfigure = function () {};
  NodeType.prototype.onDrawForeground = function () {};
  NodeType.prototype.onRemoved = function () {};
  NodeType.prototype.onExecuted = function () {};

  await ext.beforeRegisterNodeDef(NodeType, { name: "Qwen21Outpaint" });
  const node = makeNode(NodeType);
  node.onNodeCreated();
  ext.nodeCreated(node);

  /* 1. 节点上 = 两个按钮 + 扩边 6 项 */
  const visible = node.widgets.filter((w) => !w.__qieHidden);
  const expandNames = ["pad_left", "pad_top", "pad_right", "pad_bottom", "fill_gray", "src_scale"];
  ok(
    visible.length === 8 &&
      visible[0].type === "button" &&
      /编辑/.test(visible[0].name) &&
      visible[1].type === "button" &&
      /⇄/.test(visible[1].name) &&
      visible.slice(2).every((w, i) => w.name === expandNames[i]),
    `节点上 = 编辑/切换两个按钮 + 扩边 6 项：${visible.map((w) => w.name).join(",")}`
  );

  /* 1.5 切换按钮：原图 ↔ 生成结果 */
  ok(/看生成结果/.test(visible[1].name), "没有结果时按钮提示还没生成：" + visible[1].name);
  node.__qieResultImg = { width: 40, height: 30 };
  node.__qieView = "result";
  node.__qieToggle.name = "⇄ 看灰底画布";
  visible[1].callback(); // 切到原图
  ok(node.__qieView === "canvas", "点按钮 → 看灰底画布");
  ok(/看生成结果/.test(node.__qieToggle.name), "按钮文案变成「看生成结果」：" + node.__qieToggle.name);
  visible[1].callback(); // 切回结果
  ok(node.__qieView === "result", "再点一次 → 回到生成结果");
  ok(/看灰底画布/.test(node.__qieToggle.name), "按钮文案变回「看灰底画布」：" + node.__qieToggle.name);
  node.__qieResultImg = null;
  node.__qieView = undefined;

  /* 2. 打开编辑器 → 四个参数分组 */
  node.widgets[0].callback();
  await tick(60);
  const ed = window.__qie.editor();
  ok(!!ed, "编辑器已打开");
  const folds = [...document.querySelectorAll(".qie-fold")];
  ok(folds.length === 4, `右侧栏渲染 4 个参数分组（实际 ${folds.length}）`);
  ok(
    folds.map((f) => f.dataset.group).join(",") === "model,prompt,sample,output",
    "分组顺序：模型 → 提示词 → 采样 → 存盘"
  );
  ok(folds.every((f) => !f.open), "默认全部折叠，侧栏一屏放得下");

  /* 3. 摘要行 */
  const sums = [...document.querySelectorAll(".qie-fold-sum")].map((s) => s.textContent);
  ok(/qwen_image_2\.1_turb/.test(sums[0]) && /\+LoRA/.test(sums[0]), "模型摘要：" + sums[0]);
  ok(/^Outpaint the image/.test(sums[1]), "提示词摘要：" + sums[1]);
  ok(sums[2].includes("4步") && sums[2].includes("CFG 1"), "采样摘要：" + sums[2]);
  ok(sums[3] === "保存", "存盘摘要：" + sums[3]);

  /* 4. 控件值来自节点 widget */
  const modelSel = document.querySelector('[data-param="unet_name"]');
  ok(modelSel && modelSel.value === UNET, "主模型下拉选中当前值");
  ok(modelSel.querySelectorAll("option").length === 2, "主模型选项来自 widget.options.values");
  const promptArea = document.querySelector('[data-param="prompt"]');
  ok(promptArea && promptArea.tagName === "TEXTAREA" && promptArea.value === PROMPT, "提示词用多行文本框并带当前值");
  const saveBox = document.querySelector('[data-param="save_image"]');
  ok(saveBox && saveBox.type === "checkbox" && saveBox.checked, "存盘开关是勾选框且已勾选");

  /* 5. 改值 → 确定 → 写回 widget */
  promptArea.value = "Outpaint the image: extend the sky.";
  document.querySelector('[data-param="steps"]').value = "6";
  document.querySelector('[data-param="cfg"]').value = "1.5";
  document.querySelector('[data-param="sampler_name"]').value = "dpmpp_2m";
  document.querySelector('[data-param="resolution"]').value = "1024";
  document.querySelector('[data-param="filename_prefix"]').value = "MyOutpaint";
  saveBox.checked = false;
  const seedInput = document.querySelector('[data-param="seed"]');
  const seedBefore = Number(seedInput.value);
  document.querySelector('[data-act="roll-seed"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok(Number(seedInput.value) !== seedBefore, `随机种子按钮生效（${seedBefore} → ${seedInput.value}）`);

  document.querySelector('[data-act="ok"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(60);
  ok(!document.querySelector(".qie-mask"), "确定后弹窗关闭");
  ok(W(node, "prompt") === "Outpaint the image: extend the sky.", "prompt 已写回节点：" + W(node, "prompt"));
  ok(W(node, "steps") === 6 && W(node, "cfg") === 1.5, `steps/cfg 已写回（${W(node, "steps")}/${W(node, "cfg")}）`);
  ok(W(node, "sampler_name") === "dpmpp_2m" && W(node, "resolution") === 1024, "采样器/分辨率已写回");
  ok(W(node, "save_image") === false && W(node, "filename_prefix") === "MyOutpaint", "存盘设置已写回");
  ok(W(node, "seed") === Number(seedInput.value), "随机后的种子已写回");

  /* 6. 数值字段做了类型转换（不是字符串） */
  ok(typeof W(node, "steps") === "number" && typeof W(node, "cfg") === "number", "数字字段写回为 number");
  ok(typeof W(node, "prompt") === "string", "文本字段仍是 string");

  /* 7. 取消不改值 */
  node.widgets[0].callback();
  await tick(50);
  document.querySelector('[data-param="prompt"]').value = "临时改动";
  document.querySelector('[data-act="cancel"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(50);
  ok(W(node, "prompt") === "Outpaint the image: extend the sky.", "取消不会写回改动");

  console.log(`\n✅ 参数面板测试通过（${passed} 项断言）`);
  process.exit(0);
})().catch((err) => {
  console.error("\n❌ " + err.message);
  process.exit(1);
});
