// 所有角色共享的世界状态（黑板模式）。
// mutate 必须是同步的：中间不能有 await，否则两个角色可能读到同一份过期库存，
// 出现"两人各点走最后一瓶基酒"这种问题。
const state = {
  stock: { coffee: 3, milk: 5, sugar: 8, cup: 10 },
  cash: 0,
  servedToday: 0,
  clock: { turn: 0, phase: "夜晚" },
  present: ["boss", "regular"],
  relationships: {},
  customDrinks: [],
};

// 角色 id 和显示名分开：prompt 里写 "regular" 模型是看不懂的
const nameRegistry = new Map();

export function registerNames(entries) {
  for (const [id, name] of entries) nameRegistry.set(id, name);
}

export function displayName(id) {
  return nameRegistry.get(id) || id;
}

export function getWorld() {
  return state;
}

export function mutate(fn) {
  return fn(state);
}

export function snapshot() {
  return {
    stock: { ...state.stock },
    cash: state.cash,
    servedToday: state.servedToday,
    clock: { ...state.clock },
    present: [...state.present],
  };
}

export function presentActors() {
  return [...state.present];
}

export function enter(id) {
  if (!state.present.includes(id)) state.present.push(id);
  return state.present;
}

export function leave(id) {
  state.present = state.present.filter((x) => x !== id);
  return state.present;
}

export function tick() {
  state.clock.turn += 1;
  if (state.clock.turn % 6 === 0) {
    state.clock.phase = state.clock.phase === "夜晚" ? "深夜" : "夜晚";
  }
  return state.clock.turn;
}

export function adjustRelationship(actorId, delta) {
  const cur = state.relationships[actorId] || 0;
  state.relationships[actorId] = Math.max(-100, Math.min(100, cur + delta));
  return state.relationships[actorId];
}

export function resetWorld() {
  state.stock = { coffee: 3, milk: 5, sugar: 8, cup: 10 };
  state.cash = 0;
  state.servedToday = 0;
  state.clock = { turn: 0, phase: "夜晚" };
  state.present = ["boss", "regular"];
  state.relationships = {};
  state.customDrinks = [];
}
