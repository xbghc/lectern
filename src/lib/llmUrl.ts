/** 模型地址的唯一解析入口：保存、设置页和发请求必须遵守同一条规则。 */
export function parseLlmBaseUrl(value: string): URL {
  const text = typeof value === "string" ? value.trim() : "";
  // 不接受 URL() 会自动修正的缺斜杠、反斜杠或夹带控制字符的写法。
  if (!/^https?:\/\/[^/\s\\]/i.test(text) || /[\s\\]/.test(text)) {
    throw new Error("The base URL must be a complete HTTP(S) URL without whitespace or backslashes.");
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Enter a valid base URL.");
  }
  if (url.username || url.password || /[?#]/.test(text)) {
    throw new Error("The base URL must not contain credentials, a query or a fragment.");
  }
  // 沿用同步服务的回环例外，保留清单里的本地模型；不放行局域网、公网或 .localhost 子域。
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Model services require HTTPS. HTTP is allowed only for localhost, 127.0.0.1 or [::1].");
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
