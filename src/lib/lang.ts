import type { SnippetKind } from "../types.ts";
import { countWords } from "./wordcount.ts";

/**
 * 选区的语言学判定。
 *
 * 这些规则**只跑在客户端**，不问 LLM。原因是入队规则（词/短语进复习队列、
 * 整句只记录）依赖它，而模型偶尔会把一整句标成 "word"——那会让复习队列
 * 慢慢被长句淹没，正是用户明确不想要的。
 */

/** 连续空白（含换行）压成单空格。选区跨越换行时很常见。 */
export function normalizeSelection(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 拉丁字母检测；不能再用它单独决定是否翻译，文言文也需要释义。 */
export function hasLatin(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

/** 包含繁体及扩展区汉字，不靠简体字表猜测是否为文言文。 */
export function hasHan(text: string): boolean {
  return /\p{Script=Han}/u.test(text);
}

export function hasTranslatableText(text: string): boolean {
  return hasLatin(text) || hasHan(text);
}

/** 英文沿用空白分词；有汉字时按汉字数加其它词数，避免整段古文只算一词。 */
export function wordCountOf(text: string): number {
  const t = normalizeSelection(text);
  if (hasHan(t)) return countWords(t);
  return t ? t.split(" ").length : 0;
}

/**
 * 词数 → 粒度。
 * 1 词是词；2-4 词按短语（"give up on"、"in the wild" 这类值得背）；
 * 再长就是句子，只记录不排期。
 */
export function classifyKind(text: string): SnippetKind {
  // 无空格的古文不能按英文分词。单字可复习，其余保守地记为片段，
  // 不用字数猜词组，更不能把「学而时习之」这类短句自动塞进词汇卡。
  if (hasHan(text)) return /^\p{Script=Han}$/u.test(normalizeSelection(text)) ? "word" : "sentence";
  const n = wordCountOf(text);
  if (n <= 1) return "word";
  if (n <= 4) return "phrase";
  return "sentence";
}

export interface SelectionVerdict {
  ok: boolean;
  /** ok 为 false 时说明原因，浮层不弹或显示提示用。 */
  reason?: string;
  text: string;
  kind: SnippetKind;
  /** 英文词数 + 汉字数。判定与浮层文案共用一次计算。 */
  words: number;
  /** 超过自动阈值：弹浮层但不自动请求，由用户点按钮确认。 */
  needsConfirm: boolean;
}

export interface SelectionLimits {
  minSelectionChars: number;
  maxAutoSelectionWords: number;
}

/**
 * 硬上限：再长就完全不处理，跟设置无关。整页 Ctrl+A 不该发出去。
 *
 * 这条**必须**留成字符数，不能跟着自动阈值改成词数：`wordCountOf` 按空白切，
 * 一整块 URL / base64 / 压缩过的代码是"1 个词"，纯词数的闸拦不住它。
 */
export const HARD_MAX_CHARS = 2_000;

export function judgeSelection(raw: string, limits: SelectionLimits): SelectionVerdict {
  const text = normalizeSelection(raw);
  const kind = classifyKind(text);
  const words = wordCountOf(text);
  const base = { text, kind, words, needsConfirm: false };
  // 默认的两个字符防误触阈值适用于英文；一个汉字就可能是完整的文言词。
  // 用户显式设得更高时仍尊重该阈值。
  const minimum = hasHan(text) && limits.minSelectionChars <= 2 ? 1 : Math.max(1, limits.minSelectionChars);
  if ([...text].length < minimum) return { ...base, ok: false, reason: "The selection is too short" };
  if (text.length > HARD_MAX_CHARS) return { ...base, ok: false, reason: "The selection is too long" };
  if (!hasTranslatableText(text)) return { ...base, ok: false, reason: "No English or Chinese text found" };
  return { ...base, ok: true, needsConfirm: words > limits.maxAutoSelectionWords };
}

/**
 * 复习卡片的标识。
 * 同一个词在不同文章里被划到，应当合成一张卡（否则 leak / leaks / leaked
 * 会变成三张卡轮流来烦你），所以优先用 LLM 给的词元，没有就退回原文。
 */
export function cardKeyOf(text: string, lemma: string | null): string {
  return (lemma ?? text).toLowerCase().trim();
}
