import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_NS = "default";

// 每个角色一份独立的画像文件，互不污染。
// 默认命名空间仍然落在 memory.json，保持对旧数据的兼容。
function profilePath(ns) {
  return ns === DEFAULT_NS
    ? join(__dirname, "..", "memory.json")
    : join(__dirname, "..", `memory.${ns}.json`);
}

function defaultProfile() {
  return {
    customerName: null,
    favoriteDrink: null,
    orderCount: 0,
    spent: 0,
    affinity: 0,
    mood: 0,
    customDrinks: [],
    knownFaces: [],
  };
}

export function loadProfile(ns = DEFAULT_NS) {
  try {
    const p = profilePath(ns);
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      return { ...defaultProfile(), ...raw };
    }
  } catch {}
  return defaultProfile();
}

export function saveProfile(profile, ns = DEFAULT_NS) {
  try {
    mkdirSync(__dirname, { recursive: true });
    writeFileSync(profilePath(ns), JSON.stringify(profile, null, 2), "utf8");
  } catch (e) {
    console.warn("[memory] 保存长期记忆失败：", e.message);
  }
}

export const DEFAULT_NAMESPACE = DEFAULT_NS;
