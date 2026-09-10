// 工具调完之后回头看一眼：刚才那下真的满足用户意图了吗。
// 主循环里模型是往前看的，这里是往后看的，判据不一样，所以单独放一层。
// 只在真发生过工具调用时才跑，一轮最多一次。
import { chatWithModel } from "./llm.js";

function enabled() {
  return process.env.REFLECTION_ENABLED !== "0";
}

const JUDGE_SYSTEM = `你是一个 Agent 执行质量审核员。你的工作是判断一次工具调用是否真正满足了用户意图。

只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。格式：
{"verdict":"pass"或"revise","issue":"问题描述（verdict=pass 时为空字符串）","hint":"给执行者的修正指令（verdict=pass 时为空字符串）"}

判定标准：
- 用户想要的酒/服务，是否在工具调用里被正确执行了？酒名是否对得上？参数是否有明显错误？
- 如果用户只是闲聊、寒暄，而执行者却调用了工具，判 revise。
- 如果用户明确点了某款酒，工具调用的参数却是另一款，判 revise。
- 参数缺失但可由常识补全、且结果合理，判 pass。
- 不要臆测没发生的错误。工具返回成功且符合用户意图，就判 pass。`;

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function reflectOnTools({ userText, actions }) {
  const empty = { ran: false, verdict: "pass", issue: "", hint: "", latencyMs: 0, usage: null };
  if (!enabled()) return empty;
  if (!actions || !actions.length) return empty;

  const trace = actions
    .map((a) => `- 工具：${a.name}\n  参数：${JSON.stringify(a.args)}\n  返回：${String(a.result).slice(0, 200)}`)
    .join("\n");

  const t0 = Date.now();
  try {
    const res = await chatWithModel({
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: `用户说：「${userText}」\n\n执行者做了：\n${trace}` },
      ],
    });

    const parsed = extractJson(res.content);
    const latencyMs = Date.now() - t0;

    // 审核器自己出错时放行，不能因为它把主流程卡住
    if (!parsed || (parsed.verdict !== "pass" && parsed.verdict !== "revise")) {
      return { ran: true, verdict: "pass", issue: "", hint: "", latencyMs, usage: res.usage, degraded: true };
    }

    return {
      ran: true,
      verdict: parsed.verdict,
      issue: String(parsed.issue || "").slice(0, 300),
      hint: String(parsed.hint || "").slice(0, 300),
      latencyMs,
      usage: res.usage,
    };
  } catch (e) {
    console.warn("[reflection] 反思失败（已跳过）：", e.message);
    return { ...empty, ran: true, latencyMs: Date.now() - t0, degraded: true };
  }
}

export function buildRevisionMessage({ issue, hint }) {
  return (
    "【自我复核未通过】你上一轮的执行有问题，请立即修正：\n" +
    (issue ? `问题：${issue}\n` : "") +
    (hint ? `修正要求：${hint}\n` : "") +
    "请用一次正确的工具调用重新执行，然后用一两句话把结果告诉客人。"
  );
}

export function reflectionEnabled() {
  return enabled();
}
