import { sectionName } from "../options/nav.ts";

/** Keep the shared settings controls and handlers, but give the app a compact section index. */
export function setupSettingsLayout(): void {
  document.body.classList.add("mobile-settings");
  // App 使用自己的贴底进度线，扩展顶部情况条的开关在这里没有作用。
  const extensionProgress = document.getElementById("focusBarEnabled")?.closest<HTMLElement>(".field");
  if (extensionProgress) extensionProgress.hidden = true;
  document.querySelector(".settings-back")?.remove();
  const title = document.querySelector("h1");
  if (title) title.textContent = "Settings";
  const intro = title?.nextElementSibling;
  if (intro?.tagName === "P") {
    const privacy = document.createElement("details");
    privacy.className = "settings-privacy";
    const summary = document.createElement("summary");
    summary.textContent = "Data storage and privacy";
    intro.before(privacy);
    privacy.append(summary, intro);
  }
  const descriptions: Record<string, string> = {
    "Device sync": "Server connection, sync status and offline records",
    "Text translation": "Translation, text selection and word explanations",
    "Completion rules": "Choose when articles count as finished",
    "Resume reading": "Return to the paragraph you last read",
    "Article review": "Outlines and recall questions",
    "Focus timeouts": "Focus tracking and inactivity limits",
    "Paragraph progress": "Dwell time and reading thresholds",
    "Session rules": "Focus sessions and reading statistics",
    "Reading blocklist": "Skip tracking on these pages; translation remains available",
    "Translation allowlist": "Enable translation automatically on these sites",
    "Data": "Import, export and clear records",
    "Diagnostics": "Request timings, errors and interaction counts",
    "Updates": "App version and updates",
  };
  for (const fieldset of document.querySelectorAll<HTMLFieldSetElement>("body > fieldset")) {
    const legend = fieldset.querySelector("legend");
    const name = sectionName(fieldset) || "Settings";
    const section = document.createElement("details");
    section.className = "settings-section";
    const summary = document.createElement("summary");
    const heading = document.createElement("strong");
    const llm = !!fieldset.querySelector("#apiKey");
    heading.textContent = llm ? "Model connection" : name;
    const description = document.createElement("span");
    description.textContent = llm ? "API key, model and connection test" : descriptions[name] ?? "Reading and tracking preferences";
    summary.append(heading, description);
    fieldset.before(section);
    section.append(summary, fieldset);
    if (name === "Updates" && location.hash === "#update") {
      section.open = true;
      requestAnimationFrame(() => section.scrollIntoView({ block: "start" }));
    }
    if (name === "Device sync" && location.hash === "#sync") section.open = true;
    if (llm && location.hash === "#model") section.open = true;
    fieldset.setAttribute("aria-label", heading.textContent);
    // 扩展里收在标题旁「i」后面的说明：按钮跟着 legend 一起没了。这里换成分区开头的一行「这是什么」，
    // 点开才铺出来——手机上三段说明先占掉半屏，要填的那两个框就被挤到下面去了
    for (const about of fieldset.querySelectorAll<HTMLElement>(".info-pop")) {
      const fold = document.createElement("details");
      fold.className = "settings-about";
      const what = document.createElement("summary");
      what.textContent = "About this section";
      about.before(fold);
      about.hidden = false;
      about.className = "muted small";
      fold.append(what, about);
    }
    legend?.remove();
  }
  const save = document.getElementById("save");
  const actions = save?.parentElement;
  if (actions) {
    actions.classList.add("settings-savebar");
    document.body.append(actions);
  }
  const status = document.getElementById("status");
  status?.setAttribute("role", "status");
}
