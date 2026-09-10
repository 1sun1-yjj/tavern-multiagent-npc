// 场景级评审。工具级的复核在 reflection.js 里，这里评的是"这一拍整体像不像话"：
// 角色有没有出戏、导演的目标有没有被忽略。
import { chatWithModel } from "./llm.js";
import { formatEvent } from "./bus.js";
import { displayName } from "./world.js";
import { addSpan, recordCritic, recordAuxLLM } from "./telemetry.js";
import { parseLooseJson } from "./character.js";

const CRITIC_SYSTEM = `你是这场酒吧小戏的场记。看一遍刚发生的这一拍，判断有没有明显问题。

只输出 JSON，不要解释：
{"verdict":"pass"或"revise","issue":"问题描述（pass 时为空串）","hint":"下一拍该怎么纠正（pass 时为空串）"}

判 revise 的情况：
- 某个角色说出了不符合自己身份的话（比如客人自称店主、跑去调酒）
- 导演明确指派了某个角色做某事，但那个角色完全没响应、也没说明理由
- 出现了不属于任何在场角色的说话内容

不要因为"写得不够精彩"就判 revise，只判明确的越界或遗漏。`;

export async function reviewBeat({ bus, trace, budget, beat, speakers }) {
  if (!beat) return { verdict: "pass", issue: "", hint: "" };
  if (!budget.spend("critic")) return { verdict: "pass", issue: "", hint: "" };
  recordCritic(trace);

  const transcript = bus
    .all()
    .slice(-8)
    .map(formatEvent)
    .join("\n");

  const t0 = Date.now();
  try {
    const res = await chatWithModel({
      model: process.env.SMALL_MODEL || undefined,
      messages: [
        { role: "system", content: CRITIC_SYSTEM },
        {
          role: "user",
          content:
            // 这里必须用显示名。用 id 的话场记会把 "boss" 和 "老板娘" 当成两个人，
            // 然后报告"指派给 boss 但开口的是老板娘"这种假警报。
            `导演本拍的目标：${beat.goal}（指派给 ${displayName(beat.assignee)}）\n` +
            `实际开口的角色：${speakers.map(displayName).join("、") || "（无人开口）"}\n\n` +
            `这一拍的内容：\n${transcript}`,
        },
      ],
    });

    const parsed = parseLooseJson(res.content);
    if (res.usage) {
      budget.addUsage(res.usage);
      recordAuxLLM(trace, { actor: "critic", usage: res.usage, latencyMs: Date.now() - t0 });
    }
    const out =
      parsed && (parsed.verdict === "pass" || parsed.verdict === "revise")
        ? { verdict: parsed.verdict, issue: String(parsed.issue || "").slice(0, 200), hint: String(parsed.hint || "").slice(0, 200) }
        : { verdict: "pass", issue: "", hint: "" };

    addSpan(trace, { kind: "critic", actor: "critic", name: "review", durMs: Date.now() - t0, ok: out.verdict === "pass", detail: out });
    return out;
  } catch (e) {
    addSpan(trace, { kind: "critic", actor: "critic", name: "review", durMs: Date.now() - t0, ok: false, detail: { error: e.message } });
    return { verdict: "pass", issue: "", hint: "" };
  }
}
