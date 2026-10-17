/** 模型地址的唯一解析入口：保存、设置页和发请求必须遵守同一条规则。 */
export function parseLlmBaseUrl(value: string): URL {
  const text = typeof value === "string" ? value.trim() : "";
  // 不接受 URL() 会自动修正的缺斜杠、反斜杠或夹带控制字符的写法。
  if (!/^https?:\/\/[^/\s\\]/i.test(text) || /[\s\\]/.test(text)) {
    throw new Error("Base URL 要是完整的 http(s) 地址，不能包含空白或反斜杠。");
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Base URL 不是有效的地址。");
  }
  if (url.username || url.password || /[?#]/.test(text)) {
    throw new Error("Base URL 不能包含凭证、查询参数或片段。");
  }
  // 沿用同步服务的回环例外，保留清单里的本地模型；不放行局域网、公网或 .localhost 子域。
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("模型服务需要 HTTPS；仅本机 localhost、127.0.0.1 或 [::1] 可使用 HTTP。");
  }
  return url;
}

export const normalizeLlmBaseUrl = (value: string): string => parseLlmBaseUrl(value).href.replace(/\/+$/, "");

/** origin 包含协议和有效端口；无效或未配置的地址绝不能通过字符串回退碰巧相等。 */
export function sameLlmOrigin(left: string, right: string): boolean {
  try {
    return parseLlmBaseUrl(left).origin === parseLlmBaseUrl(right).origin;
  } catch {
    return false;
  }
}
