/**
 * 向量记忆（语义检索）
 * ------------------------------------------------------------------
 * 把「值得长期记住的往事」编码成向量存下来，按余弦相似度召回 top-k。
 *
 * 设计取舍：
 *   - 零依赖：自己算余弦，不引向量数据库。记忆规模上限 200 条，
 *     暴力全量比对（200 次点积）在微秒级，引入 Milvus/Chroma 属于过度设计。
 *   - 阈值 0.25：低于阈值的召回结果噪声极大，宁可不召回也不要污染 prompt。
 *     这一条在 eval/run.js 的 retrieval 套件里有专门的边界测试。
 *   - 排序逻辑抽成纯函数 rankMemories()，可以不联网、不打 embedding 直接单测。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { embedTexts } from "./embed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, "..", "vectorstore.json");
const MAX_MEMORIES = 200;
const DEFAULT_TOP_K = 4;
const DEFAULT_THRESHOLD = 0.25;

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

/** 余弦相似度。维度不一致时返回 0，避免静默算出错误结果。 */
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

/**
 * 纯函数：给定记忆条目与查询向量，返回排序后的命中列表。
 * 抽出来是为了可离线单测（不需要 embedding 服务）。
 */
export function rankMemories(entries, qvec, { k = DEFAULT_TOP_K, threshold = DEFAULT_THRESHOLD } = {}) {
  if (!Array.isArray(entries) || !qvec) return [];
  return entries
    .filter((m) => m && Array.isArray(m.vec))
    .map((m) => ({ text: m.text, sim: cosine(m.vec, qvec) }))
    .filter((m) => m.sim > threshold)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k);
}

export async function addMemory(text, meta = {}) {
  try {
    const [vec] = await embedTexts([text]);
    if (!vec) return;
    memories.push({
      id: Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
      text, meta, vec,
    });
    if (memories.length > MAX_MEMORIES) memories.splice(0, memories.length - MAX_MEMORIES);
    save();
  } catch (e) {
    console.warn("[vectorstore] 存记忆失败（已跳过）：", e.message);
  }
}

export async function searchMemory(query, k = DEFAULT_TOP_K) {
  try {
    const [qvec] = await embedTexts([query]);
    if (!qvec) return [];
    return rankMemories(memories, qvec, { k }).map((m) => m.text);
  } catch {
    return [];
  }
}

/** 带相似度明细的检索，供观测台与评测使用 */
export async function searchMemoryDetailed(query, k = DEFAULT_TOP_K) {
  try {
    const [qvec] = await embedTexts([query]);
    if (!qvec) return [];
    return rankMemories(memories, qvec, { k });
  } catch {
    return [];
  }
}

export function listMemory() {
  return memories.map((m) => m.text);
}

export function memoryCount() {
  return memories.length;
}

/** 供评测使用：临时注入/清空记忆，不影响落盘文件 */
export function _setMemoriesForTest(entries) {
  memories = entries;
}

export const MEMORY_LIMITS = { MAX_MEMORIES, DEFAULT_TOP_K, DEFAULT_THRESHOLD };
