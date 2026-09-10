const cv = document.getElementById("scene");
const ctx = cv.getContext("2d");
ctx.imageSmoothingEnabled = false;

const P = 3;

function px(x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect((x * P) | 0, (y * P) | 0, (w * P) | 0, (h * P) | 0);
}

const walkImg = new Image();
walkImg.src = "assets/walk.png";
const talkImg = new Image();
talkImg.src = "assets/talk.png";
const stanceImg = new Image();
stanceImg.src = "assets/stance.png";
const bgImg = new Image();
bgImg.src = "assets/bg.png";
const panelImg = new Image();   panelImg.src = "assets/panel.png";
const heartFull = new Image();  heartFull.src = "assets/heart_full.png";
const heartHalf = new Image();  heartHalf.src = "assets/heart_half.png";
const heartEmpty = new Image(); heartEmpty.src = "assets/heart_empty.png";
const walkL = new Image(); walkL.src = "assets/player_walk_l.png";
const walkR = new Image(); walkR.src = "assets/player_walk_r.png";
const backImg = new Image(); backImg.src = "assets/player_back.png";

const player = {
  x: 130,
  feetY: 198,
  dir: 1,
  dist: 0,
  speed: 62,
  sitting: false,
  seatIndex: -1,
  bounds: { x: 24, x2: 356, y: 152, y2: 206 },
};
const P_CENTER = 33;
const P_FEET = 55;
const keys = {};
const MOVE_KEYS = ["arrowleft", "arrowright", "arrowup", "arrowdown", "a", "d", "w", "s"];
const STOOLS = [
  { x: 100, feetY: 162 },
  { x: 178, feetY: 162 },
  { x: 257, feetY: 162 },
];
const CV_W = 384, CV_H = 216;
const FRAME_W = 66;
const FRAME_H = 66;
const FRAME_COUNT = 8;
const TALK_FPS = 6;
const STANCE_FPS = 3;
const IDLE_DURATION = 2;

const char = {
  x: 190,
  dir: 1,
  speed: 30,
  dist: 0,
  state: "walk",
  nextIdleAt: 0,
  idleUntil: 0,
  bounds: { min: 60, max: 210 },
};
char.nextIdleAt = performance.now() / 1000 + 3;

const GROUND_Y = 128;
const FEET_LOCAL_Y = 55;
const CENTER_LOCAL_X = 32;
const STRIDE = 7;

const OCCL = { x: 46, y: 113, w: 261, h: 41 };

let lastFrameTime = performance.now() / 1000;

const npc = {
  thinking: false,
  talkingUntil: 0,
};

const fx = {
  steamUntil: 0,
  cupServed: false,
};

let gameState = {
  hearts: 0,
  levelName: "生客",
  moodName: "平静",
  moodEmoji: "😌",
  affinity: 0,
  levelUp: false,
};

function drawScene() {
  const now = performance.now() / 1000;

  if (bgImg.complete) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bgImg, 0, 0, CV_W, CV_H);
    ctx.restore();
  }

  const talking = npc.thinking || now < npc.talkingUntil;
  const dt = now - lastFrameTime;
  lastFrameTime = now;

  const imgTop = GROUND_Y - FEET_LOCAL_Y;

  if (talking) {
    const frame = Math.floor(now * TALK_FPS) % FRAME_COUNT;
    if (talkImg.complete) {
      ctx.drawImage(talkImg, frame * FRAME_W, 0, FRAME_W, FRAME_H, char.x, imgTop, FRAME_W, FRAME_H);
    }
    drawCharShadow(char.x + CENTER_LOCAL_X);
    drawTalkBubble(char.x + 14, imgTop - 16, now);
  } else {
    if (char.state === "walk") {
      char.x += char.dir * char.speed * dt;
      if (char.x < char.bounds.min) { char.x = char.bounds.min; char.dir = 1; }
      if (char.x > char.bounds.max) { char.x = char.bounds.max; char.dir = -1; }
      char.dist += char.speed * dt;
      if (now >= char.nextIdleAt) { char.state = "idle"; char.idleUntil = now + IDLE_DURATION; }
    } else {
      if (now >= char.idleUntil) { char.state = "walk"; char.nextIdleAt = now + 2.2 + Math.random() * 2.5; }
    }

    if (char.state === "walk") {
      const frame = Math.floor(char.dist / STRIDE) % FRAME_COUNT;
      const visCenterX = char.x + (char.dir === 1 ? CENTER_LOCAL_X : FRAME_W - CENTER_LOCAL_X);
      drawCharShadow(visCenterX);
      if (walkImg.complete) {
        ctx.save();
        if (char.dir === -1) {
          ctx.translate(char.x + FRAME_W, imgTop);
          ctx.scale(-1, 1);
          ctx.drawImage(walkImg, frame * FRAME_W, 0, FRAME_W, FRAME_H, 0, 0, FRAME_W, FRAME_H);
        } else {
          ctx.drawImage(walkImg, frame * FRAME_W, 0, FRAME_W, FRAME_H, char.x, imgTop, FRAME_W, FRAME_H);
        }
        ctx.restore();
      }
    } else {
      const frame = Math.floor(now * STANCE_FPS) % FRAME_COUNT;
      drawCharShadow(char.x + CENTER_LOCAL_X);
      if (stanceImg.complete) {
        ctx.drawImage(stanceImg, frame * FRAME_W, 0, FRAME_W, FRAME_H, char.x, imgTop, FRAME_W, FRAME_H);
      }
    }
  }

  drawCounterOccluder();

  let prompText = "";
  let pImg, pFrame;

  if (!player.sitting) {
    let dx = ((keys.d || keys.arrowright) ? 1 : 0) - ((keys.a || keys.arrowleft) ? 1 : 0);
    let dy = ((keys.s || keys.arrowdown) ? 1 : 0) - ((keys.w || keys.arrowup) ? 1 : 0);
    if (dx && dy) { dx *= 0.707; dy *= 0.707; }
    const moving = (dx !== 0 || dy !== 0);
    if (dx) player.dir = dx > 0 ? 1 : -1;
    if (moving) {
      player.x += dx * player.speed * dt;
      player.feetY += dy * player.speed * dt;
      player.dist += Math.hypot(dx, dy) * player.speed * dt;
      player.x = Math.max(player.bounds.x, Math.min(player.bounds.x2, player.x));
      player.feetY = Math.max(player.bounds.y, Math.min(player.bounds.y2, player.feetY));
    }
    pImg = player.dir === 1 ? walkR : walkL;
    pFrame = moving ? Math.floor(player.dist / 7) % 8 : 0;
    if (nearestStool()) prompText = "按 E 坐下";
  } else {
    pImg = backImg;
    pFrame = (Math.floor(now * 1.5) % 2) ? 0 : 2;
    prompText = "按 E 起身";
  }

  const pTop = player.feetY - P_FEET;

  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(player.x, player.feetY, 15, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  if (pImg && pImg.complete) {
    ctx.drawImage(pImg, pFrame * 66, 0, 66, 66, player.x - P_CENTER, pTop, 66, 66);
  }

  if (player.sitting) drawStoolOccluder(player.x);

  if (prompText) {
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    const tw = ctx.measureText(prompText).width + 12;
    const ty = pTop - 8;
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(player.x - tw / 2, ty - 3, tw, 16);
    ctx.fillStyle = "#f6d9a8";
    ctx.fillText(prompText, player.x, ty);
    ctx.textAlign = "left";
  }

  drawGamePanel();
}

function drawCharShadow(cx) {
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(cx, GROUND_Y, 18, 4, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawCounterOccluder() {
  if (!bgImg.complete) return;
  const k = bgImg.width / CV_W;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(
    bgImg,
    OCCL.x * k, OCCL.y * k, OCCL.w * k, OCCL.h * k,
    OCCL.x, OCCL.y, OCCL.w, OCCL.h
  );
  ctx.restore();
}

function drawStoolOccluder(stoolX) {
  if (!bgImg.complete) return;
  const k = bgImg.width / CV_W;
  const x = stoolX - 20, y = player.feetY - 22, w = 40, h = 26;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bgImg, x * k, y * k, w * k, h * k, x, y, w, h);
  ctx.restore();
}

function drawTalkBubble(bx, by, now) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(bx, by, 40, 18);
  ctx.beginPath();
  ctx.moveTo(bx + 8, by + 18);
  ctx.lineTo(bx + 14, by + 25);
  ctx.lineTo(bx + 19, by + 18);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#c9b69a";
  const phase = (now * 2) | 0;
  for (let i = 0; i < 3; i++) {
    const on = (phase + i) % 2 === 0;
    if (on) ctx.fillRect(bx + 12 + i * 8, by + 7, 5, 5);
  }
}

function drawGamePanel() {
  const PX = 10, PY = 8, PW = 116, PH = 44;

  if (panelImg.complete) ctx.drawImage(panelImg, PX, PY, PW, PH);

  ctx.textBaseline = "top";
  ctx.font = "bold 13px sans-serif";
  ctx.fillStyle = "#f0e6ce";
  ctx.fillText(gameState.levelName, PX + 12, PY + 9);
  ctx.font = "bold 12px sans-serif";
  ctx.fillText(String(gameState.affinity), PX + 88, PY + 10);

  const heartVal = (gameState.affinity || 0) / 20;
  for (let i = 0; i < 5; i++) {
    const x = PX + 12 + i * 18;
    const y = PY + 26;
    const img = heartVal >= i + 1 ? heartFull : heartVal >= i + 0.5 ? heartHalf : heartEmpty;
    if (img.complete) ctx.drawImage(img, x, y, 11, 10);
  }
}

function tick() {
  drawScene();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const messagesEl = document.getElementById("messages");
const statusEl = document.getElementById("status");

const sessionId = "wanwansheng";

function setChatEnabled(enabled) {
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;
  orderBtn.disabled = !enabled;
  customBtn.disabled = !enabled;
  menuBtn.disabled = !enabled;
  input.placeholder = enabled
    ? "和老板娘说点什么…（例：给我来一杯尼格罗尼）"
    : "先走到吧台椅旁按 E 坐下，才能和老板娘聊天…";
}

function appendMessage(role, text, asDots) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  if (asDots) {
    div.innerHTML = '<span class="dots"><span>.</span><span>.</span><span>.</span></span>';
  } else {
    div.textContent = text;
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function appendBadge(text) {
  const div = document.createElement("div");
  div.className = "badge";
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

const SPEAKERS = { boss: "老板娘", regular: "老周" };
let castList = [];
let lastWorld = null;
let lastBudget = null;
const worldEl = document.getElementById("world");

function who(actor) {
  if (!actor) return "店长";
  const found = castList.find((c) => c.id === actor);
  return SPEAKERS[actor] || (found && found.name) || actor;
}

// 同一拍里可能有多个角色说话，每人一个独立气泡
function appendSpeaker(actor) {
  const root = document.createElement("div");
  root.className = "msg npc from-" + actor;
  const nameEl = document.createElement("div");
  nameEl.className = "speaker";
  nameEl.textContent = who(actor);
  const body = document.createElement("div");
  body.innerHTML = '<span class="dots"><span>.</span><span>.</span><span>.</span></span>';
  root.appendChild(nameEl);
  root.appendChild(body);
  messagesEl.appendChild(root);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  let cleared = false;
  return {
    root,
    body,
    clear() {
      if (cleared) return;
      cleared = true;
      body.innerHTML = "";
    },
    set(t) {
      cleared = true;
      body.textContent = t;
    },
  };
}

function renderWorld() {
  const w = lastWorld || {};
  const parts = [];
  if (w.clock) parts.push(`🕐 <b>${w.clock.phase}</b> · 第 ${w.clock.turn} 拍`);
  if (w.cash != null) parts.push(`💰 <b>${w.cash}</b> 元`);
  if (w.stock) parts.push(`🍾 ${Object.entries(w.stock).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  if (w.present) parts.push(`👥 ${w.present.map(who).join("、")}`);
  if (lastBudget) parts.push(`⚙ 本轮 <b>${lastBudget.calls}</b>/${lastBudget.limit} 次调用`);
  worldEl.innerHTML = parts.map((p) => `<span>${p}</span>`).join("");
}

async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload) continue;
      let ev; try { ev = JSON.parse(payload); } catch { continue; }
      onEvent(ev);
    }
  }
}

function handleAction(a) {
  const n = who(a.actor);
  if (a.name === "makeDrink") {
    appendBadge(`🍸 ${n}调了「${a.args.drink}」`);
  } else if (a.name === "inventDrink") {
    appendBadge(`🎨 ${n}原创了一杯「${a.args.name}」`);
  } else if (a.name === "takePayment") {
    appendBadge(`💰 ${n}收了 ${a.args.amount} 元`);
  } else {
    appendBadge(`🛠 ${n}查了查库存`);
  }
}

const targetSel = document.getElementById("target");

async function send(overrideText) {
  const text = (overrideText !== undefined ? overrideText : input.value).trim();
  if (!text) return;
  if (overrideText === undefined) input.value = "";

  if (isGenericOrder(text)) {
    openDrinkMenu();
    return;
  }

  appendMessage("user", text);

  // 一拍里可能有好几个人开口，按角色分开气泡和累计文本
  const slots = new Map();
  const texts = new Map();
  const slot = (actor) => {
    if (!slots.has(actor)) {
      slots.set(actor, appendSpeaker(actor));
      texts.set(actor, "");
    }
    return slots.get(actor);
  };
  let lastActor = "boss";
  npc.thinking = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, sessionId, target: targetSel.value || null }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "请求失败了");
    }

    await readSSE(res, (ev) => {
      if (ev.type === "delta") {
        const actor = ev.actor || "boss";
        lastActor = actor;
        const s = slot(actor);
        s.clear();
        const cur = (texts.get(actor) || "") + ev.text;
        texts.set(actor, cur);
        s.body.textContent = cur;
        messagesEl.scrollTop = messagesEl.scrollHeight;
        npc.talkingUntil = performance.now() / 1000 + 0.6;
      } else if (ev.type === "action") {
        handleAction(ev);
      } else if (ev.type === "beat") {
        appendBadge(`🎬 导演安排：${who(ev.assignee)}该${ev.goal}`);
      } else if (ev.type === "critic") {
        appendBadge(`🧐 场记记了一笔：${ev.issue}`);
      } else if (ev.type === "budget_exhausted") {
        appendBadge(`⏹ 这一轮已经花掉 ${ev.used} 次模型调用，先停一下`);
      } else if (ev.type === "guard_replaced") {
        const actor = ev.actor || "boss";
        slot(actor).set(ev.reply);
        texts.set(actor, ev.reply);
        appendBadge("🛡 有一句话说得不对味，已经换掉");
      } else if (ev.type === "done") {
        npc.thinking = false;
        if (ev.game) {
          gameState = { ...gameState, ...ev.game };
          if (ev.game.levelUp) {
            appendBadge(`❤ 好感度提升了！现在是「${ev.game.levelName}」啦`);
          }
        }
        if (ev.world) lastWorld = ev.world;
        if (ev.budget) lastBudget = ev.budget;
        renderWorld();
      } else if (ev.type === "error") {
        slot(lastActor).set("（这边出了点小状况…）" + (ev.error ? `\n${ev.error}` : ""));
      }
    });
  } catch (e) {
    slot(lastActor).set(e.message || "没反应…看看服务端日志？");
    npc.thinking = false;
  }
}

sendBtn.addEventListener("click", send);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); send(); }
});

document.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (MOVE_KEYS.includes(k)) e.preventDefault();
  if (k === "e" && !e.repeat) toggleSit();
});
document.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });

function nearestStool() {
  let best = null, bestD = 30;
  STOOLS.forEach((s, i) => {
    const d = Math.hypot(player.x - s.x, player.feetY - s.feetY);
    if (d < bestD) { bestD = d; best = { x: s.x, feetY: s.feetY, index: i }; }
  });
  return best;
}

function toggleSit() {
  if (player.sitting) {
    player.sitting = false;
    player.seatIndex = -1;
    player.feetY += 10;
    setChatEnabled(false);
    return;
  }
  const seat = nearestStool();
  if (!seat) return;
  player.sitting = true;
  player.seatIndex = seat.index;
  player.x = seat.x;
  player.feetY = seat.feetY;
  setChatEnabled(true);
  appendBadge("🪑 你坐到了吧台前，可以和老板娘聊天了");
}

const DRINKS = [
  ["香槟", "白葡萄酒", "龙舌兰", "金汤力"],
  ["尼格罗尼", "蓝色夏威夷", "椰林飘香", "血腥玛丽"],
  ["自由古巴", "古典鸡尾酒", "大都会", "白兰地"],
];

function specificDrinkInText(text) {
  return DRINKS.flat().some((d) => text.includes(d));
}

function isGenericOrder(text) {
  const orderKW = /点单|点酒|来杯|来一杯|来点|喝一杯|想喝|喝点什么|喝点|来杯酒|有什么酒|上酒|给我来|要喝酒|来点酒/;
  return orderKW.test(text) && !specificDrinkInText(text);
}
const orderBtn = document.getElementById("orderBtn");
const drinkMenu = document.getElementById("drinkMenu");
const drinkMenuImg = document.getElementById("drinkMenuImg");
const drinkMenuClose = document.getElementById("drinkMenuClose");

function openDrinkMenu() { drinkMenu.classList.remove("hidden"); }
function closeDrinkMenu() { drinkMenu.classList.add("hidden"); }

orderBtn.addEventListener("click", openDrinkMenu);
drinkMenuClose.addEventListener("click", closeDrinkMenu);
drinkMenu.addEventListener("click", (e) => { if (e.target === drinkMenu) closeDrinkMenu(); });

drinkMenuImg.addEventListener("click", (e) => {
  const rect = drinkMenuImg.getBoundingClientRect();
  const col = Math.min(3, Math.floor((e.clientX - rect.left) / (rect.width / 4)));
  const row = Math.min(2, Math.floor((e.clientY - rect.top) / (rect.height / 3)));
  const drink = DRINKS[row] && DRINKS[row][col];
  if (!drink) return;
  closeDrinkMenu();
  send(`我要点一杯${drink}`);
});

const CUSTOM_OPTIONS = {
  spirit: ["伏特加", "金酒", "朗姆", "威士忌", "龙舌兰", "白兰地"],
  mixer: ["柠檬", "青柠", "薄荷", "莓果", "可乐", "苏打", "姜汁", "椰子", "咖啡"],
  sweet: ["标准", "少糖", "无糖"],
  ice: ["加冰", "去冰"],
};
const cdSel = { spirit: null, mixer: null, sweet: "标准", ice: "加冰" };
const customBtn = document.getElementById("customBtn");
const customDrink = document.getElementById("customDrink");
const customDrinkClose = document.getElementById("customDrinkClose");
const cdName = document.getElementById("cd-name");
const cdConfirm = document.getElementById("cd-confirm");

function buildChips(catId, values) {
  const box = document.getElementById(catId);
  values.forEach((v) => {
    const b = document.createElement("button");
    b.textContent = v;
    b.dataset.value = v;
    b.addEventListener("click", () => {
      cdSel[box.dataset.cat] = v;
      box.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    });
    box.appendChild(b);
  });
}
buildChips("cd-spirit", CUSTOM_OPTIONS.spirit);
buildChips("cd-mixer", CUSTOM_OPTIONS.mixer);
buildChips("cd-sweet", CUSTOM_OPTIONS.sweet);
buildChips("cd-ice", CUSTOM_OPTIONS.ice);
document.getElementById("cd-spirit").dataset.cat = "spirit";
document.getElementById("cd-mixer").dataset.cat = "mixer";
document.getElementById("cd-sweet").dataset.cat = "sweet";
document.getElementById("cd-ice").dataset.cat = "ice";

customBtn.addEventListener("click", () => customDrink.classList.remove("hidden"));
customDrinkClose.addEventListener("click", () => customDrink.classList.add("hidden"));
customDrink.addEventListener("click", (e) => { if (e.target === customDrink) customDrink.classList.add("hidden"); });

cdConfirm.addEventListener("click", () => {
  let msg = "帮我定制一杯酒";
  if (cdSel.spirit) msg += `，基酒${cdSel.spirit}`;
  if (cdSel.mixer) msg += `，配料${cdSel.mixer}`;
  msg += `，${cdSel.sweet}，${cdSel.ice}`;
  const nm = cdName.value.trim();
  if (nm) msg += `，名字叫「${nm}」`;
  msg += "。你自由发挥，给它起个名、编个配方，现场做出来。";
  customDrink.classList.add("hidden");
  cdName.value = "";
  send(msg);
});

const menuBtn = document.getElementById("menuBtn");
const privateMenu = document.getElementById("privateMenu");
const privateMenuClose = document.getElementById("privateMenuClose");
const privateMenuList = document.getElementById("privateMenuList");

async function openPrivateMenu() {
  privateMenu.classList.remove("hidden");
  privateMenuList.innerHTML = "<div class='private-empty'>加载中…</div>";
  try {
    const res = await fetch("/api/menu");
    const data = await res.json();
    const list = data.custom || [];
    if (!list.length) {
      privateMenuList.innerHTML = "<div class='private-empty'>还没有原创酒，点「🎨 定制」创作一杯吧~</div>";
      return;
    }
    privateMenuList.innerHTML = "";
    list.forEach((d) => {
      const div = document.createElement("div");
      div.className = "private-item";
      div.innerHTML = `<div class="nm">🍸 ${escapeHtml(d.name)}</div>
        <div class="meta">基酒：${escapeHtml(d.spirit || "-")} · 配料：${escapeHtml(d.mixer || "-")}${d.note ? " · " + escapeHtml(d.note) : ""}</div>`;
      privateMenuList.appendChild(div);
    });
  } catch (e) {
    privateMenuList.innerHTML = "<div class='private-empty'>加载失败，请确认服务已启动</div>";
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
menuBtn.addEventListener("click", openPrivateMenu);
privateMenuClose.addEventListener("click", () => privateMenu.classList.add("hidden"));
privateMenu.addEventListener("click", (e) => { if (e.target === privateMenu) privateMenu.classList.add("hidden"); });

async function loadCast() {
  try {
    const res = await fetch("/api/cast");
    const data = await res.json();
    castList = data.cast || [];
    targetSel.innerHTML = '<option value="">自动识别</option>' +
      castList.map((c) => `<option value="${escapeHtml(c.id)}">跟${escapeHtml(c.name)}说</option>`).join("");
    if (data.world) {
      lastWorld = data.world;
      renderWorld();
    }
  } catch {
    targetSel.innerHTML = '<option value="">自动识别</option>';
  }
}

async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (data.hasKey) {
      const names = (data.cast || []).map((c) => c.name).join("、");
      statusEl.textContent = `在场：${names}（${data.model}）。A/D 或 ←/→ 移动，W/S 或 ↑/↓ 前后；走到吧台椅旁按 E 坐下才能聊天。也可以直接点名，比如“老周，你怎么看？”`;
      statusEl.className = "status ok";
    } else {
      statusEl.textContent = "大脑还没接好：请复制 .env.example 为 .env，填入 DEEPSEEK_API_KEY 后重启服务。";
      statusEl.className = "status warn";
    }
  } catch (e) {
    statusEl.textContent = "连不上后端服务：确认已运行 npm start。";
    statusEl.className = "status warn";
  }
}
setChatEnabled(false);
loadCast();
checkHealth();
