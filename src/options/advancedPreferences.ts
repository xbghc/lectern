import type { LlmConfig, Settings } from "../types.ts";
import { MAX_AUTO_WORDS } from "../types.ts";

const readingKeys = ["idleTimeoutMs", "stallTimeoutMs", "maxQuietMs", "minSessionMs", "paragraphDwellMs", "readFraction", "episodeGapMs", "finishRatio", "restorePositionEnabled", "articleReviewEnabled", "focusBarEnabled"] as const;
const translationKeys = ["minSelectionChars", "maxAutoSelectionWords", "contextChars"] as const;
const modelKeys = ["maxTokens", "timeoutMs"] as const;
export type AdvancedReading = Pick<Settings, typeof readingKeys[number]>;
export type AdvancedTranslation = Pick<Settings, typeof translationKeys[number]>;
export type AdvancedModel = Pick<LlmConfig, typeof modelKeys[number]>;
export interface AdvancedPreferences { reading: AdvancedReading; translation: AdvancedTranslation; model: AdvancedModel }

const pick = <T, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> => Object.fromEntries(keys.map(key => [key, source[key]])) as Pick<T, K>;
export const advancedReading = (settings: Settings): AdvancedReading => pick(settings, readingKeys);
export const advancedTranslation = (settings: Settings): AdvancedTranslation => pick(settings, translationKeys);
export const advancedModel = (model: LlmConfig): AdvancedModel => pick(model, modelKeys);

export class AdvancedConfigError extends Error {
  readonly offset: number;
  constructor(text: string, path: string, message: string, offset?: number) {
    let found = 0, from = 0;
    for (const key of path.split(".").filter(Boolean)) {
      const token = JSON.stringify(key), next = text.indexOf(token, from);
      if (next < 0) break;
      found = next;
      from = next + token.length;
    }
    const at = offset ?? found;
    const lines = text.slice(0, at).split("\n");
    super(`${path || "JSON"}: ${message} (line ${lines.length}, column ${lines.at(-1)!.length + 1})`);
    this.name = "AdvancedConfigError";
    this.offset = at;
  }
}

/** Strict, allowlisted JSON: credentials, consent and legacy/internal keys never enter this editor. */
export function parseAdvancedPreferences(text: string): AdvancedPreferences {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    const position = /position (\d+)/i.exec(message)?.[1];
    const offset = position ? Number(position) : /end of JSON/i.test(message) ? text.length : 0;
    throw new AdvancedConfigError(text, "", "Invalid JSON. Check commas, quotes and brackets.", offset);
  }
  const fail = (path: string, message: string): never => { throw new AdvancedConfigError(text, path, message); };
  const object = (raw: unknown, path: string, keys: readonly string[]): Record<string, unknown> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(path, "Expected an object.");
    const record = raw as Record<string, unknown>;
    for (const key of Object.keys(record)) if (!keys.includes(key)) fail(path ? `${path}.${key}` : key, "Unknown setting.");
    for (const key of keys) if (!Object.hasOwn(record, key)) fail(path ? `${path}.${key}` : key, "Required setting is missing.");
    return record;
  };
  const root = object(value, "", ["reading", "translation", "model"]);
  const reading = object(root.reading, "reading", readingKeys);
  const translation = object(root.translation, "translation", translationKeys);
  const model = object(root.model, "model", modelKeys);
  const number = (group: Record<string, unknown>, prefix: string, key: string, min: number, max: number, integer = true): void => {
    const n = group[key];
    if (typeof n !== "number" || !Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
      fail(`${prefix}.${key}`, `Expected ${integer ? "an integer" : "a number"} from ${min} to ${max}.`);
    }
  };
  for (const [key, min, max] of [
    ["idleTimeoutMs", 5_000, 600_000], ["stallTimeoutMs", 10_000, 1_800_000], ["maxQuietMs", 0, 1_800_000],
    ["minSessionMs", 0, 120_000], ["paragraphDwellMs", 100, 10_000], ["episodeGapMs", 0, 7_200_000],
  ] as const) number(reading, "reading", key, min, max);
  number(reading, "reading", "readFraction", .1, 1, false);
  number(reading, "reading", "finishRatio", .1, 1, false);
  for (const key of ["restorePositionEnabled", "articleReviewEnabled", "focusBarEnabled"]) {
    if (typeof reading[key] !== "boolean") fail(`reading.${key}`, "Expected true or false.");
  }
  if ((reading.stallTimeoutMs as number) <= (reading.idleTimeoutMs as number)) fail("reading.stallTimeoutMs", "Must be greater than reading.idleTimeoutMs.");
  number(translation, "translation", "minSelectionChars", 1, 20);
  number(translation, "translation", "maxAutoSelectionWords", 3, MAX_AUTO_WORDS);
  number(translation, "translation", "contextChars", 0, 2_000);
  number(model, "model", "maxTokens", 256, 8_192);
  number(model, "model", "timeoutMs", 5_000, 120_000);
  return { reading, translation, model } as unknown as AdvancedPreferences;
}
