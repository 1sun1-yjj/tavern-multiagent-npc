// 导演层。单 Agent 只会对玩家每句话做反应，没有"这一场戏往哪走"的概念，
// 这一层补的就是那个：它决定本拍该推进什么，交给谁去做。
// 不是每拍都跑——只在每 N 拍或触发条件下跑，否则成本翻倍。
import { chatWithModel } from "./llm.js";
import { formatEvent } from "./bus.js";
import { addSpan, recordDirector, recordAuxLLM } from "./telemetry.js";
import { parseLooseJson } from "./character.js";
import { getWorld } from "./world.js";

const EVERY_N_BEATS = Number(process.env.DIRECTOR_EVERY || 3);

const DIRECTOR_SYSTEM = `你是一场酒吧小戏的导演。你不写台词，只决定这一拍该发生什么。

只输出一个 JSON，不要解释：
{"goal":"这一拍要达成什么（一句话）","assignee":"角色 id","why":"为什么交给他"}

可选的角色 id 与特点：
- boss（老板娘）：在后厨/吧台，负责招待和调酒，跟客人熟
- regular（老周）：坐在角落的常客，话慢，爱点评，跟老板娘很熟
注意 assignee 要填 id（boss 或 regular），不是名字。

调度原则：
- 玩家正跟谁说话，那一拍就该由谁主导，不要抢戏
- 别每拍都安排别人插话，安静的场次也很好
- 如果场面太平（连续几拍只是点单对话），可以让另一个角色带出一点新东西
- 不要编造不存在的角色`;

export function shouldPlanBeat({ beatIndex, userText, lastBeatAt }) {
  if (beatIndex === 0) return true;
  if (/^(嗯+|哦+|啊+|……|\.\.\.)$/.test(String(userText || "").trim())) return true;
  if (String(userText || "").trim().length <= 3) return true;
  return beatIndex - lastBeatAt >= EVERY_N_BEATS;
}

export async function planBeat({ bus, trace, budget, speakerId }) {
  if (!budget.spend("director")) return null;
  recordDirector(trace);

  const present = getWorld().present;
  const recent = bus
    .all()
    .slice(-6)
    .map(formatEvent)
    .join("\n");

  const t0 = Date.now();
  try {
    const res = await chatWithModel({
      model: process.env.SMALL_MODEL || undefined,
      messages: [
        { role: "system", content: DIRECTOR_SYSTEM },
        {
          role: "user",
          content:
            `在场角色：${present.join("、")}\n` +
            `玩家正在对话的对象：${speakerId}\n\n` +
            `最近发生了什么：\n${recent}`,
        },
      ],
    });

    const parsed = parseLooseJson(res.content);
    if (res.usage) {
      budget.addUsage(res.usage);
      recordAuxLLM(trace, { actor: "director", usage: res.usage, latencyMs: Date.now() - t0 });
    }
    if (!parsed || !parsed.assignee) {
      addSpan(trace, { kind: "beat", actor: "director", name: "plan", durMs: Date.now() - t0, ok: false, detail: { degraded: true } });
      return null;
    }

    // 导演只能调度在场的人，不能凭空造人
    const assignee = present.includes(parsed.assignee) ? parsed.assignee : speakerId;
    const beat = {
      goal: String(parsed.goal || "").slice(0, 120),
      assignee,
      why: String(parsed.why || "").slice(0, 80),
    };

    addSpan(trace, { kind: "beat", actor: "director", name: "plan", durMs: Date.now() - t0, detail: beat });
    return beat;
  } catch (e) {
    addSpan(trace, { kind: "beat", actor: "director", name: "plan", durMs: Date.now() - t0, ok: false, detail: { error: e.message } });
    return null;
  }
}

export const DIRECTOR_CONFIG = { EVERY_N_BEATS };
