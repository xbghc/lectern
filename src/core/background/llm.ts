import { localStorage } from "../../sync/storage.ts";
import type { LlmConfig, LlmUsage } from "../../types.ts";
import { DEFAULT_LLM, EMPTY_USAGE, LEGACY_MINIMAX } from "../../types.ts";
import { serialize, updateLocalOnly } from "../../background/store.ts";

/**
 * 模型连接的配置与用量。文章判别、文章回顾、划词翻译共用一份，不属于任何一个功能。
 *
 * 写操作走 store.ts 那条串行队列——service worker 会并发处理多个标签页的消息。
 */

export const KEY_LLM = "llm";
export const KEY_USAGE = "llmUsage";

const local = (): chrome.storage.StorageArea => localStorage();

/**
 * 单独一个 key，**绝不并进 Settings**。
 * content script 启动时会把整个 settings 对象读进页面上下文，而 content script
 * 与网页共享同一个渲染进程——API key 出现在那里等于交给了页面上的任意脚本。
 */
export async function getLlmConfig(): Promise<LlmConfig> {
  const got = await local().get(KEY_LLM);
  const stored = (got[KEY_LLM] as StoredLlm) ?? {};
  // 多提供商之前存下的配置没有 provider 这个键。那时只有 MiniMax 一家，地址和模型名靠默认值补；
  // 现在的默认是「什么都没选」，所以这种旧配置要按当时的默认补，老用户升级后才不会突然停摆。
  // 那时也能手改 Base URL：改成了别家的，标签就不该还叫 MiniMax。
  const legacy = stored.provider === undefined && Object.keys(stored).length > 0;
  const merged = { ...DEFAULT_LLM, ...(legacy ? LEGACY_MINIMAX : {}), ...stored, ...raiseBudget(stored) };
  if (legacy && !/minimax/i.test(merged.baseUrl)) merged.provider = "custom";
  return merged;
}

type StoredLlm = Partial<LlmConfig> & {
  /** 一次性标记：输出上限与超时的默认值那次抬升已经跑过。 */
  budgetRaised?: boolean;
};

/** 抬升前的两个默认值。 */
const OLD_MAX_TOKENS = 1024;
const OLD_TIMEOUT_MS = 30_000;

/**
 * 把停在旧默认值上的输出上限与超时抬上来。
 *
 * 1024 是照着"只翻一句、没有讲解"定的，讲解上线后就显小了——实测 200 词的选区
 * 要 671 个输出 token，只剩三成余量。而 max_tokens 压低换不来省钱（见 LlmConfig 的说明），
 * 只换来截断，所以没有理由留着。超时一起抬：上限松了而超时没松，
 * 只是把"被截断"换成了"超时"。
 *
 * 和设置里那次阈值抬升同一套做法、同一份代价（当真手填过 1024 的人也会被抬这一次），
 * 见 store.ts 的 raiseAutoWords。这里不必像那边一样主动落盘：
 * LLM 配置只有 background 读，没有绕过这一层的读法。
 */
function raiseBudget(stored: StoredLlm): StoredLlm {
  if (stored.budgetRaised) return {};
  return {
    ...(stored.maxTokens === OLD_MAX_TOKENS ? { maxTokens: DEFAULT_LLM.maxTokens } : {}),
    ...(stored.timeoutMs === OLD_TIMEOUT_MS ? { timeoutMs: DEFAULT_LLM.timeoutMs } : {}),
    budgetRaised: true,
  };
}

const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return baseUrl.trim().toLowerCase();
  }
};

export async function setLlmConfig(patch: Partial<LlmConfig>): Promise<LlmConfig> {
  return serialize(async () => {
    const current = await getLlmConfig();
    const merged = { ...current, ...patch };
    // 换了服务地址而没给新密钥：存着的那把是上一家的，绝不能跟着发到新地址去。
    // 在这里清掉而不是只靠设置页拦——这条规矩不该取决于哪个界面记得检查。
    if (patch.baseUrl !== undefined && patch.apiKey === undefined && hostOf(patch.baseUrl) !== hostOf(current.baseUrl)) merged.apiKey = "";
    await local().set({ [KEY_LLM]: merged });
    return merged;
  });
}

export async function getUsage(): Promise<LlmUsage> {
  const got = await local().get(KEY_USAGE);
  return { ...EMPTY_USAGE, ...((got[KEY_USAGE] as Partial<LlmUsage>) ?? {}) };
}

/** 在一份用量上记一次调用。单拎出来是给 llmLog.ts 的 recordCall 用：用量和耗时一笔写完。 */
export function bumpUsage(stored: unknown, input: number, output: number, failed: boolean): LlmUsage {
  const u: LlmUsage = { ...EMPTY_USAGE, ...((stored as Partial<LlmUsage> | undefined) ?? {}) };
  return {
    requests: u.requests + 1,
    inputTokens: u.inputTokens + input,
    outputTokens: u.outputTokens + output,
    errors: u.errors + (failed ? 1 : 0),
    lastTs: Date.now(),
  };
}

export async function addUsage(input: number, output: number, failed = false): Promise<void> {
  await updateLocalOnly([KEY_USAGE], (v) => ({ [KEY_USAGE]: bumpUsage(v[KEY_USAGE], input, output, failed) }));
}
