// 角色之间的通信总线。消息是类型化的，不是自由文本——
// 让 agent 互相自由聊天会导致成本失控且不可复现。
export function createBus() {
  const log = [];
  const t0 = Date.now();

  return {
    publish(msg) {
      const entry = {
        seq: log.length,
        atMs: Date.now() - t0,
        beat: msg.beat ?? null,
        from: msg.from,
        to: msg.to || "all",
        type: msg.type,
        payload: msg.payload || {},
      };
      log.push(entry);
      return entry;
    },

    all() {
      return log;
    },

    since(seq) {
      return log.filter((m) => m.seq > seq);
    },

    // 某角色能看到的消息：广播的，或点名给自己的
    addressedTo(actorId) {
      return log.filter((m) => m.to === "all" || m.to === actorId);
    },

    // 只保留 say / act 这类"场面上发生的事"，喂给便宜判定用
    recentEvents(n = 3) {
      return log
        .filter((m) => m.type === "say" || m.type === "act" || m.type === "beat")
        .slice(-n);
    },

    length() {
      return log.length;
    },
  };
}

export function formatEvent(m) {
  if (m.type === "say") return `${m.payload.speaker || m.from}：${m.payload.text || ""}`;
  if (m.type === "act") return `（${m.from} 做了 ${m.payload.tool}：${m.payload.summary || ""}）`;
  if (m.type === "beat") return `【导演】本拍目标：${m.payload.goal} → 交给 ${m.payload.assignee}`;
  if (m.type === "decline") return `（${m.from} 拒绝了导演的目标：${m.payload.reason}）`;
  if (m.type === "state") return `（世界状态变化：${JSON.stringify(m.payload)}）`;
  return `${m.from}/${m.type}`;
}
