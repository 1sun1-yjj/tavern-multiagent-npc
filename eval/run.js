#!/usr/bin/env node
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { detectIntent } from "../agent/intent.js";
import { guardInput, guardOutput } from "../agent/safety.js";
import { rankMemories } from "../agent/vectorstore.js";
import { buildSystemPrompt, runAgentStream } from "../agent/agent.js";
import * as CASES from "./cases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

// 环境变量是调用时才读的，所以这里能覆盖，不受 import 提升影响
if (has("no-reflection")) process.env.REFLECTION_ENABLED = "0";
if (has("no-safety")) process.env.SAFETY_ENABLED = "0";

const SUITE_DEFS = {
  intent: { label: "意图路由", mode: "offline" },
  safety: { label: "安全守卫", mode: "offline" },
  retrieval: { label: "记忆检索", mode: "offline" },
  prompt: { label: "Prompt 记忆注入", mode: "offline" },
  persona: { label: "人设一致性", mode: "online" },
  e2e: { label: "工具调用端到端", mode: "online" },
};
const OFFLINE = Object.keys(SUITE_DEFS).filter((k) => SUITE_DEFS[k].mode === "offline");
const ONLINE = Object.keys(SUITE_DEFS).filter((k) => SUITE_DEFS[k].mode === "online");

function resolveSuites(spec) {
  if (!spec || spec === "offline") return OFFLINE;
  if (spec === "all") return [...OFFLINE, ...ONLINE];
  return spec.split(",").map((s) => s.trim()).filter((s) => SUITE_DEFS[s]);
}

function summarize(key, cases, extra = {}) {
  const total = cases.length;
  const passed = cases.filter((c) => c.pass).length;
  return {
    key,
    label: SUITE_DEFS[key].label,
    mode: SUITE_DEFS[key].mode,
    total,
    passed,
    failed: total - passed,
    accuracy: total ? Number((passed / total).toFixed(4)) : null,
    cases,
    ...extra,
  };
}

function skipped(key, reason) {
  return {
    key,
    label: SUITE_DEFS[key].label,
    mode: SUITE_DEFS[key].mode,
    skipped: true,
    reason,
    total: 0, passed: 0, failed: 0, accuracy: null,
    cases: [],
  };
}

function hasKey() {
  const k = process.env.DEEPSEEK_API_KEY;
  return Boolean(k && !k.includes("xxxx"));
}

async function runAgentOnce(text, sessionId) {
  const messages = [];
  const events = [];
  let reply = "";
  for await (const ev of runAgentStream({ userText: text, messages, sessionId })) {
    events.push(ev);
    if (ev.type === "delta") reply += ev.text;
    if (ev.type === "done") reply = ev.reply || reply;
  }
  return { reply, events };
}

function suiteIntent() {
  const cases = CASES.INTENT_CASES.map((c, i) => {
    const actual = detectIntent(c.text).tool || null;
    return {
      id: `intent-${i + 1}`,
      input: c.text,
      expected: c.expect === null ? "无意图(放行给模型)" : c.expect,
      actual: actual === null ? "无意图(放行给模型)" : actual,
      pass: actual === c.expect,
      note: c.note || "",
    };
  });
  return summarize("intent", cases);
}

function suiteSafety() {
  const cases = [];
  let blockHit = 0;
  let falsePositives = 0;
  let outBlockHit = 0;
  let outFalsePositives = 0;

  CASES.SAFETY_BLOCK_CASES.forEach((c, i) => {
    const r = guardInput(c.text);
    const pass = r.action === "deflect";
    if (pass) blockHit += 1;
    cases.push({
      id: `safety-block-${i + 1}`,
      input: c.text,
      expected: `拦截(${c.reason})`,
      actual: r.action === "deflect" ? `拦截(${r.reason})` : "放行",
      pass,
      note: c.note || "",
    });
  });

  CASES.SAFETY_ALLOW_CASES.forEach((c, i) => {
    const r = guardInput(c.text);
    const pass = r.action === "allow";
    if (!pass) falsePositives += 1;
    cases.push({
      id: `safety-allow-${i + 1}`,
      input: c.text,
      expected: "放行",
      actual: r.action === "allow" ? "放行" : `误拦(${r.reason})`,
      pass,
      note: c.note || "",
    });
  });

  CASES.OUTPUT_BLOCK_CASES.forEach((c, i) => {
    const r = guardOutput(c.text);
    const pass = r.action === "replace";
    if (pass) outBlockHit += 1;
    cases.push({
      id: `safety-out-block-${i + 1}`,
      input: c.text,
      expected: `替换(${c.reason})`,
      actual: r.action === "replace" ? `替换(${r.reason})` : "放行",
      pass,
    });
  });

  CASES.OUTPUT_ALLOW_CASES.forEach((c, i) => {
    const r = guardOutput(c.text);
    const pass = r.action === "allow";
    if (!pass) outFalsePositives += 1;
    cases.push({
      id: `safety-out-allow-${i + 1}`,
      input: c.text,
      expected: "放行",
      actual: r.action === "allow" ? "放行" : `误替换(${r.reason})`,
      pass,
    });
  });

  return summarize("safety", cases, {
    detail: {
      输入拦截召回率: Number((blockHit / CASES.SAFETY_BLOCK_CASES.length).toFixed(4)),
      输入误报率: Number((falsePositives / CASES.SAFETY_ALLOW_CASES.length).toFixed(4)),
      输出拦截召回率: Number((outBlockHit / CASES.OUTPUT_BLOCK_CASES.length).toFixed(4)),
      输出误报率: Number((outFalsePositives / CASES.OUTPUT_ALLOW_CASES.length).toFixed(4)),
    },
  });
}

function suiteRetrieval() {
  const cases = CASES.RETRIEVAL_CASES.map((c) => {
    let actual = [];
    let pass = true;
    let err = "";
    try {
      actual = rankMemories(c.entries, c.query, c.opts).map((m) => m.text);
      pass = JSON.stringify(actual) === JSON.stringify(c.expectTexts);
    } catch (e) {
      pass = false;
      err = `抛错: ${e.message}`;
      actual = [err];
    }
    return {
      id: c.id,
      input: c.name,
      expected: c.expectTexts.length ? c.expectTexts.join(" > ") : "(空)",
      actual: err || (actual.length ? actual.join(" > ") : "(空)"),
      pass,
    };
  });
  return summarize("retrieval", cases);
}

function suitePrompt() {
  const cases = CASES.PROMPT_CASES.map((c) => {
    let prompt = "";
    const why = [];
    try {
      prompt = buildSystemPrompt(c.profile, c.eggHint || "", c.memoryNote || "");
    } catch (e) {
      why.push(`抛错: ${e.message}`);
    }
    for (const s of c.mustInclude || []) if (!prompt.includes(s)) why.push(`缺少「${s}」`);
    for (const s of c.mustExclude || []) if (prompt.includes(s)) why.push(`不该出现「${s}」`);
    return {
      id: c.id,
      input: c.name,
      expected: "满足注入断言",
      actual: why.length ? why.join("；") : "通过",
      pass: why.length === 0,
    };
  });
  return summarize("prompt", cases);
}

async function suitePersona() {
  if (!hasKey()) return skipped("persona", "缺少 DEEPSEEK_API_KEY");
  const cases = [];
  for (const c of CASES.PERSONA_CASES) {
    let reply = "";
    let events = [];
    const why = [];
    try {
      const r = await runAgentOnce(c.text, "eval/persona");
      reply = r.reply;
      events = r.events;
    } catch (e) {
      why.push(`调用失败: ${e.message}`);
    }
    if (!why.length) {
      const blocked = events.some((e) => e.type === "safety" && e.action === "block");
      if (c.expectGuardBlock && !blocked) why.push("安全层未拦截");
      if (c.mustNotMatch && c.mustNotMatch.test(reply)) why.push(`命中违规模式 ${c.mustNotMatch}`);
      if (c.mustMatch && !c.mustMatch.test(reply)) why.push(`缺少期望模式 ${c.mustMatch}`);
      const og = guardOutput(reply);
      if (og.action !== "allow") why.push(`输出守卫判为 ${og.reason}`);
    }
    cases.push({
      id: c.id,
      input: c.text,
      category: c.category,
      expected: c.expectGuardBlock ? "应被安全层拦截" : "符合人设、不违规",
      actual: reply.slice(0, 110).replace(/\n/g, " "),
      pass: why.length === 0,
      note: why.join("；"),
    });
  }
  return summarize("persona", cases);
}

async function suiteE2E() {
  if (!hasKey()) return skipped("e2e", "缺少 DEEPSEEK_API_KEY");
  const cases = [];
  let toolMissing = 0;
  let toolSpurious = 0;
  for (const c of CASES.E2E_TOOL_CASES) {
    let called = [];
    const why = [];
    try {
      const r = await runAgentOnce(c.text, "eval/e2e");
      called = r.events.filter((e) => e.type === "action").map((e) => e.name);
    } catch (e) {
      why.push(`调用失败: ${e.message}`);
    }
    const uniq = [...new Set(called)];
    if (!why.length) {
      const missing = c.expectTools.filter((t) => !uniq.includes(t));
      const spurious = uniq.filter((t) => !c.expectTools.includes(t));
      if (missing.length) {
        why.push(`漏调 ${missing.join(",")}`);
        toolMissing += missing.length;
      }
      if (spurious.length) {
        why.push(`多调 ${spurious.join(",")}`);
        toolSpurious += spurious.length;
      }
    }
    cases.push({
      id: `e2e-${cases.length + 1}`,
      input: c.text,
      expected: c.expectTools.length ? c.expectTools.join(",") : "不调用任何工具",
      actual: uniq.length ? uniq.join(",") : "不调用任何工具",
      pass: why.length === 0,
      note: [c.note, ...why].filter(Boolean).join("；"),
    });
  }
  return summarize("e2e", cases, {
    detail: { 漏调次数: toolMissing, 多调次数: toolSpurious },
  });
}

function pad(s, width) {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return String(s) + " ".repeat(Math.max(0, width - w));
}

function pct(x) {
  return x === null || x === undefined ? "  -  " : `${(x * 100).toFixed(1)}%`;
}

function renderConsole(results, meta) {
  const lines = [];
  lines.push("");
  lines.push("═".repeat(64));
  lines.push(" 星布谷地 · 岁月酒吧 —— 评测报告");
  lines.push(` ${meta.at} ｜ 反思层 ${meta.reflection ? "开" : "关"} ｜ 安全层 ${meta.safety ? "开" : "关"}`);
  lines.push("═".repeat(64));
  lines.push("");
  lines.push(pad("套件", 22) + pad("用例", 6) + pad("通过", 6) + pad("失败", 6) + pad("准确率", 10) + "模式");
  lines.push("─".repeat(64));

  let T = 0, P = 0, F = 0;
  for (const r of results) {
    if (r.skipped) {
      lines.push(pad(r.label, 22) + pad("—", 6) + pad("—", 6) + pad("—", 6) + pad("跳过", 10) + r.reason);
      continue;
    }
    T += r.total; P += r.passed; F += r.failed;
    lines.push(
      pad(r.label, 22) +
        pad(r.total, 6) +
        pad(r.passed, 6) +
        pad(r.failed, 6) +
        pad(pct(r.accuracy), 10) +
        (r.mode === "offline" ? "离线" : "在线")
    );
  }
  lines.push("─".repeat(64));
  lines.push(pad("合计", 22) + pad(T, 6) + pad(P, 6) + pad(F, 6) + pad(T ? `${((P / T) * 100).toFixed(1)}%` : "-", 10));
  lines.push("");

  for (const r of results) {
    if (r.skipped || !r.detail) continue;
    lines.push(`【${r.label}】细分指标`);
    for (const [k, v] of Object.entries(r.detail)) {
      lines.push(`   ${pad(k, 26)}${typeof v === "number" && v <= 1 ? pct(v) : v}`);
    }
    lines.push("");
  }

  const failed = results.flatMap((r) => r.cases.filter((c) => !c.pass).map((c) => ({ suite: r.label, ...c })));
  if (failed.length) {
    lines.push(`【失败用例】共 ${failed.length} 条`);
    for (const c of failed) {
      lines.push(`   ✗ [${c.suite}] ${c.input}`);
      lines.push(`       期望 ${c.expected} ｜ 实际 ${c.actual}${c.note ? " ｜ " + c.note : ""}`);
    }
    lines.push("");
  } else {
    lines.push("【失败用例】无 —— 全部通过");
    lines.push("");
  }

  return lines.join("\n");
}

function mdEscape(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderMarkdown(report) {
  const L = [];
  L.push("# 评测报告 — 星布谷地 · 岁月酒吧");
  L.push("");
  L.push(`> 生成时间：${report.meta.at}`);
  L.push(`> 反思层：**${report.meta.reflection ? "开启" : "关闭"}** ｜ 安全层：**${report.meta.safety ? "开启" : "关闭"}**`);
  L.push("> 复现命令：`npm run eval`（离线） / `npm run eval:e2e`（在线，需 API Key）");
  L.push("");
  L.push("## 总览");
  L.push("");
  L.push("| 套件 | 用例 | 通过 | 失败 | 准确率 | 模式 |");
  L.push("|---|---:|---:|---:|---:|---|");

  let T = 0, P = 0, F = 0;
  for (const r of report.results) {
    if (r.skipped) {
      L.push(`| ${r.label} | — | — | — | 跳过（${r.reason}） | ${r.mode} |`);
      continue;
    }
    T += r.total; P += r.passed; F += r.failed;
    L.push(`| ${r.label} | ${r.total} | ${r.passed} | ${r.failed} | **${pct(r.accuracy)}** | ${r.mode === "offline" ? "离线" : "在线"} |`);
  }
  L.push(`| **合计** | **${T}** | **${P}** | **${F}** | **${T ? `${((P / T) * 100).toFixed(1)}%` : "-"}** | — |`);
  L.push("");

  for (const r of report.results) {
    if (r.skipped || !r.detail) continue;
    L.push(`### ${r.label} —— 细分指标`);
    L.push("");
    L.push("| 指标 | 数值 |");
    L.push("|---|---:|");
    for (const [k, v] of Object.entries(r.detail)) {
      L.push(`| ${k} | ${typeof v === "number" && v <= 1 ? pct(v) : v} |`);
    }
    L.push("");
  }

  const failed = report.results.flatMap((r) => r.cases.filter((c) => !c.pass).map((c) => ({ suite: r.label, ...c })));
  L.push("## 失败用例明细");
  L.push("");
  if (!failed.length) {
    L.push("无 —— 全部通过。");
  } else {
    L.push("> 失败用例标出了系统当前的真实能力边界。");
    L.push("");
    L.push("| 套件 | 输入 | 期望 | 实际 | 备注 |");
    L.push("|---|---|---|---|---|");
    for (const c of failed) {
      L.push(`| ${c.suite} | ${mdEscape(c.input)} | ${mdEscape(c.expected)} | ${mdEscape(c.actual)} | ${mdEscape(c.note || "")} |`);
    }
  }
  L.push("");
  L.push("## 全部用例");
  L.push("");
  for (const r of report.results) {
    if (r.skipped) continue;
    L.push(`<details><summary>${r.label}（${r.passed}/${r.total}）</summary>`);
    L.push("");
    L.push("| # | 输入 | 期望 | 实际 | 结果 |");
    L.push("|---|---|---|---|---|");
    r.cases.forEach((c, i) => {
      L.push(`| ${i + 1} | ${mdEscape(c.input)} | ${mdEscape(c.expected)} | ${mdEscape(c.actual)} | ${c.pass ? "✅" : "❌"} |`);
    });
    L.push("");
    L.push("</details>");
    L.push("");
  }
  return L.join("\n");
}

async function main() {
  const spec = opt("suite", "offline");
  const selected = resolveSuites(spec);
  const meta = {
    at: new Date().toISOString().replace("T", " ").slice(0, 19),
    reflection: process.env.REFLECTION_ENABLED !== "0",
    safety: process.env.SAFETY_ENABLED !== "0",
    suites: selected,
  };

  console.log(`\n▶ 开始评测：${selected.join(", ")}`);

  const runners = {
    intent: suiteIntent,
    safety: suiteSafety,
    retrieval: suiteRetrieval,
    prompt: suitePrompt,
    persona: suitePersona,
    e2e: suiteE2E,
  };

  const results = [];
  for (const key of selected) {
    process.stdout.write(`  · ${SUITE_DEFS[key].label}…`);
    const r = await runners[key]();
    results.push(r);
    process.stdout.write(r.skipped ? ` 跳过（${r.reason}）\n` : ` ${r.passed}/${r.total}\n`);
  }

  const report = { meta, results };
  console.log(renderConsole(results, meta));

  mkdirSync(__dirname, { recursive: true });
  writeFileSync(join(__dirname, "report.json"), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(join(__dirname, "report.md"), renderMarkdown(report), "utf8");
  console.log(`✔ 报告已写入：${join("eval", "report.md")} 与 ${join("eval", "report.json")}\n`);

  process.exitCode = results.some((r) => !r.skipped && r.failed > 0) ? 1 : 0;
}

main().catch((e) => {
  console.error("\n✗ 评测执行失败：", e);
  process.exitCode = 2;
});
