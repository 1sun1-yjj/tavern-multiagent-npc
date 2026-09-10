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

    addressedTo(actorId) {
      return log.filter((m) => m.to === "all" || m.to === actorId);
    },

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
