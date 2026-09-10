/**
 * HTTP 服务层
 * ------------------------------------------------------------------
 * 职责：静态资源、SSE 对话通道、观测查询接口。
 * 新增（相比初版）：
 *   GET /api/traces          最近 N 条 trace 摘要（观测台列表）
 *   GET /api/traces/:id      单条 trace 全量（含每个 span）
 *   GET /api/metrics         聚合指标（延迟/token/成本/工具分布/拦截率）
 *   GET /api/eval            最近一次评测报告（eval/report.json）
 */
import express from "express";
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { runAgentStream } from "./agent/agent.js";
import { loadProfile } from "./agent/memory.js";
import { listMemory } from "./agent/vectorstore.js";
import { listTraces, getTrace, metrics } from "./agent/telemetry.js";

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

/* ---------------------------- 基础接口 ---------------------------- */

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    hasKey: hasDeepSeekKey(),
    vectorMemory: Boolean(process.env.SILICONFLOW_API_KEY && !process.env.SILICONFLOW_API_KEY.includes("xxxx")),
    reflection: process.env.REFLECTION_ENABLED !== "0",
    safety: process.env.SAFETY_ENABLED !== "0",
  });
});

app.get("/api/menu", (_req, res) => {
  const profile = loadProfile();
  res.json({ custom: profile.customDrinks || [] });
});

app.get("/api/memories", (_req, res) => {
  res.json({ memories: listMemory() });
});

/* ---------------------------- 观测接口 ---------------------------- */

app.get("/api/traces", (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20));
  res.json({ traces: listTraces(limit) });
});

app.get("/api/traces/:id", (req, res) => {
  const t = getTrace(req.params.id);
  if (!t) return res.status(404).json({ error: "trace 不存在或已滚出内存缓冲区（仅保留最近若干条）" });
  res.json(t);
});

app.get("/api/metrics", (req, res) => {
  const fromDisk = req.query.disk === "1";
  res.json(metrics({ fromDisk }));
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

/* ---------------------------- 会话存储 ---------------------------- */

let sessions = loadSessions();

function loadSessions() {
  try {
    if (existsSync(SESSIONS_PATH)) {
      return new Map(Object.entries(JSON.parse(readFileSync(SESSIONS_PATH, "utf8"))));
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
  if (!sessions.has(id)) sessions.set(id, []);
  return sessions.get(id);
}

/* ---------------------------- 对话通道 ---------------------------- */

app.post("/api/chat", async (req, res) => {
  const { text, sessionId = "default" } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "text 不能为空" });
  }

  const history = ensureSession(sessionId);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    for await (const ev of runAgentStream({ userText: text, messages: history, sessionId })) {
      if (res.writableEnded) break;
      send(ev);
    }
  } catch (e) {
    console.error("[server] /api/chat 出错：", e.message);
    send({ type: "delta", text: "（店长这边好像出了点小状况…看看浏览器 console 或服务端日志？）" });
    send({ type: "error", error: e.message });
  } finally {
    saveSessions();
    res.end();
  }
});

/* ---------------------------- 启动 ---------------------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const on = (v) => (v ? "开" : "关");
  console.log(`🍸 星布谷地 · 岁月酒吧已启动：http://localhost:${PORT}`);
  console.log(`   模型：${process.env.DEEPSEEK_MODEL || "deepseek-chat"}`);
  console.log(`   Key 已配置：${hasDeepSeekKey()}`);
  console.log(`   向量记忆：${on(Boolean(process.env.SILICONFLOW_API_KEY && !process.env.SILICONFLOW_API_KEY.includes("xxxx")))}` +
    ` ｜ 反思复核：${on(process.env.REFLECTION_ENABLED !== "0")}` +
    ` ｜ 安全守卫：${on(process.env.SAFETY_ENABLED !== "0")}`);
  console.log(`   观测台：http://localhost:${PORT}/obs.html`);
});
