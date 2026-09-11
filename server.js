import express from "express";
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { runAgentStream, runAmbientStream, getRoster } from "./agent/agent.js";
import { loadProfile } from "./agent/memory.js";
import { listMemory } from "./agent/vectorstore.js";
import { listTraces, getTrace, metrics } from "./agent/telemetry.js";
import { snapshot as worldSnapshot, resetWorld, enter, leave, presentActors } from "./agent/world.js";
import { sceneInfo } from "./agent/scene.js";
import { initiativeEnabled } from "./agent/initiative.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const SESSIONS_PATH = join(__dirname, "sessions.json");
const EVAL_REPORT_PATH = join(__dirname, "eval", "report.json");

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

function hasDeepSeekKey() {
  const k = process.env.DEEPSEEK_API_KEY;
  return Boolean(k && !k.includes("xxxx"));
}

function hasVectorKey() {
  const k = process.env.SILICONFLOW_API_KEY;
  return Boolean(k && !k.includes("xxxx"));
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    hasKey: hasDeepSeekKey(),
    vectorMemory: hasVectorKey(),
    reflection: process.env.REFLECTION_ENABLED !== "0",
    safety: process.env.SAFETY_ENABLED !== "0",
    initiative: initiativeEnabled(),
    ambient: {
      chance: Number(process.env.GUEST_INITIATIVE_CHANCE ?? 0.35),
      minIdleMs: Number(process.env.GUEST_INITIATIVE_MIN_IDLE_MS ?? 20000),
      gapMs: Number(process.env.GUEST_INITIATIVE_GAP_MS ?? 45000),
    },
    cast: getRoster(),
  });
});

app.get("/api/cast", (_req, res) => {
  res.json({ cast: getRoster(), present: presentActors(), world: worldSnapshot() });
});

app.get("/api/scene", (_req, res) => {
  res.json(sceneInfo());
});

app.post("/api/world/reset", (_req, res) => {
  resetWorld();
  res.json({ ok: true, world: worldSnapshot() });
});

app.post("/api/world/present", (req, res) => {
  const { id, present } = req.body || {};
  if (!id) return res.status(400).json({ error: "id 不能为空" });
  const next = present === false ? leave(id) : enter(id);
  res.json({ ok: true, present: next });
});

app.get("/api/menu", (_req, res) => {
  const profile = loadProfile();
  res.json({ custom: profile.customDrinks || [] });
});

app.get("/api/memories", (req, res) => {
  res.json({ memories: listMemory(req.query.owner || null) });
});

app.get("/api/traces", (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20));
  res.json({ traces: listTraces(limit) });
});

app.get("/api/traces/:id", (req, res) => {
  const t = getTrace(req.params.id);
  if (!t) return res.status(404).json({ error: "trace 不存在" });
  res.json(t);
});

app.get("/api/metrics", (req, res) => {
  res.json(metrics({ fromDisk: req.query.disk === "1" }));
});

app.get("/api/eval", (_req, res) => {
  try {
    if (!existsSync(EVAL_REPORT_PATH)) {
      return res.status(404).json({ error: "还没有评测报告，先运行 npm run eval" });
    }
    res.json(JSON.parse(readFileSync(EVAL_REPORT_PATH, "utf8")));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

let sessions = loadSessions();
const lastActivity = new Map();

function markActivity(sessionId) {
  lastActivity.set(sessionId, Date.now());
}

function idleMsSince(sessionId, claimed) {
  const last = lastActivity.get(sessionId);
  const serverIdle = last ? Date.now() - last : Number.MAX_SAFE_INTEGER;
  const said = Number(claimed);
  if (!Number.isFinite(said) || said < 0) return serverIdle;
  return Math.min(said, serverIdle);
}

function openStream(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  return (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function loadSessions() {
  try {
    if (existsSync(SESSIONS_PATH)) {
      const raw = JSON.parse(readFileSync(SESSIONS_PATH, "utf8"));
      const out = new Map();
      for (const [k, v] of Object.entries(raw)) {
        out.set(k, Array.isArray(v) ? { boss: v } : v);
      }
      return out;
    }
  } catch {}
  return new Map();
}

function saveSessions() {
  try {
    writeFileSync(SESSIONS_PATH, JSON.stringify(Object.fromEntries(sessions)), "utf8");
  } catch (e) {
    console.warn("[server] 保存会话失败：", e.message);
  }
}

function ensureSession(id) {
  if (!sessions.has(id)) sessions.set(id, {});
  return sessions.get(id);
}

app.post("/api/chat", async (req, res) => {
  const { text, sessionId = "default", target = null } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "text 不能为空" });
  }

  const histories = ensureSession(sessionId);
  markActivity(sessionId);

  const send = openStream(res);

  try {
    for await (const ev of runAgentStream({ userText: text, sessionId, target, histories })) {
      if (res.writableEnded) break;
      send(ev);
    }
  } catch (e) {
    console.error("[server] /api/chat 出错：", e.message);
    send({ type: "delta", actor: "boss", text: "（店长这边好像出了点小状况…看看浏览器 console 或服务端日志？）" });
    send({ type: "error", error: e.message });
  } finally {
    markActivity(sessionId);
    saveSessions();
    res.end();
  }
});

app.post("/api/ambient", async (req, res) => {
  const { sessionId = "default", idleMs = 0, force = false } = req.body || {};
  const histories = ensureSession(sessionId);
  const effectiveIdle = idleMsSince(sessionId, idleMs);
  markActivity(sessionId);

  const send = openStream(res);

  try {
    for await (const ev of runAmbientStream({ sessionId, histories, idleMs: effectiveIdle, force: force === true })) {
      if (res.writableEnded) break;
      send(ev);
    }
  } catch (e) {
    console.error("[server] /api/ambient 出错：", e.message);
    send({ type: "error", error: e.message });
  } finally {
    markActivity(sessionId);
    saveSessions();
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const on = (v) => (v ? "开" : "关");
  const cast = getRoster().map((c) => c.name).join("、");
  console.log(`🍸 星布谷地 · 岁月酒吧已启动：http://localhost:${PORT}`);
  console.log(`   模型：${process.env.DEEPSEEK_MODEL || "deepseek-chat"}`);
  console.log(`   角色：${cast}`);
  console.log(
    `   向量记忆：${on(hasVectorKey())} ｜ 反思复核：${on(process.env.REFLECTION_ENABLED !== "0")}` +
      ` ｜ 安全守卫：${on(process.env.SAFETY_ENABLED !== "0")}` +
      ` ｜ 主动搭话：${on(initiativeEnabled())}`
  );
  console.log(`   观测台：http://localhost:${PORT}/obs.html`);
});
