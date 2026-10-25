/**
 * 真机 UI 测试：一体节点 Qwen21Outpaint（无头 Chrome + CDP）
 *
 * 覆盖：建节点 → 按钮在最上 → 扩边参数被隐藏但仍在序列化里 → 打开编辑器 → 拖动扩边
 *      → 确定写回隐藏 widget → graphToPrompt 里参数正确
 *
 * 前置：ComfyUI 在 127.0.0.1:8188 运行，插件已装到 custom_nodes。
 * 运行：node tests/cdp_pipeline.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9383;
const PROF = `C:/Users/wanet/AppData/Local/Temp/qie_pipe_${Date.now()}`;
const IMAGE = "qwen_image_expand/api_test.png";

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
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((p) => p.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error("连不上 Chrome 调试端口");
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const chrome = spawn(
    CHROME,
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROF}`, "--headless=new", "--disable-gpu",
     "--no-first-run", "--force-device-scale-factor=1", "--window-size=1500,1000", "http://127.0.0.1:8188/"],
    { stdio: "ignore" }
  );

  try {
    const t = await debugTarget();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener("message", (ev) => {
      const d = JSON.parse(ev.data);
      if (d.id && pending.has(d.id)) {
        pending.get(d.id)(d);
        pending.delete(d.id);
      } else if (d.method === "Runtime.exceptionThrown") {
        errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
      }
    });
    const call = (method, params = {}) =>
      new Promise((resolve) => {
        id += 1;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const js = async (expr) => {
      const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description));
      return r.result?.result?.value;
    };

    await call("Runtime.enable");
    await call("Page.enable");
    for (let i = 0; i < 90; i++) {
      if (await js("!!(window.app && app.graph && window.LiteGraph)")) break;
      await sleep(500);
    }
    await sleep(2500);

    /* 1. 建节点 + 初始布局 */
    const info = JSON.parse(
      await js(`(async () => {
        const n = LiteGraph.createNode("Qwen21Outpaint");
        if (!n) return JSON.stringify({ error: "no node" });
        n.pos = [120, 80];
        app.graph.add(n);
        window.__n = n;
        const set = (k, v) => { const w = n.widgets.find((x) => x.name === k); if (w) w.value = v; };
        set("expand_json", JSON.stringify({ version: 1, image: "${IMAGE}", width: 300, height: 200, scale: 1, fill: 128, align: 32, pads: { left: 0, top: 0, right: 0, bottom: 0 } }));
        n.onConfigure && n.onConfigure({});
        await new Promise((r) => setTimeout(r, 900));
        const hidden = ["unet_name", "steps", "prompt", "expand_json", "save_image", "filename_prefix", "resolution"];
        return JSON.stringify({
          first: n.widgets[0].name,
          hidden: hidden.map((k) => {
            const w = n.widgets.find((x) => x.name === k);
            return [k, !!w, !!(w && w.__qieHidden), w ? (w.computeSize ? w.computeSize(300)[1] : null) : null];
          }),
          visible: n.widgets.filter((w) => !w.__qieHidden).map((w) => w.name),
          serialized: n.widgets.filter((w) => w.options?.serialize !== false && w.serialize !== false).length,
          size: [Math.round(n.size[0]), Math.round(n.size[1])],
          needH: Math.round(n.widgets.reduce((a, w) => a + (w.__qieHidden ? 0 : (w.computeSize ? w.computeSize(n.size[0])[1] : 24)), 0)),
        });
      })()`)
    );
    ok(info.first.includes("🖼"), "编辑器按钮排在最上方：" + info.first);
    ok(
      info.visible[0].includes("编辑") &&
        info.visible[1].includes("⇄") &&
        info.visible.slice(2).join(",") === "pad_left,pad_top,pad_right,pad_bottom,fill_gray,src_scale",
      `节点上 = 编辑/切换按钮 + 扩边 6 项（${info.visible.length} 个）：${info.visible.join(",")}`
    );
    ok(info.serialized >= 22, `参数仍全部参与序列化（${info.serialized} 项）`);
    ok(info.hidden.every(([k, exists, hidden, h]) => exists && hidden && h < 0), "模型/提示词/采样/存盘已隐藏但仍存在：" + info.hidden.map((x) => x[0]).join(","));
    ok(info.size[1] >= 380, `节点默认尺寸 ${info.size.join("×")}（卡片形态，不再被参数撑高）`);
    ok(info.size[1] >= info.needH, `控件总高 ${info.needH} 不超过节点高度 ${info.size[1]}`);

    /* 2. 打开编辑器 + 拖动扩边 */
    const drag = JSON.parse(
      await js(`(async () => {
        window.__QIE_DEBUG__ = true;
        const b = window.__n.widgets.find((w) => w.name.includes("🖼"));
        b.callback();
        await new Promise((r) => setTimeout(r, 1200));
        const cv = document.querySelector(".qie-canvas");
        const ed = window.__qieEditor;
        if (!cv || !ed) return JSON.stringify({ error: "no editor" });
        const r0 = ed.handlePoints().e;
        const rect = cv.getBoundingClientRect();
        const start = { x: Math.round(rect.left + r0[0]), y: Math.round(rect.top + r0[1]) };
        return JSON.stringify({ start, w: ed.w, h: ed.h });
      })()`)
    );
    ok(drag.w === 300 && drag.h === 200, `编辑器载入原图 ${drag.w}×${drag.h}`);

    await call("Input.dispatchMouseEvent", { type: "mousePressed", x: drag.start.x, y: drag.start.y, button: "left", clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 5; i++) {
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: drag.start.x + i * 30, y: drag.start.y, button: "left", buttons: 1 });
      await sleep(60);
    }
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: drag.start.x + 150, y: drag.start.y, buttons: 0 });
    await sleep(400);

    const pv = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "cdp_pipeline_editor.png"), Buffer.from(pv.result.data, "base64"));

    /* 3. 确定 → 隐藏 widget 写回 + graphToPrompt 校验 */
    const res = JSON.parse(
      await js(`(async () => {
        document.querySelector('[data-act="ok"]').click();
        await new Promise((r) => setTimeout(r, 900));
        const g = (k) => { const w = window.__n.widgets.find((x) => x.name === k); return w ? w.value : null; };
        const prompt = (await app.graphToPrompt()).output;
        const node = Object.values(prompt).find((v) => v.class_type === "Qwen21Outpaint");
        return JSON.stringify({
          closed: !document.querySelector(".qie-mask"),
          pad_right: g("pad_right"),
          fill: g("fill_gray"),
          scale: g("src_scale"),
          prompt_pad_right: node ? node.inputs.pad_right : null,
          prompt_resolution: node ? node.inputs.resolution : null,
          prompt_has_prompt: node ? typeof node.inputs.prompt === "string" && node.inputs.prompt.length > 20 : false,
          prompt_outputs: node ? Object.keys(node.inputs).length : 0,
          btn: window.__n.widgets[0].name,
        });
      })()`)
    );
    ok(res.closed, "确定后弹窗关闭");
    ok(res.pad_right > 0, `隐藏的 pad_right 已写回：${res.pad_right}`);
    ok(res.prompt_pad_right === res.pad_right, "graphToPrompt 里 pad_right 与控件一致");
    ok(res.prompt_resolution === 0, "resolution 默认 0（画布原尺寸）");
    ok(res.prompt_has_prompt, "prompt 文本已带进 API 参数");
    ok(res.prompt_outputs >= 20, `API 参数完整（${res.prompt_outputs} 项）`);
    ok(await js("!!window.__n.__qiePreview"), "节点卡片已备好灰底画布预览");
    ok(!/→/.test(res.btn), "按钮文案已简化（尺寸信息改画在卡片上）：" + res.btn);

    const pv2 = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "cdp_pipeline_node.png"), Buffer.from(pv2.result.data, "base64"));

    /* 4. 真机跑一次：节点卡片应切成「灰底输入 / 生成结果」对比 */
    await js(`(async () => {
      const set = (k, v) => { const w = window.__n.widgets.find((x) => x.name === k); if (w) w.value = v; };
      set("unet_name", "qwen_image_2.1_turbo_int8_convrot.safetensors");
      set("clip_name", "qwen3vl_8b_bf16.safetensors");
      set("vae_name", "qwen_image_2.1_vae_bf16.safetensors");
      set("lora_name", "Qwen2.1\\\\Qwen21-图像扩展qwen-image-2.1-outpaint-v2.safetensors");
      set("steps", 4); set("cfg", 1); set("resolution", 0);
      set("seed", Math.floor(Math.random() * 1000000)); // 每次都真跑，别命中缓存
      set("save_image", true); set("filename_prefix", "QwenUITest");
      // 画布调小 + 对齐 32，跑得快
      set("pad_left", 26); set("pad_right", 26); set("pad_top", 28); set("pad_bottom", 28);
      app.graph.setDirtyCanvas(true, true);
      await app.queuePrompt(0, 1);
      return 1;
    })()`);
    console.log("  … 已提交任务，等待生成完成（最长 6 分钟）");

    let done = false;
    for (let i = 0; i < 180; i++) {
      await sleep(2000);
      const st = JSON.parse(await js(`(() => {
        const n = window.__n;
        return JSON.stringify({
          result: !!n.__qieResult,
          img: !!(n.__qieResultImg && n.__qieResultImg.width),
          progress: n.__qieProgress || null,
          error: n.__qieError || null,
        });
      })()`));
      if (st.error) throw new Error("执行报错：" + st.error);
      if (st.result && st.img) {
        done = true;
        break;
      }
    }
    ok(done, "生成完成，结果图已加载到节点卡片");

    const doneInfo = JSON.parse(await js(`(() => {
      const n = window.__n;
      return JSON.stringify({
        file: n.__qieResult?.filename,
        w: n.__qieResultImg?.width,
        h: n.__qieResultImg?.height,
        canvasW: n.__qiePreview?.width,
        canvasH: n.__qiePreview?.height,
        progress: n.__qieProgress,
      });
    })()`));
    ok(!!doneInfo.file, `结果文件：${doneInfo.file}`);
    ok(doneInfo.w > 0 && doneInfo.canvasW > 0, `对比两侧都有图（生成 ${doneInfo.w}×${doneInfo.h} / 输入 ${doneInfo.canvasW}×${doneInfo.canvasH}）`);
    ok(doneInfo.progress === null, "进度条已收起");
    ok((await js("window.__n.__qieView")) === "result", "生成完默认显示生成结果");
    ok((await js("window.__n.__qieToggle.name")).includes("看灰底画布"), "切换按钮文案：看灰底画布");

    // 强制几帧重绘，确保卡片两侧的图都画上了再截图
    await js(`(async () => {
      for (let i = 0; i < 6; i++) {
        app.graph.setDirtyCanvas(true, true);
        try { app.canvas?.draw?.(true, true); } catch (e) {}
        await new Promise((r) => setTimeout(r, 250));
      }
      return 1;
    })()`);
    const pvRes = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "cdp_pipeline_result.png"), Buffer.from(pvRes.result.data, "base64"));

    /* 5. 按钮切换：生成结果 ↔ 原图（灰底画布） */
    const clickToggle = async () => {
      await js(`(async () => { window.__n.__qieToggle.callback(); await new Promise((r) => setTimeout(r, 350)); return 1; })()`);
      await js(`(async () => { for (let i = 0; i < 3; i++) { app.graph.setDirtyCanvas(true, true); try { app.canvas.draw(true, true); } catch (e) {} await new Promise((r) => setTimeout(r, 200)); } return 1; })()`);
    };

    await clickToggle();
    ok((await js("window.__n.__qieView")) === "canvas", "点按钮 → 切到原图（灰底画布）");
    ok((await js("window.__n.__qieToggle.name")).includes("看生成结果"), "按钮文案变成：看生成结果");
    const pvCanvas = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "cdp_pipeline_canvas.png"), Buffer.from(pvCanvas.result.data, "base64"));

    await clickToggle();
    ok((await js("window.__n.__qieView")) === "result", "再点一次 → 回到生成结果");
    ok((await js("window.__n.__qieToggle.name")).includes("看灰底画布"), "按钮文案变回：看灰底画布");

    const pv3 = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "cdp_pipeline_compare.png"), Buffer.from(pv3.result.data, "base64"));
    console.log("  截图：cdp_pipeline_result.png（生成结果）/ cdp_pipeline_canvas.png（原图灰底）/ cdp_pipeline_compare.png（切回结果）");

    const ours = errors.filter((e) => /qwen_image_expand|Qwen2|qie-/i.test(e || ""));
    ok(ours.length === 0, "本插件无 JS 异常" + (ours.length ? "：" + ours[0] : ""));
    console.log(`\n✅ 一体节点 UI 测试通过（${passed} 项断言），截图见 tests/out/`);
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error("\n❌ " + err.message);
    process.exit(1);
  } finally {
    setTimeout(() => chrome.kill(), 400);
  }
})();
