import { appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACE_PATH = join(__dirname, "..", "traces.jsonl");
const RING_SIZE = Number(process.env.TRACE_RING_SIZE || 60);

const PRICE_INPUT_PER_M = Number(process.env.PRICE_INPUT_PER_M || 2);
const PRICE_OUTPUT_PER_M = Number(process.env.PRICE_OUTPUT_PER_M || 8);

const ring = [];
let counter = 0;

function newTraceId() {
  counter += 1;
  return `tr_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function estimateCostCNY(promptTokens = 0, completionTokens = 0) {
  return (
    (promptTokens / 1e6) * PRICE_INPUT_PER_M +
    (completionTokens / 1e6) * PRICE_OUTPUT_PER_M
  );
}

function actorStats(trace, actor) {
  const key = actor || "unknown";
  if (!trace.actors[key]) {
    trace.actors[key] = { spans: 0, llmCalls: 0, toolCalls: 0, llmMs: 0, promptTokens: 0, completionTokens: 0 };
  }
  return trace.actors[key];
}

export function startTrace({ sessionId, userText, sceneId = null }) {
  return {
    id: newTraceId(),
    sessionId: sessionId || "default",
    sceneId,
    startedAt: new Date().toISOString(),
    userText,
    spans: [],
    beats: [],
    actors: {},
    safety: {
      input: { action: "allow", reason: null },
      output: { action: "allow", reason: null },
    },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    counters: {
      llmCalls: 0,
      loops: 0,
      toolCalls: 0,
      reflections: 0,
      reflectionRetries: 0,
      safetyBlocks: 0,
      reactCalls: 0,
      reactsSpoke: 0,
      beats: 0,
      directorCalls: 0,
      criticCalls: 0,
      budgetExhausted: 0,
    },
    timing: { llmMs: 0, toolMs: 0, memoryMs: 0, safetyMs: 0, reflectionMs: 0, ttftMs: null },
    reply: "",
    ok: true,
    error: null,
    _t0: Date.now(),
  };
}

export function addSpan(trace, span) {
  const entry = {
    kind: span.kind,
    actor: span.actor || null,
    name: span.name,
    atMs: Date.now() - trace._t0,
    durMs: Math.max(0, Math.round(span.durMs || 0)),
    ok: span.ok !== false,
    detail: span.detail === undefined ? null : span.detail,
  };
  trace.spans.push(entry);
  const st = actorStats(trace, span.actor);
  st.spans += 1;
  if (span.kind === "llm") st.llmCalls += 1;
  if (span.kind === "tool") st.toolCalls += 1;
  return entry;
}

export function timer() {
  const t0 = Date.now();
  return { ms: () => Date.now() - t0 };
}

export function recordLLM(trace, { actor, step, model, toolChoice, usage, latencyMs, ttftMs, contentChars, toolCalls, finishReason }) {
  trace.usage.promptTokens += usage?.prompt_tokens || 0;
  trace.usage.completionTokens += usage?.completion_tokens || 0;
  trace.usage.totalTokens += usage?.total_tokens || 0;
  trace.timing.llmMs += Math.round(latencyMs || 0);
  trace.counters.llmCalls += 1;
  if (ttftMs != null && trace.timing.ttftMs == null) trace.timing.ttftMs = Math.round(ttftMs);

  const st = actorStats(trace, actor);
  st.llmMs += Math.round(latencyMs || 0);
  st.promptTokens += usage?.prompt_tokens || 0;
  st.completionTokens += usage?.completion_tokens || 0;

  return addSpan(trace, {
    kind: "llm",
    actor,
    name: `step${step}`,
    durMs: latencyMs,
    ok: true,
    detail: {
      model,
      toolChoice: toolChoice || "auto",
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      ttftMs: ttftMs == null ? null : Math.round(ttftMs),
      contentChars: contentChars || 0,
      toolCalls: toolCalls || [],
      finishReason: finishReason || null,
    },
  });
}

export function recordTool(trace, { actor, name, args, result, latencyMs, ok = true }) {
  trace.counters.toolCalls += 1;
  trace.timing.toolMs += Math.round(latencyMs || 0);
  return addSpan(trace, {
    kind: "tool",
    actor,
    name,
    durMs: latencyMs,
    ok,
    detail: { args, result: String(result ?? "").slice(0, 300) },
  });
}

export function recordMemory(trace, { actor, op, count = 0, latencyMs = 0, detail = null, ok = true }) {
  trace.timing.memoryMs += Math.round(latencyMs || 0);
  return addSpan(trace, {
    kind: "memory",
    actor,
    name: op,
    durMs: latencyMs,
    ok,
    detail: detail ?? { count },
  });
}

export function recordSafety(trace, { actor, stage, action, reason = null, latencyMs = 0, reply = null }) {
  if (action !== "allow") trace.counters.safetyBlocks += 1;
  trace.safety[stage] = { action, reason };
  trace.timing.safetyMs += Math.round(latencyMs || 0);
  return addSpan(trace, {
    kind: "safety",
    actor,
    name: `${stage}_guard`,
    durMs: latencyMs,
    ok: action !== "block",
    detail: { action, reason, reply: reply ? String(reply).slice(0, 200) : null },
  });
}

export function recordReflection(trace, { actor, verdict, issue = null, latencyMs = 0, retried = false }) {
  trace.counters.reflections += 1;
  if (retried) trace.counters.reflectionRetries += 1;
  trace.timing.reflectionMs += Math.round(latencyMs || 0);
  return addSpan(trace, {
    kind: "reflection",
    actor,
    name: "critique",
    durMs: latencyMs,
    ok: verdict === "pass",
    detail: { verdict, issue, retried },
  });
}

export function recordLoop(trace) {
  trace.counters.loops += 1;
}

export function recordAuxLLM(trace, { actor, usage, latencyMs = 0 }) {
  trace.usage.promptTokens += usage?.prompt_tokens || 0;
  trace.usage.completionTokens += usage?.completion_tokens || 0;
  trace.usage.totalTokens += usage?.total_tokens || 0;
  trace.counters.llmCalls += 1;
  const st = actorStats(trace, actor);
  st.llmCalls += 1;
  st.llmMs += Math.round(latencyMs || 0);
  st.promptTokens += usage?.prompt_tokens || 0;
  st.completionTokens += usage?.completion_tokens || 0;
}

export function recordReact(trace, { actor }) {
  trace.counters.reactCalls += 1;
  return actor;
}

export function recordBeat(trace, beat) {
  trace.counters.beats += 1;
  trace.beats.push(beat);
  return beat;
}

export function recordDirector(trace) {
  trace.counters.directorCalls += 1;
}

export function recordCritic(trace) {
  trace.counters.criticCalls += 1;
}

export function recordBudgetExhausted(trace) {
  trace.counters.budgetExhausted += 1;
}

export function endTrace(trace, { reply = "", ok = true, error = null } = {}) {
  trace.reply = reply;
  trace.ok = ok;
  trace.error = error;

  trace.totals = {
    totalMs: Date.now() - trace._t0,
    ttftMs: trace.timing.ttftMs,
    llmMs: trace.timing.llmMs,
    toolMs: trace.timing.toolMs,
    memoryMs: trace.timing.memoryMs,
    safetyMs: trace.timing.safetyMs,
    reflectionMs: trace.timing.reflectionMs,
    promptTokens: trace.usage.promptTokens,
    completionTokens: trace.usage.completionTokens,
    totalTokens: trace.usage.totalTokens,
    costCNY: Number(
      estimateCostCNY(trace.usage.promptTokens, trace.usage.completionTokens).toFixed(6)
    ),
    actors: Object.keys(trace.actors).length,
    ...trace.counters,
  };

  delete trace._t0;
  delete trace.usage;
  delete trace.timing;
  delete trace.counters;

  persist(trace);
  pushRing(trace);

  if (process.env.TRACE_VERBOSE === "1") {
    console.log(
      `[trace] ${trace.id} ${trace.totals.totalMs}ms tok=${trace.totals.totalTokens} ` +
        `calls=${trace.totals.llmCalls} actors=${trace.totals.actors} ¥${trace.totals.costCNY}`
    );
  }
  return trace;
}

function pushRing(trace) {
  ring.unshift(trace);
  if (ring.length > RING_SIZE) ring.length = RING_SIZE;
}

function persist(trace) {
  try {
    appendFileSync(TRACE_PATH, JSON.stringify(trace) + "\n", "utf8");
  } catch (e) {
    console.warn("[telemetry] 写入 traces.jsonl 失败：", e.message);
  }
}

function summarize(t) {
  return {
    id: t.id,
    sceneId: t.sceneId || null,
    startedAt: t.startedAt,
    userText: String(t.userText || "").slice(0, 60),
    totalMs: t.totals?.totalMs ?? null,
    ttftMs: t.totals?.ttftMs ?? null,
    totalTokens: t.totals?.totalTokens ?? null,
    costCNY: t.totals?.costCNY ?? null,
    llmCalls: t.totals?.llmCalls ?? 0,
    actors: t.totals?.actors ?? 0,
    beats: t.totals?.beats ?? 0,
    toolCalls: t.totals?.toolCalls ?? 0,
    loops: t.totals?.loops ?? 0,
    reflections: t.totals?.reflections ?? 0,
    reflectionRetries: t.totals?.reflectionRetries ?? 0,
    safetyBlocks: t.totals?.safetyBlocks ?? 0,
    ok: t.ok,
    spanCount: t.spans?.length ?? 0,
  };
}

export function listTraces(limit = 20) {
  const byId = new Map();
  for (const t of ring) {
    if (byId.size >= limit) break;
    byId.set(t.id, summarize(t));
  }
  if (byId.size < limit) {
    const disk = loadAllFromDisk();
    for (let i = disk.length - 1; i >= 0 && byId.size < limit; i -= 1) {
      const t = disk[i];
      if (!byId.has(t.id)) byId.set(t.id, summarize(t));
    }
  }
  return [...byId.values()].slice(0, limit);
}

export function getTrace(id) {
  const hit = ring.find((t) => t.id === id);
  if (hit) return hit;
  return loadAllFromDisk().find((t) => t.id === id) || null;
}

export function metrics({ fromDisk = false } = {}) {
  const source = fromDisk ? loadAllFromDisk() : ring;
  if (!source.length) return { count: 0, note: "暂无 trace 数据" };

  const toolHist = {};
  const actorAgg = {};
  let prompt = 0;
  let completion = 0;
  let cost = 0;
  let totalMs = 0;
  let ttftSum = 0;
  let ttftCount = 0;
  let toolCalls = 0;
  let loops = 0;
  let llmCalls = 0;
  let reactCalls = 0;
  let beats = 0;
  let reflections = 0;
  let retries = 0;
  let safetyBlocks = 0;
  let failed = 0;

  for (const t of source) {
    const x = t.totals || {};
    prompt += x.promptTokens || 0;
    completion += x.completionTokens || 0;
    cost += x.costCNY || 0;
    totalMs += x.totalMs || 0;
    if (x.ttftMs != null) {
      ttftSum += x.ttftMs;
      ttftCount += 1;
    }
    toolCalls += x.toolCalls || 0;
    loops += x.loops || 0;
    llmCalls += x.llmCalls || 0;
    reactCalls += x.reactCalls || 0;
    beats += x.beats || 0;
    reflections += x.reflections || 0;
    retries += x.reflectionRetries || 0;
    safetyBlocks += x.safetyBlocks || 0;
    if (t.ok === false) failed += 1;

    for (const [actor, st] of Object.entries(t.actors || {})) {
      if (!actorAgg[actor]) actorAgg[actor] = { llmCalls: 0, toolCalls: 0, llmMs: 0, tokens: 0 };
      actorAgg[actor].llmCalls += st.llmCalls || 0;
      actorAgg[actor].toolCalls += st.toolCalls || 0;
      actorAgg[actor].llmMs += st.llmMs || 0;
      actorAgg[actor].tokens += (st.promptTokens || 0) + (st.completionTokens || 0);
    }

    for (const s of t.spans || []) {
      if (s.kind === "tool") toolHist[s.name] = (toolHist[s.name] || 0) + 1;
    }
  }

  const n = source.length;
  return {
    count: n,
    source: fromDisk ? "traces.jsonl" : "memory",
    latency: {
      avgTotalMs: Math.round(totalMs / n),
      avgTtftMs: ttftCount ? Math.round(ttftSum / ttftCount) : null,
      ttftSamples: ttftCount,
    },
    tokens: {
      prompt,
      completion,
      total: prompt + completion,
      avgPerRequest: Math.round((prompt + completion) / n),
    },
    cost: { totalCNY: Number(cost.toFixed(4)), avgCNY: Number((cost / n).toFixed(6)) },
    agent: {
      avgLlmCalls: Number((llmCalls / n).toFixed(2)),
      avgLoops: Number((loops / n).toFixed(2)),
      avgToolCalls: Number((toolCalls / n).toFixed(2)),
      avgBeats: Number((beats / n).toFixed(2)),
      reactCalls,
      reflections,
      reflectionRetries: retries,
      toolHistogram: toolHist,
      byActor: actorAgg,
    },
    safety: { blocks: safetyBlocks, blockRate: Number((safetyBlocks / n).toFixed(4)) },
    reliability: { failed, failRate: Number((failed / n).toFixed(4)) },
  };
}

function loadAllFromDisk() {
  try {
    if (!existsSync(TRACE_PATH)) return [];
    return readFileSync(TRACE_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function resetTraces({ alsoDisk = false } = {}) {
  ring.length = 0;
  if (alsoDisk) {
    try {
      writeFileSync(TRACE_PATH, "", "utf8");
    } catch (e) {
      console.warn("[telemetry] 清空 traces.jsonl 失败：", e.message);
    }
  }
}

export const TRACE_FILE = TRACE_PATH;
