/**
 * 模型调用层
 * ------------------------------------------------------------------
 * 相比初版，这一版补齐了观测层需要的基础设施：
 *   1. 回传 usage（prompt/completion token）——成本与用量的唯一来源
 *   2. 记录首字延迟 TTFT（time to first token）——流式体验的核心指标
 *   3. 流式请求开启 stream_options.include_usage，否则服务端不会回传用量
 *   4. 对 429 / 5xx 做指数退避重试——把偶发失败从"会话中断"降为"多等一会"
 */
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

const MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES || 2);
const RETRY_BASE_MS = Number(process.env.LLM_RETRY_BASE_MS || 400);

function getApiKey() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 DEEPSEEK_API_KEY。请复制 .env.example 为 .env 并填入你的 Key。");
  }
  return apiKey;
}

function modelName() {
  return process.env.DEEPSEEK_MODEL || "deepseek-chat";
}

function buildBody({ messages, tools, toolChoice, stream }) {
  const body = { model: modelName(), messages };
  if (stream) {
    body.stream = true;
    // ⚠️ 不加这一行，服务端不会在流末尾回传 usage，观测层的 token 统计会全部为 0
    body.stream_options = { include_usage: true };
  }
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || "auto";
  }
  return body;
}

function isRetryable(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body, apiKey) {
  return fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

/**
 * 非流式调用。返回结构统一为：
 * { content, tool_calls, usage, latencyMs, model, attempts }
 */
export async function chatWithModel({ messages, tools, toolChoice }) {
  const apiKey = getApiKey();
  const body = buildBody({ messages, tools, toolChoice, stream: false });

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const t0 = Date.now();
    try {
      const res = await post(body, apiKey);
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`DeepSeek 接口返回 ${res.status}：${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const msg = data.choices?.[0]?.message ?? {};
      return {
        content: msg.content ?? "",
        tool_calls: msg.tool_calls,
        usage: data.usage ?? null,
        latencyMs: Date.now() - t0,
        model: body.model,
        attempts: attempt + 1,
      };
    } catch (e) {
      lastErr = e;
      const retryable = !e.status || isRetryable(e.status);
      if (!retryable || attempt >= MAX_RETRIES) throw e;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
  throw lastErr;
}

/**
 * 流式调用。事件序列：
 *   { kind: "delta", text }
 *   { kind: "result", message, usage, ttftMs, headersMs, latencyMs, finishReason, model }
 *
 * 注意：result 在**流结束之后**才产出，因为 usage 是随最后一个数据块到达的，
 * 在 finish_reason 处提前产出会丢掉用量。
 */
export async function* chatStream({ messages, tools, toolChoice }) {
  const apiKey = getApiKey();
  const body = buildBody({ messages, tools, toolChoice, stream: true });

  const t0 = Date.now();
  const res = await post(body, apiKey);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek 接口返回 ${res.status}：${text.slice(0, 300)}`);
  }
  const headersMs = Date.now() - t0;

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let ttftMs = null;
  let usage = null;
  let finishReason = null;
  const toolMap = new Map();

  const markFirstOutput = () => {
    if (ttftMs === null) ttftMs = Date.now() - t0;
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }

      // ⚠️ usage 所在的块 choices 为空数组，必须先处理再判断 choice，
      //    否则会被下面的 continue 直接跳过（初版就是这么丢掉用量的）。
      if (data.usage) usage = data.usage;

      const choice = data.choices && data.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.content) {
        markFirstOutput();
        content += delta.content;
        yield { kind: "delta", text: delta.content };
      }

      if (delta.tool_calls) {
        markFirstOutput();
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur =
            toolMap.get(idx) || {
              id: "",
              type: "function",
              function: { name: "", arguments: "" },
            };
          if (tc.id) cur.id = tc.id;
          if (tc.function && tc.function.name) cur.function.name = cur.function.name || tc.function.name;
          if (tc.function && tc.function.arguments) cur.function.arguments += tc.function.arguments;
          toolMap.set(idx, cur);
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  const tool_calls = toolMap.size ? [...toolMap.values()] : undefined;
  yield {
    kind: "result",
    message: { role: "assistant", content, tool_calls },
    usage,
    ttftMs,
    headersMs,
    latencyMs: Date.now() - t0,
    finishReason,
    model: body.model,
  };
}
