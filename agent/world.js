const DEFAULT_STOCK = { 基酒: 3, 配料: 5, 装饰: 8, 冰杯: 10 };

const state = {
  stock: { ...DEFAULT_STOCK },
  cash: 0,
  servedToday: 0,
  clock: { turn: 0, phase: "夜晚" },
  present: ["boss", "regular"],
  relationships: {},
  customDrinks: [],
};

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
  state.stock = { ...DEFAULT_STOCK };
  state.cash = 0;
  state.servedToday = 0;
  state.clock = { turn: 0, phase: "夜晚" };
  state.present = ["boss", "regular"];
  state.relationships = {};
  state.customDrinks = [];
}
