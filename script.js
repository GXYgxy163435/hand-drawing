import { FilesetResolver, HandLandmarker } from "https://fastly.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

/* ===== 元素引用 ===== */
const $ = (id) => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), drawCanvas = $("drawCanvas");
const startBtn = $("startBtn"), statusDot = $("statusDot"), statusText = $("statusText");
const toastEl = $("toast"), gestureHelp = $("gestureHelp");

/* ===== 状态 ===== */
let landmarker = null, cameraStream = null, running = false, rafId = 0;
let lastVideoTime = -1, results = null;
let mode = "idle";              // idle | drawing | clearing | exporting
let penColor = "#1C1C1E", strokeW = 4, smoothK = 0.7;
let tool = "brush", dragging = false, startPt = null, snapCanvas = null;
let opacity = 1, fillShapes = false, undoStack = [];

/* ===== 撤销栈（每次完成一笔/固定形状/添加文字/清空前存档，上限 20 步） ===== */
function pushUndo(){
  const c = document.createElement("canvas");
  c.width = drawW; c.height = drawH;
  c.getContext("2d").drawImage(drawCanvas, 0, 0);
  undoStack.push(c);
  if (undoStack.length > 20) undoStack.shift();
}
function undo(){
  if (!undoStack.length){ showToast("没有可撤销的操作"); return; }
  dctx.drawImage(undoStack.pop(), 0, 0);
  prevTip = null;
  showToast("已撤销 Undo");
}
let prevTip = null;             // 上一帧指尖坐标（平滑用）
let lastMode = "";              // 模式变化检测
let palmStart = 0;              // 摊开计时起点

/* ===== 画布初始化 ===== */
const dctx = drawCanvas.getContext("2d");
let drawW = 900, drawH = 600;
function initDrawCanvas(w, h){
  drawW = w; drawH = h;
  drawCanvas.width = w; drawCanvas.height = h;
  drawCanvas.style.aspectRatio = w + "/" + h;
  dctx.lineCap = "round"; dctx.lineJoin = "round";
  dctx.fillStyle = "#FFFFFF"; dctx.fillRect(0, 0, w, h);
  drawDemo();
  prevTip = null;
  undoStack = []; // 画布尺寸变化后旧快照失效，清空撤销栈
}
initDrawCanvas(900, 600);

/* ===== 示例绘制效果（打开画布即可见） ===== */
function demoPath(pts, color, width){
  dctx.strokeStyle = color; dctx.lineWidth = width;
  dctx.beginPath();
  dctx.moveTo(pts[0].x * drawW, pts[0].y * drawH);
  for (let i = 1; i < pts.length; i++){
    const a = pts[i-1], b = pts[i];
    dctx.quadraticCurveTo(((a.x+b.x)/2) * drawW, ((a.y+b.y)/2) * drawH, b.x * drawW, b.y * drawH);
  }
  dctx.stroke();
}
function drawDemo(){
  demoPath([{x:.10,y:.64},{x:.22,y:.46},{x:.36,y:.58},{x:.48,y:.38},{x:.60,y:.50},{x:.72,y:.32},{x:.84,y:.42}], "#A077E9", 3);
  demoPath([{x:.24,y:.80},{x:.38,y:.68},{x:.50,y:.76},{x:.62,y:.62},{x:.76,y:.70}], "#1C1C1E", 2.5);
}

/* ===== 手势判定（MediaPipe 21 关键点） ===== */
function fingersState(lm){
  // 手指伸直：指尖到手腕的距离 明显大于 中间指节(PIP)到手腕的距离。
  // 用距离比而非 Y 坐标，对手部倾斜 / 翻转更鲁棒，避免食指被误判为弯曲。
  const w = lm[0];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ext4 = [
    dist(lm[8],  w) > dist(lm[6],  w) * 1.08,   // 食指 index
    dist(lm[12], w) > dist(lm[10], w) * 1.08,   // 中指 middle
    dist(lm[16], w) > dist(lm[14], w) * 1.08,   // 无名指 ring
    dist(lm[20], w) > dist(lm[18], w) * 1.08    // 小指 pinky
  ];
  // 拇指张开：拇指尖明显离开掌心基准（相对掌宽）
  const thumbOut = dist(lm[4], lm[2]) > dist(lm[0], lm[2]) * 0.5;
  return { ext4, thumbOut, four: ext4.filter(Boolean).length };
}

function decideGesture(lm){
  const fs = fingersState(lm);
  // 1) 摊开导出：五指全伸、拇指张开、指尖分散（严格判定，避免误触发）
  if (fs.four === 4 && fs.thumbOut) {
    const spread = [
      Math.hypot(lm[8].x-lm[12].x, lm[8].y-lm[12].y),
      Math.hypot(lm[12].x-lm[16].x, lm[12].y-lm[16].y),
      Math.hypot(lm[16].x-lm[20].x, lm[16].y-lm[20].y)
    ].filter(d => d < 0.06).length;
    if (spread === 0) return "export";
  }
  // 2) 绘画：只要食指伸直即持续绘制（其余手指、拇指姿态不再约束，避免画线断触）
  if (fs.ext4[0]) return "draw";
  // 3) 其他姿态（含握拳）：无动作，清空由按钮控制
  return "idle";
}

/* ===== 指尖坐标 → 画布坐标 ===== */
function tipToCanvas(lm){
  const sx = drawW / video.videoWidth, sy = drawH / video.videoHeight;
  return { x: lm[8].x * video.videoWidth * sx, y: lm[8].y * video.videoHeight * sy };
}

/* ===== 模式执行（带稳定帧防抖：避免瞬时误判触发清空） ===== */
let gestureCount = 0, stableGesture = "";
function applyMode(g, lm){
  if (g === stableGesture) gestureCount++;
  else {
    stableGesture = g; gestureCount = 1;
    lastMode = ""; mode = "idle"; prevTip = null;
  }
  // 各手势需连续稳定帧数：绘画 3 帧防闪断，摊开 6 帧防误导出
  const need = g === "draw" ? 3 : g === "export" ? 6 : 1;
  if (gestureCount < need) return;
  if (g !== lastMode){
    // 进入新模式的单次动作
    if (g === "export") {
      palmStart = performance.now();
      mode = "exporting"; setStatus("danger", "保持摊开 1 秒导出… Hold palm");
      showToast("摊开手掌并保持 1 秒导出");
    } else if (g === "draw") {
      if (tool === "text") {
        // 文字工具：一次手势在指尖位置放置一段文字
        const tp = tipToCanvas(lm);
        const txt = window.prompt("输入要添加到画布的文字 / Text to add:", "");
        if (txt && txt.trim()) {
          dctx.save();
          dctx.globalAlpha = opacity;
          dctx.fillStyle = penColor;
          dctx.font = "600 26px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
          dctx.textAlign = "left"; dctx.textBaseline = "top";
          dctx.fillText(txt.trim(), tp.x, tp.y);
          dctx.restore();
          pushUndo();
          showToast("已添加文字 Text added");
        }
        mode = "idle"; setStatus("idle", "等待手势 Waiting"); prevTip = null;
        lastMode = "textdone"; // 本次手势剩余帧不再重复放置
        return;
      }
      prevTip = tipToCanvas(lm);
      mode = "drawing"; setStatus("drawing", "绘画中 Drawing");
      dragging = false; startPt = null; snapCanvas = null;
    } else {
      // 手势结束：固定形状 / 画线完成 → 存一次撤销快照
      if (lastMode === "draw") pushUndo();
      if (dragging) { dragging = false; snapCanvas = null; startPt = null; }
      mode = "idle"; setStatus("idle", "等待手势 Waiting"); prevTip = null;
    }
    lastMode = g;
  } else if (g === "export" && mode === "exporting"){
    if (performance.now() - palmStart >= 1000) {
      exportPNG();
      lastMode = ""; mode = "idle"; setStatus("idle", "已导出 Exported");
    }
  } else if (g === "draw"){
    const t = tipToCanvas(lm);
    // 文字工具：静默等待手势结束，不重复弹窗
    if (tool === "text") return;
    // 形状工具：拖拽绘制（直线 / 矩形 / 圆形）
    if (tool === "line" || tool === "rect" || tool === "ellipse") {
      if (!dragging) {
        dragging = true; startPt = t;
        snapCanvas = document.createElement("canvas");
        snapCanvas.width = drawW; snapCanvas.height = drawH;
        snapCanvas.getContext("2d").drawImage(drawCanvas, 0, 0);
        return;
      }
      dctx.save();
      dctx.drawImage(snapCanvas, 0, 0);
      dctx.globalAlpha = opacity;
      dctx.strokeStyle = penColor; dctx.lineWidth = strokeW;
      if (tool === "line") {
        dctx.beginPath(); dctx.moveTo(startPt.x, startPt.y); dctx.lineTo(t.x, t.y); dctx.stroke();
      } else if (tool === "rect") {
        const rx = Math.min(startPt.x, t.x), ry = Math.min(startPt.y, t.y), rw = Math.abs(t.x - startPt.x), rh = Math.abs(t.y - startPt.y);
        if (fillShapes){ dctx.fillStyle = penColor; dctx.fillRect(rx, ry, rw, rh); }
        dctx.strokeRect(rx, ry, rw, rh);
      } else {
        dctx.beginPath();
        dctx.ellipse((startPt.x + t.x) / 2, (startPt.y + t.y) / 2, Math.abs(t.x - startPt.x) / 2, Math.abs(t.y - startPt.y) / 2, 0, 0, Math.PI * 2);
        if (fillShapes){ dctx.fillStyle = penColor; dctx.fill(); }
        dctx.stroke();
      }
      dctx.restore();
      return;
    }
    // 画笔 / 橡皮：连续绘制；指尖跳变过大（关键点闪断重连）时断线重起
    if (prevTip){
      const jump = Math.hypot(t.x - prevTip.x, t.y - prevTip.y);
      if (jump > Math.max(drawW, drawH) * 0.25) prevTip = null;
      else {
        const nx = prevTip.x + (t.x - prevTip.x) * smoothK;
        const ny = prevTip.y + (t.y - prevTip.y) * smoothK;
        dctx.save();
        dctx.globalAlpha = opacity;
        dctx.strokeStyle = tool === "eraser" ? "#FFFFFF" : penColor;
        dctx.lineWidth = tool === "eraser" ? strokeW * 2 : strokeW;
        dctx.beginPath(); dctx.moveTo(prevTip.x, prevTip.y); dctx.lineTo(nx, ny); dctx.stroke();
        dctx.restore();
        prevTip = { x: nx, y: ny };
      }
    }
    if (!prevTip) prevTip = t;
  }
}

/* ===== 状态 UI ===== */
function setStatus(state, text){
  statusDot.className = "dot" + (state === "drawing" ? " drawing" : state === "danger" ? " warning" : "");
  statusText.textContent = text;
}
let toastTimer = 0;
function showToast(msg){
  toastEl.textContent = msg; toastEl.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2000);
}

/* ===== 绘制关键点叠加层 ===== */
function drawOverlay(lm){
  const r = overlay.getBoundingClientRect();
  if (overlay.width !== Math.round(r.width * devicePixelRatio)){
    overlay.width = Math.round(r.width * devicePixelRatio);
    overlay.height = Math.round(r.height * devicePixelRatio);
  }
  const octx = overlay.getContext("2d");
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!lm) return;
  octx.save(); octx.scale(overlay.width / video.videoWidth, overlay.height / video.videoHeight);
  const CONNECT = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
  octx.strokeStyle = "rgba(255,255,255,.28)"; octx.lineWidth = 1.2;
  octx.beginPath();
  for (const [a,b] of CONNECT){ octx.moveTo(lm[a].x*video.videoWidth, lm[a].y*video.videoHeight); octx.lineTo(lm[b].x*video.videoWidth, lm[b].y*video.videoHeight); }
  octx.stroke();
  octx.fillStyle = "rgba(255,255,255,.65)";
  for (const p of lm){ octx.beginPath(); octx.arc(p.x*video.videoWidth, p.y*video.videoHeight, 2.4, 0, Math.PI*2); octx.fill(); }
  octx.restore();
}

/* ===== 主循环 ===== */
async function loop(){
  if (!running) return;
  if (video.readyState >= 2 && lastVideoTime !== video.currentTime){
    lastVideoTime = video.currentTime;
    try { results = landmarker.detectForVideo(video, performance.now()); } catch(e){}
  }
  const lm = results && results.landmarks && results.landmarks[0];
  drawOverlay(lm);
  if (lm) applyMode(decideGesture(lm), lm);
  rafId = requestAnimationFrame(loop);
}

/* ===== 启动 / 停止 ===== */
async function start(){
  try {
    if (!window.isSecureContext) throw new Error("insecure");
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 540, facingMode: "user" } });
  } catch(err){
    showToast("无法访问摄像头：请使用 localhost 打开（如 VS Code Live Server）并允许摄像头权限");
    setStatus("danger", "摄像头不可用 Camera unavailable");
    return;
  }
  video.srcObject = cameraStream;
  await video.play().catch(()=>{});
  try {
    const vision = await FilesetResolver.forVisionTasks("https://fastly.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
    try {
      landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate: "GPU" },
        runningMode: "VIDEO", numHands: 1
      });
    } catch(e){
      landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate: "CPU" },
        runningMode: "VIDEO", numHands: 1
      });
    }
  } catch(e){
    showToast("MediaPipe 模型加载失败：请确认网络可访问 Google 模型存储，或开启代理");
    setStatus("danger", "模型加载失败 Model failed");
    return;
  }
  running = true; lastVideoTime = -1;
  startBtn.textContent = "停止绘画 Stop"; startBtn.classList.remove("off");
  setStatus("idle", "就绪 · 抬手开始 Ready");
  loop();
}
function stop(){
  running = false; cancelAnimationFrame(rafId);
  if (cameraStream){ cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  video.srcObject = null;
  overlay.getContext("2d").clearRect(0, 0, overlay.width, overlay.height);
  startBtn.textContent = "开始绘画 Start Drawing"; startBtn.classList.add("off");
  setStatus("idle", "已停止 Stopped");
}
/* ===== 清空画布（按钮触发，避免误判） ===== */
function clearCanvas(){
  pushUndo();
  dctx.fillStyle = "#FFFFFF"; dctx.fillRect(0, 0, drawW, drawH);
  prevTip = null;
  mode = "idle";
  setStatus("idle", "画布已清空 Cleared");
  showToast("画布已清空");
}
startBtn.addEventListener("click", () => { running ? stop() : start(); });
$("clearBtn").addEventListener("click", clearCanvas);
$("undoBtn").addEventListener("click", undo);

/* ===== 导出 PNG ===== */
function exportPNG(){
  const a = document.createElement("a");
  a.download = "hand-drawing-" + new Date().toISOString().slice(0,19).replace(/[:T]/g,"-") + ".png";
  a.href = drawCanvas.toDataURL("image/png");
  a.click();
  showToast("已导出画布图片 Exported");
}

/* ===== 工具切换 ===== */
document.querySelector(".tools").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll(".tools button").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); tool = b.dataset.tool;
  dragging = false; snapCanvas = null; prevTip = null;
  const names = { brush: "画笔 Brush", eraser: "橡皮擦 Eraser", line: "直线 Line", rect: "矩形 Rectangle", ellipse: "圆形 Ellipse", text: "文字 Text" };
  showToast("工具：" + (names[tool] || tool));
});

/* ===== 设置面板 ===== */
$("swatches").addEventListener("click", e => {
  const sw = e.target.closest(".swatch"); if (!sw) return;
  document.querySelectorAll(".swatch").forEach(s => s.classList.remove("on"));
  sw.classList.add("on"); penColor = sw.dataset.color; $("penName").textContent = sw.dataset.name;
});
$("strokeRange").addEventListener("input", e => { strokeW = +e.target.value; $("strokeVal").textContent = strokeW + " px"; });
$("sensRange").addEventListener("input", e => {
  const v = +e.target.value; smoothK = 0.45 + v * 0.11;
  $("sensVal").textContent = ["低","较低","中","较高","高"][v-1];
});
$("sizeSeg").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || b.classList.contains("on")) return;
  document.querySelectorAll("#sizeSeg button").forEach(x => x.classList.remove("on"));
  b.classList.add("on");
  const [w,h] = b.dataset.size.split(",").map(Number);
  initDrawCanvas(w, h); prevTip = null;
  showToast("画布尺寸已切换为 " + (w + "×" + h));
});
$("opacityRange").addEventListener("input", e => { opacity = +e.target.value / 100; $("opacityVal").textContent = e.target.value + "%"; });
$("fillSeg").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#fillSeg button").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); fillShapes = b.dataset.fill === "1";
});

/* ===== 顶部导航 ===== */
document.querySelectorAll("nav .tabs button").forEach(btn => {
  btn.addEventListener("click", () => {
    const t = btn.dataset.tab;
    if (t === "draw") document.querySelector(".center").scrollIntoView({ behavior: "smooth" });
    else if (t === "gestures") gestureHelp.scrollIntoView({ behavior: "smooth" });
    else document.querySelector("footer").scrollIntoView({ behavior: "smooth" });
  });
});

/* ===== 打开页面自动启动摄像头交互 ===== */
window.addEventListener("load", () => { setTimeout(start, 400); });
