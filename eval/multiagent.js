import { runAgentStream, runAmbientStream, resolveSpeaker, getAmbientState } from "../agent/agent.js";
import { resetSceneState } from "../agent/scene.js";
import { resetWorld } from "../agent/world.js";
import { createRoster } from "../agent/characters.js";
import { getTrace } from "../agent/telemetry.js";

const LABEL = "多 Agent 协作";
const KEY = "multiagent";

let savedEnv = null;

function relaxThresholds() {
  savedEnv = {
    REACT_THRESHOLD: process.env.REACT_THRESHOLD,
    SECONDARY_COOLDOWN: process.env.SECONDARY_COOLDOWN,
    SECRET: undefined,
  };
  process.env.REACT_THRESHOLD = "0";
  process.env.SECONDARY_COOLDOWN = "0";
}

function restoreThresholds() {
  if (!savedEnv) return;
  for (const [k, v] of Object.entries({ REACT_THRESHOLD: savedEnv.REACT_THRESHOLD, SECONDARY_COOLDOWN: savedEnv.SECONDARY_COOLDOWN })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv = null;
}

async function once(text, { target = null } = {}) {
  const histories = {};
  const events = [];
  let done = null;
  for await (const ev of runAgentStream({ userText: text, sessionId: "eval/multiagent", target, histories })) {
    events.push(ev);
    if (ev.type === "done") done = ev;
  }
  return { events, done, text: done?.reply || "", replies: done?.replies || {}, histories };
}

async function onceAmbient({ idleMs = 600000, force = false } = {}) {
  const histories = {};
  const events = [];
  let done = null;
  for await (const ev of runAmbientStream({ sessionId: "eval/multiagent", histories, idleMs, force })) {
    events.push(ev);
    if (ev.type === "done") done = ev;
  }
  return { events, done, text: done?.reply || "", histories };
}

function mk(id, input, expected, actual, pass, note = "") {
  return { id, input, expected, actual: String(actual).replace(/\n/g, " ").slice(0, 110), pass, note };
}

export async function runMultiagentSuite(hasKey) {
  if (!hasKey) {
    return { key: KEY, label: LABEL, mode: "online", skipped: true, reason: "缺少 DEEPSEEK_API_KEY", total: 0, passed: 0, failed: 0, accuracy: null, cases: [] };
  }

  resetSceneState();
  resetWorld();
  relaxThresholds();

  const cases = [];
  let totalCalls = 0;
  let beats = 0;
  let secondarySpoke = 0;

  try {
    const r1 = resolveSpeaker("钟离，你怎么看？", null);
    cases.push(mk("route_alias", "钟离，你怎么看？", "regular", r1, r1 === "regular"));
    const r2 = resolveSpeaker("你好呀", null);
    cases.push(mk("route_default", "你好呀", "boss", r2, r2 === "boss"));
    const r3 = resolveSpeaker("钟离", "boss");
    cases.push(mk("route_explicit", "显式 target 优先于文本", "boss", r3, r3 === "boss", "显式指定应压过称呼识别"));

    const boss = await once("你是谁？", { target: "boss" });
    totalCalls += boss.done?.budget?.calls || 0;
    beats += 1;
    cases.push(
      mk(
        "role_boss",
        "你是谁？（对胡桃）",
        "自称胡桃/老板娘/店主/吧台里的人",
        boss.text,
        /胡桃|老板娘|老板|店主|调酒|看店|吧台|围裙|我这儿/.test(boss.text) &&
          !/我只是(个)?客人|我是客人/.test(boss.text)
      )
    );

    const reg = await once("你是谁？", { target: "regular" });
    totalCalls += reg.done?.budget?.calls || 0;
    beats += 1;
    cases.push(
      mk(
        "role_regular",
        "你是谁？（对钟离）",
        "自称客人/常客，不自称店主",
        reg.text,
        /客人|主顾|常客|退休|老师|坐/.test(reg.text) && !/我是胡桃|我是老板娘|我是店主|我开这?家|我调酒/.test(reg.text)
      )
    );

    const orderToRegular = await once("给我来杯尼格罗尼", { target: "regular" });
    totalCalls += orderToRegular.done?.budget?.calls || 0;
    beats += 1;
    const regTools = orderToRegular.events
      .filter((e) => e.type === "action" && e.actor === "regular")
      .map((e) => e.name);
    const bossToolsHere = orderToRegular.events
      .filter((e) => e.type === "action" && e.actor === "boss")
      .map((e) => e.name);
    cases.push(
      mk(
        "regular_no_tools",
        "给我来杯尼格罗尼（对钟离）",
        "钟离不调用任何工具，并把话推给胡桃",
        regTools.length ? `钟离调用了 ${regTools.join(",")}` : `钟离无工具调用 ｜ ${orderToRegular.text}`,
        regTools.length === 0 && /胡桃|老板娘|得问|做不了主|不是我说了算|问她|管不着/.test(orderToRegular.text),
        bossToolsHere.length ? `同拍胡桃代为调了 ${bossToolsHere.join(",")}` : "同拍胡桃没有接手"
      )
    );
    cases.push(
      mk(
        "order_never_lost",
        "点单落到没有工具的常客身上时，这一单必须由能做的人接手落地",
        "同拍出现 boss 的 makeDrink",
        bossToolsHere.length ? `胡桃调了 ${bossToolsHere.join(",")}` : "没有人调酒 —— 这单丢了",
        bossToolsHere.includes("makeDrink"),
        "玩家点了酒却一口没喝到，比答错更严重（见 README 坑 11）"
      )
    );

    const orderToBoss = await once("给我来一杯金汤力", { target: "boss" });
    totalCalls += orderToBoss.done?.budget?.calls || 0;
    beats += 1;
    const bossTools = orderToBoss.events.filter((e) => e.type === "action").map((e) => e.name);
    cases.push(
      mk("boss_tools_ok", "给我来一杯金汤力（对胡桃）", "调用 makeDrink", bossTools.join(",") || "无", bossTools.includes("makeDrink"))
    );

    const deltas = boss.events.filter((e) => e.type === "delta");
    const known = new Set(createRoster().map((c) => c.id));
    const allTagged = deltas.length > 0 && deltas.every((e) => e.actor && known.has(e.actor));
    cases.push(
      mk("actor_attribution", "所有流式事件都归属到已知角色", "全部带合法 actor", `${deltas.length} 条 delta`, allTagged)
    );

    const aware = await once("店里除了我还有别人吗？", { target: "boss" });
    totalCalls += aware.done?.budget?.calls || 0;
    beats += 1;
    cases.push(mk("cross_awareness", "店里除了我还有别人吗？", "提到在场的钟离", aware.text, /钟离|那边|角落|常客/.test(aware.text)));

    const presentAsk = await once("钟离今天来了吗？", { target: "boss" });
    totalCalls += presentAsk.done?.budget?.calls || 0;
    beats += 1;
    const deniesPresence = (t) => /(没来|没见着|没见过|没在|不在|还没到|见不着)/.test(t);
    const affirmsPresence = (t) => /(在场|来了|在呢|在啊|在的|坐在|坐着|就在|在那边|在角落|在窗|那边那位)/.test(t);
    cases.push(
      mk(
        "presence_not_denied",
        "钟离今天来了吗？（对胡桃，而他就在场）",
        "承认钟离在场，不许说成没来",
        presentAsk.text,
        !deniesPresence(presentAsk.text) && affirmsPresence(presentAsk.text)
      )
    );

    const aboutGuest = await once("钟离你最近怎么样", { target: null });
    totalCalls += aboutGuest.done?.budget?.calls || 0;
    beats += 1;
    const bossLine = aboutGuest.replies?.boss || "";
    cases.push(
      mk(
        "secondary_presence_ok",
        "钟离你最近怎么样（点名钟离，胡桃跟着插话）",
        "胡桃插话时也不许说钟离没来、没见着人影",
        bossLine || "（这一拍胡桃没开口）",
        !deniesPresence(bossLine),
        bossLine ? "" : "本拍胡桃未插话，未验到"
      )
    );

    const guestAsk = await once("钟离今天来了吗？", { target: "regular" });
    totalCalls += guestAsk.done?.budget?.calls || 0;
    beats += 1;
    cases.push(
      mk(
        "presence_self_aware",
        "钟离今天来了吗？（问钟离本人）",
        "以第一人称确认自己在场，不把自己说成没来",
        guestAsk.text,
        /(我|俺|本人)/.test(guestAsk.text) && !/(我没来|我没在|我不在)/.test(guestAsk.text)
      )
    );

    const budgets = [boss, reg, orderToRegular, orderToBoss, aware, presentAsk, guestAsk, aboutGuest].map((x) => x.done?.budget).filter(Boolean);
    const overrun = budgets.filter((b) => b.calls > b.limit);
    cases.push(
      mk(
        "budget_watchdog",
        "每次输入的总调用数不超上限",
        `全部 <= ${budgets[0]?.limit}`,
        budgets.map((b) => b.calls).join(", "),
        overrun.length === 0
      )
    );

    const roomLines = [
      "今天店里好安静啊，就我一个人吗",
      "钟离你天天来这儿不腻吗",
      "你们俩认识很久了吧",
      "来杯酒，也给旁边那位来一杯",
    ];
    let roomLast = null;
    let roomLine = "";
    for (const line of roomLines) {
      const r = await once(line, { target: "boss" });
      totalCalls += r.done?.budget?.calls || 0;
      beats += 1;
      roomLast = r;
      roomLine = line;
      const speakers = r.done?.speakers || [];
      if (speakers.length > 1) {
        secondarySpoke += 1;
        cases.push(mk("secondary_speaker", line, "出现非主角发言", speakers.join(" + "), true));
        break;
      }
    }
    if (secondarySpoke === 0) {
      cases.push(
        mk("secondary_speaker", "连续 4 拍邀请旁人就场", "至少出现一次非主角发言", "未出现", false, "react 判定始终未过阈值")
      );
    }

    const roomTrace = roomLast?.done?.traceId ? getTrace(roomLast.done.traceId) : null;
    const roomSpeakers = roomLast?.done?.speakers || [];
    const followupReacts = roomTrace?.totals?.followupReacts ?? 0;
    cases.push(
      mk(
        "followup_react",
        `没人当场插话时要补跑一次听完回话的 react（${roomLine}）`,
        "出现非主角发言，或 trace 里有 followup 阶段的 react",
        `speakers=${roomSpeakers.join("+") || "无"} followupReacts=${followupReacts}`,        roomSpeakers.length > 1 || followupReacts > 0
      )
    );

    const quietLines = [
      "今天天气还不错",
      "我随便看看",
      "这酒单看起来挺讲究",
      "我明天还得早起",
      "杯子挺好看的",
    ];
    let guestSpoke = 0;
    const guestSpokeOn = [];
    let quietLast = null;
    for (const line of quietLines) {
      const r = await once(line, { target: "boss" });
      totalCalls += r.done?.budget?.calls || 0;
      beats += 1;
      quietLast = r;
      if ((r.done?.speakers || []).includes("regular")) {
        guestSpoke += 1;
        guestSpokeOn.push(line);
      }
    }
    cases.push(
      mk(
        "interject_occasional",
        "5 句跟钟离无关的闲聊，他不该句句都接",
        "最多接 2 句",
        `接了 ${guestSpoke} 句${guestSpokeOn.length ? "：" + guestSpokeOn.join(" / ") : ""}`,
        guestSpoke <= 2,
        guestSpoke > 2 ? "插话判定太松，模型逢话头就接" : ""
      )
    );

    const quietTrace = quietLast?.done?.traceId ? getTrace(quietLast.done.traceId) : null;
    const reactSpans = (quietTrace?.spans || []).filter((s) => s.kind === "react");
    const reasonsLogged = reactSpans.length > 0 && reactSpans.every((s) => typeof s.detail?.reason === "string" && s.detail.reason.length > 0);
    cases.push(
      mk(
        "react_reason_logged",
        "每次插话判定都要留下理由（为什么说 / 为什么不说）",
        "react span 全部带非空 reason",
        `${reactSpans.length} 条 react span，理由齐全=${reasonsLogged}`,
        reasonsLogged
      )
    );

    const amb = await onceAmbient({ idleMs: 600000, force: true });
    totalCalls += amb.done?.budget?.calls || 0;
    beats += 1;
    const ambAgent = amb.done?.speaker || null;
    const ambActions = amb.events.filter((e) => e.type === "action" && e.actor === "regular").map((e) => e.name);
    const stageEv = amb.events.find((e) => e.type === "stage");
    cases.push(
      mk(
        "initiative_speaks",
        "玩家一直不说话时，客人主动找玩家开口",
        "regular 主动说出一段台词",
        `${ambAgent}｜${amb.text}`,
        amb.done?.initiated === true && ambAgent === "regular" && amb.text.trim().length > 1
      )
    );
    cases.push(
      mk(
        "initiative_stage",
        "主动开口时同时下发靠近事件（美术接口）",
        "stage/approach/near=true",
        stageEv ? `${stageEv.action}/${stageEv.near}/${stageEv.pose}` : "没有 stage 事件",
        Boolean(stageEv && stageEv.action === "approach" && stageEv.near === true && stageEv.pose)
      )
    );
    cases.push(
      mk(
        "initiative_no_tools",
        "客人主动开口时同样不越权调工具",
        "无工具调用",
        ambActions.length ? ambActions.join(",") : "无",
        ambActions.length === 0
      )
    );
    cases.push(
      mk(
        "initiative_budget",
        "主动搭话的调用数也在看门狗内",
        "<= limit",
        `${amb.done?.budget?.calls}/${amb.done?.budget?.limit}`,
        Boolean(amb.done?.budget) && amb.done.budget.calls <= amb.done.budget.limit
      )
    );

    const windowState = getAmbientState();
    const replyRoute = resolveSpeaker("嗯，今天确实有点累", null, { ambient: windowState });
    const orderRoute = resolveSpeaker("给我来杯尼格罗尼", null, { ambient: windowState });
    cases.push(
      mk(
        "initiative_reply_window",
        "客人主动开口后，玩家不点名的回话由他接住；点酒仍回到老板娘",
        "闲聊→regular，点酒→boss",
        `闲聊→${replyRoute}，点酒→${orderRoute}`,
        Boolean(windowState) && replyRoute === "regular" && orderRoute === "boss"
      )
    );

    const ambTrace = amb.done?.traceId ? getTrace(amb.done.traceId) : null;    const planSpan = (ambTrace?.spans || []).find((sp) => sp.kind === "initiative" && sp.name === "plan");
    cases.push(
      mk(
        "initiative_trace",
        "主动搭话单独成 trace，并记下这一拍想说什么",
        "trace.origin=ambient 且带 initiative 规划 span",
        `${ambTrace?.origin || "无"}｜${planSpan ? planSpan.detail?.goal || "已规划" : "没有规划 span"}`,
        ambTrace?.origin === "ambient" && Boolean(planSpan)
      )
    );

    const roster = createRoster();
    const regular = roster.find((c) => c.id === "regular");
    const fakeBus = { recentEvents: () => [], all: () => [] };
    const fakeTrace = { spans: [], actors: {}, _t0: Date.now() };
    const fakeBudget = { spend: () => true, addUsage: () => {}, get exhausted() { return false; } };
    let reactShape = false;
    try {
      const rr = await regular.react({ bus: fakeBus, trace: fakeTrace, budget: fakeBudget });
      reactShape = typeof rr?.speak === "boolean" && typeof rr?.urgency === "number";
    } catch {
      reactShape = false;
    }
    cases.push(mk("react_contract", "react() 返回 {speak, urgency, angle}", "类型正确", reactShape ? "正确" : "异常", reactShape));
  } finally {
    restoreThresholds();
  }

  const total = cases.length;
  const passed = cases.filter((c) => c.pass).length;
  return {
    key: KEY,
    label: LABEL,
    mode: "online",
    total,
    passed,
    failed: total - passed,
    accuracy: total ? Number((passed / total).toFixed(4)) : null,
    cases,
    detail: {
      平均每拍模型调用数: beats ? Number((totalCalls / beats).toFixed(2)) : 0,
      次要角色开口拍数: secondarySpoke,
      统计拍数: beats,
    },
  };
}

export const MULTIAGENT_SUITE = { key: KEY, label: LABEL, mode: "online" };
