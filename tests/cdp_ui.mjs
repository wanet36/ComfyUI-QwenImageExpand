/**
 * 真机 UI 测试（无头 Chrome + CDP，零依赖：Node 22 自带 WebSocket）
 *
 * 覆盖：真实 ComfyUI 前端加载扩展 → 建节点 → 点按钮开弹窗 → 载入已有图片 →
 *      鼠标真实拖动右边框外扩 → 截图 → 点确定写回 widget。
 *
 * 前置：ComfyUI 在 127.0.0.1:8188 运行，插件已装到 custom_nodes，
 *      且 input/qwen_image_expand/api_test.png 存在（先跑 tests/api_smoke.py）。
 *
 * 运行：node tests/cdp_ui.mjs
 * 产物：tests/out/ 下 3 张截图
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9377;
const BASE = "http://127.0.0.1:8188";
const PROF = `C:/Users/wanet/AppData/Local/Temp/qie_prof_${Date.now()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
  console.log("  ✓ " + msg);
};

async function debugTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((p) => p.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch (e) {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error("连不上 Chrome 调试端口");
}

function client(ws) {
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (ev) => {
    const d = JSON.parse(ev.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === "Runtime.exceptionThrown") {
      const e = d.params.exceptionDetails;
      errors.push((e.exception && e.exception.description) || e.text);
    } else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") {
      const msg = d.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      // ComfyUI 自身的 vite 预加载告警与本插件无关，忽略
      if (!/vite:preloadError|preload/i.test(msg)) errors.push(msg);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("CDP 超时: " + method));
        }
      }, 40000);
    });
  const js = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result.exceptionDetails) {
      throw new Error("页面异常: " + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    }
    return r.result.result.value;
  };
  return { call, js, errors };
}

async function shot(c, name) {
  const r = await c.call("Page.captureScreenshot", { format: "png" });
  const file = join(OUT, name);
  writeFileSync(file, Buffer.from(r.result.data, "base64"));
  return file;
}

async function mouse(c, type, x, y, extra = {}) {
  await c.call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1, ...extra });
}

(async () => {
  mkdirSync(OUT, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROF}`,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--force-device-scale-factor=1",
      "--window-size=1500,1000",
      `${BASE}/`,
    ],
    { stdio: "ignore" }
  );

  try {
    const target = await debugTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    const c = client(ws);
    await c.call("Runtime.enable");
    await c.call("Page.enable");

    // 等前端就绪
    for (let i = 0; i < 90; i++) {
      if (await c.js("!!(window.app && window.app.graph && window.LiteGraph)")) break;
      await sleep(500);
    }
    await sleep(2500);
    ok(await c.js("!!(window.app && app.graph)"), "ComfyUI 前端已加载");

    // 1. 建节点
    const made = await c.js(`(() => {
      const n = LiteGraph.createNode("QwenImageExpand");
      if (!n) return "no-node";
      n.pos = [120, 120];
      app.graph.add(n);
      window.__n = n;
      n.setSize([380, 360]);
      const set = (k, v) => { const w = n.widgets.find((x) => x.name === k); if (w) w.value = v; };
      set("expand_json", JSON.stringify({ version: 1, image: "qwen_image_expand/api_test.png", width: 300, height: 200, fill: 128, align: 32, pads: { left: 0, top: 0, right: 0, bottom: 0 } }));
      n.onConfigure && n.onConfigure({});
      return n.widgets.map((w) => w.name).join(",");
    })()`);
    ok(typeof made === "string" && made.includes("pad_right"), "节点创建成功，widget：" + made);

    const btnLabel = await c.js(
      `(() => { const b = window.__n.widgets.find((w) => w.name.includes("🖼")); return b ? b.name : "missing"; })()`
    );
    ok(btnLabel !== "missing", "节点上有编辑器按钮：" + btnLabel);

    // 2. 点按钮开弹窗
    ok(
      await c.js(`(async () => {
        window.__QIE_DEBUG__ = true;
        const b = window.__n.widgets.find((w) => w.name.includes("🖼"));
        b.callback();
        await new Promise((r) => setTimeout(r, 1200));
        return !!document.querySelector(".qie-mask");
      })()`),
      "点击按钮打开编辑弹窗"
    );

    const geom = await c.js(`(() => {
      const cv = document.querySelector(".qie-canvas");
      const ed = window.__qieEditor;
      if (!cv || !ed) return "missing";
      const r = cv.getBoundingClientRect();
      return JSON.stringify({
        cw: cv.width, ch: cv.height, cssW: Math.round(r.width), cssH: Math.round(r.height),
        left: Math.round(r.left), top: Math.round(r.top),
        img: [ed.w, ed.h], pads: ed.pads, view: +ed.view.toFixed(3),
        out: document.querySelector(".qie-out").textContent.replace(/\\s+/g, " ").trim(),
        src: document.querySelector(".qie-src").textContent.replace(/\\s+/g, " ").trim(),
        handles: document.querySelectorAll(".qie-canvas").length,
      });
    })()`);
    ok(geom !== "missing", "弹窗 canvas 已渲染");
    const g = JSON.parse(geom);
    ok(g.img[0] === 300 && g.img[1] === 200, `载入既有图片 300×200（实际 ${g.img.join("×")}）`);
    ok(g.cssW > 400 && g.cssH > 300, `画布区域尺寸 ${g.cssW}×${g.cssH}`);
    ok(/300 × 200/.test(g.out), "侧栏输出信息：" + g.out);
    await shot(c, "cdp_editor_open.png");

    // 2.5 原图缩放（侧栏 50% 按钮）
    const sc = JSON.parse(
      await c.js(`(async () => {
        document.querySelector('[data-scale="0.5"]').click();
        await new Promise((r) => setTimeout(r, 300));
        const ed = window.__qieEditor;
        return JSON.stringify({ scale: ed.scale, w: ed.w, h: ed.h, out: document.querySelector(".qie-out").textContent.replace(/\\s+/g, " ") });
      })()`)
    );
    ok(Math.abs(sc.scale - 0.5) < 1e-9 && sc.w === 150 && sc.h === 100, `点 50% → 原图缩到 ${sc.w}×${sc.h}`);
    ok(/150 × 100/.test(sc.out), "输出尺寸跟随缩放：" + sc.out);
    await shot(c, "cdp_editor_scale.png");
    await c.js(`(async () => { document.querySelector('[data-act="scale-reset"]').click(); await new Promise((r) => setTimeout(r, 250)); return 1; })()`);
    ok(await c.js("window.__qieEditor.scale === 1 && window.__qieEditor.w === 300"), "点 100% 复位到原尺寸");

    // 3. 真实鼠标拖动右边框（外扩）
    const handle = JSON.parse(
      await c.js(`(() => {
        const cv = document.querySelector(".qie-canvas");
        const r = cv.getBoundingClientRect();
        const p = window.__qieEditor.handlePoints().e;
        return JSON.stringify({ x: Math.round(r.left + p[0]), y: Math.round(r.top + p[1]) });
      })()`)
    );
    await mouse(c, "mouseMoved", handle.x, handle.y, { button: "none" });
    await mouse(c, "mousePressed", handle.x, handle.y, { buttons: 1 });
    for (let i = 1; i <= 6; i++) {
      await mouse(c, "mouseMoved", handle.x + i * 25, handle.y, { buttons: 1, button: "left" });
      await sleep(60);
    }
    await mouse(c, "mouseReleased", handle.x + 150, handle.y, { buttons: 0 });
    await sleep(400);

    const after = JSON.parse(
      await c.js(`(() => { const ed = window.__qieEditor; return JSON.stringify({ pads: ed.pads, w: ed.w + ed.pads.left + ed.pads.right }); })()`)
    );
    ok(after.pads.right > 0, `拖动右边框外扩 → pad_right = ${after.pads.right}`);
    ok(after.w % 32 === 0, `输出宽度 ${after.w} 对齐到 32（Qwen 2.1 要求）`);
    ok(after.pads.left === 0 && after.pads.top === 0, "未拖动方向保持不变");
    await shot(c, "cdp_editor_drag.png");

    // 4. 缩放滚轮 + 比例预设（真实交互不报错）
    await c.js(`(() => { const s = document.querySelector('[data-ratio="16:9"]'); s.click(); return 1; })()`);
    await sleep(500);
    const ratio = JSON.parse(
      await c.js(`(() => { const ed = window.__qieEditor; const W = ed.w + ed.pads.left + ed.pads.right; const H = ed.h + ed.pads.top + ed.pads.bottom; return JSON.stringify({ W, H }); })()`)
    );
    ok(Math.abs(ratio.W / ratio.H - 16 / 9) < 0.02, `16:9 预设生效且比例很准：${ratio.W} × ${ratio.H}（${(ratio.W / ratio.H).toFixed(3)}）`);
    await shot(c, "cdp_editor_169.png");

    // 5. 确定 → 写回 widget
    const written = await c.js(`(async () => {
      document.querySelector('[data-act="ok"]').click();
      await new Promise((r) => setTimeout(r, 900));
      const g = (k) => { const w = window.__n.widgets.find((x) => x.name === k); return w ? w.value : null; };
      return JSON.stringify({
        closed: !document.querySelector(".qie-mask"),
        pad_left: g("pad_left"), pad_top: g("pad_top"), pad_right: g("pad_right"), pad_bottom: g("pad_bottom"),
        fill: g("fill_gray"),
        src_scale: g("src_scale"),
        state: JSON.parse(g("expand_json")),
        btn: window.__n.widgets.find((w) => w.name.includes("🖼"))?.name,
        preview: !!window.__n.__qiePreview,
      });
    })()`);
    const wr = JSON.parse(written);
    ok(wr.closed, "确定后弹窗关闭");
    ok(wr.pad_right === ratio.W - 300 - wr.pad_left, `pad_* 已写回（左${wr.pad_left} 右${wr.pad_right} 上${wr.pad_top} 下${wr.pad_bottom}）`);
    ok(wr.state.image === "qwen_image_expand/api_test.png" && wr.state.align === 32, "expand_json 同步更新（align 32）");
    ok(wr.src_scale === 1, "src_scale widget 已写回：" + wr.src_scale);
    ok(wr.preview, "节点预览已生成");
    ok(/→ \d+×\d+/.test(wr.btn || ""), "按钮标题带输出尺寸：" + wr.btn);

    await sleep(600);
    await shot(c, "cdp_node_preview.png");

    // 6. 旧工作流（只有 6 个控件值，没有 src_scale）必须按位置正确映射
    const legacy = JSON.parse(
      await c.js(`(async () => {
        const state = { version: 1, image: "qwen_image_expand/api_test.png", width: 300, height: 200,
                        fill: 128, align: 32, pads: { left: 0, top: 0, right: 64, bottom: 0 } };
        await app.loadGraphData({
          last_node_id: 1, last_link_id: 0,
          nodes: [{
            id: 1, type: "QwenImageExpand", pos: [120, 120], size: [380, 360], flags: {}, order: 0, mode: 0,
            inputs: [], outputs: [{ name: "image", type: "IMAGE", links: [], slot_index: 0 }],
            properties: {},
            widgets_values: [0, 0, 64, 0, 128, JSON.stringify(state)],
          }],
          links: [], groups: [], config: {}, extra: {}, version: 0.4,
        });
        await new Promise((r) => setTimeout(r, 1200));
        const n = app.graph.getNodeById(1);
        if (!n) return JSON.stringify({ error: "node missing" });
        const g = (k) => n.widgets.find((w) => w.name === k)?.value;
        return JSON.stringify({
          pad_left: g("pad_left"), pad_top: g("pad_top"), pad_right: g("pad_right"), pad_bottom: g("pad_bottom"),
          fill: g("fill_gray"), scale: g("src_scale"),
          image: JSON.parse(g("expand_json") || "{}").image,
          btn: n.widgets.find((w) => w.name.includes("🖼"))?.name,
        });
      })()`)
    );
    ok(legacy.pad_right === 64 && legacy.pad_left === 0 && legacy.pad_bottom === 0, `旧档 6 值按位置映射不变：右 ${legacy.pad_right}`);
    ok(legacy.fill === 128 && legacy.image === "qwen_image_expand/api_test.png", "旧档 fill / expand_json 未错位");
    ok(legacy.scale === 1, "旧档缺少 src_scale → 自动用默认 1（不错位、不报错）");
    ok(/300×200 → 364×200/.test(legacy.btn || ""), "旧档按钮标题正常：" + legacy.btn);
    await shot(c, "cdp_legacy_load.png");

    // 只关心本插件引起的异常；ComfyUI 其它扩展的启动告警不计入
    const ours = c.errors.filter((e) => /qwen_image_expand|QwenImageExpand|qie-/i.test(e));
    ok(ours.length === 0, "本插件无 JS 异常" + (ours.length ? "：" + ours.slice(0, 3).join(" | ") : ""));
    if (c.errors.length) console.log(`  （忽略 ${c.errors.length} 条其它扩展/外挂的启动告警）`);
    console.log(`\n✅ 真机 UI 测试通过（${passed} 项断言），截图见 tests/out/`);
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error("\n❌ " + err.message);
    process.exit(1);
  } finally {
    setTimeout(() => chrome.kill(), 500);
  }
})();
