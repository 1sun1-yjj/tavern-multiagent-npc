import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { embedTexts } from "./embed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, "..", "vectorstore.json");
const MAX_MEMORIES = 200;
const DEFAULT_TOP_K = 4;
const DEFAULT_THRESHOLD = 0.25;
const PUBLIC_OWNER = "public";

let memories = load();

function load() {
  try {
    if (existsSync(STORE_PATH)) return JSON.parse(readFileSync(STORE_PATH, "utf8"));
  } catch {}
  return [];
}

function save() {
  try {
    writeFileSync(STORE_PATH, JSON.stringify(memories), "utf8");
  } catch (e) {
    console.warn("[vectorstore] 保存失败：", e.message);
  }
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// 纯函数，不带 owner 过滤——过滤放在 searchMemory 里做，
// 这样排序逻辑本身可以不联网单测。
export function rankMemories(entries, qvec, { k = DEFAULT_TOP_K, threshold = DEFAULT_THRESHOLD } = {}) {
  if (!Array.isArray(entries) || !qvec) return [];
  return entries
    .filter((m) => m && Array.isArray(m.vec))
    .map((m) => ({ text: m.text, sim: cosine(m.vec, qvec) }))
    .filter((m) => m.sim > threshold)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k);
}

// owner 为空的历史数据视为公共记忆
function ownedBy(entry, owner) {
  if (!owner) return true;
  const o = entry.owner || PUBLIC_OWNER;
  return o === owner || o === PUBLIC_OWNER;
}

export async function addMemory(text, meta = {}, owner = PUBLIC_OWNER) {
  try {
    const [vec] = await embedTexts([text]);
    if (!vec) return;
    memories.push({
      id: Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
      text, meta, owner, vec,
    });
    if (memories.length > MAX_MEMORIES) memories.splice(0, memories.length - MAX_MEMORIES);
    save();
  } catch (e) {
    console.warn("[vectorstore] 存记忆失败（已跳过）：", e.message);
  }
}

export async function searchMemory(query, k = DEFAULT_TOP_K, owner = null) {
  try {
    const [qvec] = await embedTexts([query]);
    if (!qvec) return [];
    const pool = owner ? memories.filter((m) => ownedBy(m, owner)) : memories;
    return rankMemories(pool, qvec, { k }).map((m) => m.text);
  } catch {
    return [];
  }
}

export async function searchMemoryDetailed(query, k = DEFAULT_TOP_K, owner = null) {
  try {
    const [qvec] = await embedTexts([query]);
    if (!qvec) return [];
    const pool = owner ? memories.filter((m) => ownedBy(m, owner)) : memories;
    return rankMemories(pool, qvec, { k });
  } catch {
    return [];
  }
}

export function listMemory(owner = null) {
  const pool = owner ? memories.filter((m) => ownedBy(m, owner)) : memories;
  return pool.map((m) => m.text);
}

export function memoryCount() {
  return memories.length;
}

export function _setMemoriesForTest(entries) {
  memories = entries;
}

export const MEMORY_LIMITS = { MAX_MEMORIES, DEFAULT_TOP_K, DEFAULT_THRESHOLD };
export const PUBLIC = PUBLIC_OWNER;
