/**
 * Reflection 层（自我反思）
 * ------------------------------------------------------------------
 * Agent 四要素之一：Planning / Memory / Tool Use / **Reflection**。
 * 本项目初版缺的正是这一环。
 *
 * 做什么：在一次工具调用执行完之后，让模型回头检查
 *   「刚才这次工具调用，是否真的满足了用户这一句话的意图？」
 * 如果判定为不满足，就产出一条修正提示，交回编排循环再跑一轮。
 *
 * 为什么值得单独一层，而不是塞进主循环的 prompt：
 *   主循环里模型是"向前看"的（决定下一步做什么），
 *   Reflection 是"向后看"的（评价刚做完的事对不对）。
 *   两者的判据不同，混在一起会让模型既当运动员又当裁判。
 *
 * 成本控制：只在**发生过工具调用**时才触发；每轮对话最多触发一次；
 * 用非流式小请求，prompt 里只带必要信息。
 */
import { chatWithModel } from "./llm.js";

/** 运行时读取，便于评测按套件单独开关 */
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
  // 模型偶尔会包 ```json ... ```，先剥掉再找第一个平衡的 JSON 对象
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

/**
 * 对一次（或一组）工具调用做反思。
 *
 * @param {object} args
 * @param {string} args.userText   用户这一句原话
 * @param {Array}  args.actions    本轮已执行的工具调用 [{name, args, result}]
 * @returns {Promise<{ran:boolean, verdict:"pass"|"revise", issue:string, hint:string, latencyMs:number, usage:object|null}>}
 */
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

    if (!parsed || (parsed.verdict !== "pass" && parsed.verdict !== "revise")) {
      // 判不出来就放行，不要因为审核器本身出错而卡住主流程
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
    // Reflection 是增强而非必需，失败必须静默降级
    console.warn("[reflection] 反思失败（已跳过）：", e.message);
    return { ...empty, ran: true, latencyMs: Date.now() - t0, degraded: true };
  }
}

/** 把反思结论转成回灌给编排循环的系统消息 */
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
