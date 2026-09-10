import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = join(__dirname, "..", "memory.json");

function defaultProfile() {
  return {
    customerName: null,
    favoriteDrink: null,
    orderCount: 0,
    spent: 0,
    affinity: 0,
    mood: 0,
    customDrinks: [],
  };
}

export function loadProfile() {
  try {
    if (existsSync(PROFILE_PATH)) {
      const raw = JSON.parse(readFileSync(PROFILE_PATH, "utf8"));
      return { ...defaultProfile(), ...raw };
    }
  } catch {}
  return defaultProfile();
}

export function saveProfile(profile) {
  try {
    mkdirSync(__dirname, { recursive: true });
    writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), "utf8");
  } catch (e) {
    console.warn("[memory] 保存长期记忆失败：", e.message);
  }
}
