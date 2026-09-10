#!/usr/bin/env node
/**
 * 观测指标 CLI
 * ------------------------------------------------------------------
 * 从 traces.jsonl 汇总真实运行数据：延迟、首字延迟、token、成本、
 * 工具调用分布、反思触发、安全拦截率。
 *
 * 用法：
 *   npm run metrics
 *   node eval/metrics.js --json     输出原始 JSON
 */
import "dotenv/config";
import { metrics } from "../agent/telemetry.js";

const asJson = process.argv.includes("--json");
const m = metrics({ fromDisk: true });

if (asJson) {
  console.log(JSON.stringify(m, null, 2));
  process.exit(0);
}

if (!m.count) {
  console.log("\n暂无 trace 数据。先跑几轮对话（或 npm run eval:e2e）再来看看。\n");
  process.exit(0);
}

function pad(s, w) {
  let len = 0;
  for (const ch of String(s)) len += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return String(s) + " ".repeat(Math.max(0, w - len));
}

const line = (k, v) => console.log(`  ${pad(k, 24)}${v}`);

console.log("");
console.log("═".repeat(56));
console.log(" 星布谷地 · 岁月酒吧 —— 运行观测指标");
console.log("═".repeat(56));
console.log("");
line("样本量（trace 数）", m.count);
line("数据来源", m.source);
console.log("");
console.log("  【延迟】");
line("平均端到端耗时", `${m.latency.avgTotalMs} ms`);
line("平均首字延迟 TTFT", m.latency.avgTtftMs == null ? "—（无流式样本）" : `${m.latency.avgTtftMs} ms（${m.latency.ttftSamples} 个样本）`);
console.log("");
console.log("  【用量与成本】");
line("Prompt tokens", m.tokens.prompt);
line("Completion tokens", m.tokens.completion);
line("总 tokens", m.tokens.total);
line("平均每轮 tokens", m.tokens.avgPerRequest);
line("总成本（估算）", `¥${m.cost.totalCNY}`);
line("平均每轮成本", `¥${m.cost.avgCNY}`);
console.log("");
console.log("  【Agent 行为】");
line("平均编排轮数", m.agent.avgLoops);
line("平均工具调用数", m.agent.avgToolCalls);
line("工具调用分布", Object.entries(m.agent.toolHistogram).map(([k, v]) => `${k}×${v}`).join("  ") || "—");
line("反思触发次数", m.agent.reflections);
line("反思导致重试", m.agent.reflectionRetries);
console.log("");
console.log("  【安全与可靠性】");
line("安全拦截次数", `${m.safety.blocks}（${(m.safety.blockRate * 100).toFixed(2)}%）`);
line("失败请求", `${m.reliability.failed}（${(m.reliability.failRate * 100).toFixed(2)}%）`);
console.log("");
console.log("  提示：费率默认值为示例，请在 .env 中按官网最新价格调整");
console.log("        PRICE_INPUT_PER_M / PRICE_OUTPUT_PER_M");
console.log("");
