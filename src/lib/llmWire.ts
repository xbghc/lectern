import type { LlmConfig, LlmProtocol } from "../types.ts";

/**
 * 两套协议在线上长什么样：地址、请求头、请求体，以及怎么从响应和流里把文字、用量、结束原因读出来。
 *
 * 这里全是纯函数，不发请求也不抛错——超时、重试、把问题翻成带 kind 的 LlmError 都是 llm.ts 的事。
 * 两套都是原生直连：选哪一家就用哪一家自己的格式发到它自己的地址，中间不把一种协议转成另一种。
 *
 * - `anthropic`：Messages 接口。MiniMax 的 Anthropic 兼容端点多一个自己的 `base_resp`，也在这条路上读。
 * - `openai`：Chat Completions 接口。各家「OpenAI 兼容」端点实现的都是它（而不是 OpenAI 更新的 Responses 接口，
 *   那个几乎没有第三方支持）。
 */

type Wired = Pick<LlmConfig, "protocol" | "baseUrl" | "apiKey" | "model" | "maxTokens">;

const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/**
 * 请求发到哪儿。baseUrl 按提供商清单的写法带着版本段（`https://api.openai.com/v1`），后面接上接口名。
 * Anthropic 那一路多认一种写法：不带 `/v1` 的（`https://api.minimaxi.com/anthropic`）——
 * 多提供商之前存下的配置都是这样，那时的代码自己补 `/v1/messages`。
 */
export function endpoint(config: Pick<LlmConfig, "protocol" | "baseUrl">): string {
  const base = config.baseUrl.trim().replace(/\/+$/, "");
  if (config.protocol === "openai") return `${base}/chat/completions`;
  return /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

export function requestHeaders(config: Pick<LlmConfig, "protocol" | "baseUrl" | "apiKey">): Record<string, string> {
  if (config.protocol === "openai") return { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` };
  return {
    "content-type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01",
    // Anthropic 官方接口看到带 Origin 的请求（扩展后台发出去的就带）而没有这个头会直接拒掉。
    // 只对它自己的域名加：别家的兼容端点不认识这个头，没必要多送。
    ...(/(^|\.)anthropic\.com$/.test(hostOf(config.baseUrl)) ? { "anthropic-dangerous-direct-browser-access": "true" } : {}),
  };
}

export function requestBody(config: Wired, system: string, userText: string, stream: boolean): Record<string, unknown> {
  if (config.protocol === "openai") {
    return {
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
      // OpenAI 自己的新模型只认 max_completion_tokens（max_tokens 已弃用，推理模型直接报错）；
      // 兼容端点大多只认 max_tokens。按域名分，不按模型名猜。
      [hostOf(config.baseUrl) === "api.openai.com" ? "max_completion_tokens" : "max_tokens"]: config.maxTokens,
      // 流式默认不报用量，要显式要；报在 [DONE] 之前单独的一块里
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }
  return {
    model: config.model,
    max_tokens: config.maxTokens,
    system,
    messages: [{ role: "user", content: userText }],
    ...(stream ? { stream: true } : {}),
  };
}

/** 输出是不是被长度上限掐断的。两家叫法不同：Anthropic 是 `max_tokens`，OpenAI 是 `length`。 */
export const isTruncated = (protocol: LlmProtocol, stopReason: string): boolean =>
  stopReason === (protocol === "openai" ? "length" : "max_tokens");

/** MiniMax 在 HTTP 200 里报的业务错误（余额不足、鉴权失败、内容审核）。 */
export interface BaseRespFailure {
  code: number;
  message: string | undefined;
}

/** 一次非流式响应里读出来的东西。出了问题的几种情况各占一个字段，由 llm.ts 决定怎么报。 */
export interface WireReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  baseResp?: BaseRespFailure;
  /** HTTP 200 的响应体里带着的错误（有的中转站这么干）。 */
  error?: string;
  /** 服务商按内容拒答。 */
  refusal?: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (typeof v === "object" && v !== null ? (v as Obj) : undefined);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function baseResp(v: unknown): BaseRespFailure | undefined {
  const br = obj(v);
  if (!br || typeof br.status_code !== "number" || br.status_code === 0) return undefined;
  return { code: br.status_code, message: typeof br.status_msg === "string" ? br.status_msg : undefined };
}

/** OpenAI 的 content 多数时候是字符串，少数实现给的是分块数组。 */
function openaiText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => str(obj(part)?.text)).join("");
}

const errorMessage = (v: unknown): string | undefined => {
  const e = obj(v);
  if (!e) return typeof v === "string" && v ? v : undefined;
  return str(e.message) || str(e.type) || str(e.code) || "未知";
};

export function readReply(protocol: LlmProtocol, data: Obj): WireReply {
  if (protocol === "openai") {
    const choice = obj((Array.isArray(data.choices) ? data.choices : [])[0]);
    const message = obj(choice?.message);
    const usage = obj(data.usage);
    const stopReason = str(choice?.finish_reason);
    const refusal = str(message?.refusal) || (stopReason === "content_filter" ? "content_filter" : "");
    return {
      text: openaiText(message?.content),
      inputTokens: num(usage?.prompt_tokens),
      outputTokens: num(usage?.completion_tokens),
      stopReason,
      ...(data.error !== undefined && !choice ? { error: errorMessage(data.error) ?? "未知" } : {}),
      ...(refusal ? { refusal } : {}),
    };
  }
  const usage = obj(data.usage);
  const failure = baseResp(data.base_resp);
  return {
    text: (Array.isArray(data.content) ? data.content : [])
      .map((b) => obj(b))
      .filter((b): b is Obj => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join(""),
    inputTokens: num(usage?.input_tokens),
    outputTokens: num(usage?.output_tokens),
    stopReason: str(data.stop_reason),
    ...(failure ? { baseResp: failure } : {}),
  };
}

/** 流里的一个事件带来了什么。没带来的字段就不出现，调用方只管把出现的累上去。 */
export interface WireStep {
  /** 新到的一段文字（增量，不是全文）。 */
  delta?: string;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  /** Anthropic 的 message_stop：流正常收尾的标志，进诊断日志。 */
  messageStop?: true;
  baseResp?: BaseRespFailure;
  error?: string;
  refusal?: string;
}

export function readEvent(protocol: LlmProtocol, ev: Obj): WireStep {
  if (protocol === "openai") {
    if (ev.error !== undefined) return { error: errorMessage(ev.error) ?? "未知" };
    const step: WireStep = {};
    const choice = obj((Array.isArray(ev.choices) ? ev.choices : [])[0]);
    const delta = obj(choice?.delta);
    // 推理模型另有 reasoning_content，那是思考过程，不是答案，不取
    if (typeof delta?.content === "string" && delta.content) step.delta = delta.content;
    if (typeof delta?.refusal === "string" && delta.refusal) step.refusal = delta.refusal;
    const finish = str(choice?.finish_reason);
    if (finish) {
      step.stopReason = finish;
      if (finish === "content_filter") step.refusal ??= "content_filter";
    }
    // 用量在收尾那一块里（choices 是空数组）；有的实现每块都带，取最后一次的
    const usage = obj(ev.usage);
    if (usage) {
      if (typeof usage.prompt_tokens === "number") step.inputTokens = usage.prompt_tokens;
      if (typeof usage.completion_tokens === "number") step.outputTokens = usage.completion_tokens;
    }
    return step;
  }
  switch (ev.type) {
    case "message_stop":
      return { messageStop: true };
    case "message_start": {
      const m = obj(ev.message);
      // MiniMax 会在 HTTP 200 的流里用 base_resp 报业务错误（余额不足、鉴权失败）
      const failure = baseResp(m?.base_resp);
      if (failure) return { baseResp: failure };
      return { inputTokens: num(obj(m?.usage)?.input_tokens) };
    }
    case "content_block_delta": {
      const d = obj(ev.delta);
      return d?.type === "text_delta" && typeof d.text === "string" ? { delta: d.text } : {};
    }
    case "message_delta": {
      const step: WireStep = {};
      const stop = str(obj(ev.delta)?.stop_reason);
      if (stop) step.stopReason = stop;
      const u = obj(ev.usage);
      if (typeof u?.output_tokens === "number") step.outputTokens = u.output_tokens;
      // Anthropic 只在 message_start 报 input_tokens，MiniMax 那里恒为 0，
      // 真实值在收尾的 message_delta 里。两处都取，谁非零算谁。
      if (typeof u?.input_tokens === "number" && u.input_tokens) step.inputTokens = u.input_tokens;
      return step;
    }
    case "error": {
      const e = obj(ev.error);
      return { error: str(e?.message) || str(e?.type) || "未知" };
    }
    default:
      return {};
  }
}
