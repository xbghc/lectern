import { enableAdvancedPreferences } from "./form.ts";

/** Keep shared handlers intact while making uncommon preferences JSON-only in the extension. */
export function setupExtensionLayout(): void {
  document.body.classList.add("extension-settings");
  const get = (id: string): HTMLElement => document.getElementById(id)!;
  const title = document.querySelector("h1");
  if (title) title.textContent = "Settings";
  if (title?.nextElementSibling?.tagName === "P") title.nextElementSibling.remove();

  const advanced = enableAdvancedPreferences();
  for (const id of ["sec-finish", "sec-position", "sec-review", "sec-attention", "sec-paragraph", "sec-stats", "sec-rule-chat"]) get(id).remove();
  for (const id of ["minSel", "maxAuto", "ctxChars", "maxTokens", "timeout"]) get(id).closest(".field")?.remove();
  get("sec-translate").querySelector(":scope > p")?.remove();
  for (const input of get("sec-translate").querySelectorAll<HTMLInputElement>("input[type=checkbox]")) input.style.removeProperty("width");
  get("sec-llm").querySelector(":scope > p")?.remove();
  get("model-advanced").querySelector("summary")!.textContent = "Endpoint";

  const sites = document.createElement("fieldset"); sites.id = "sec-sites";
  const sitesLegend = document.createElement("legend"); sitesLegend.textContent = "Sites";
  const siteFields = document.createElement("div"); siteFields.className = "site-rules-grid";
  for (const [id, label] of [["sec-article-blacklist", "Reading blocklist"], ["sec-translation-allowlist", "Translation allowlist"]]) {
    const fieldset = get(id!);
    const input = fieldset.querySelector("textarea")!;
    input.setAttribute("aria-label", label!);
    siteFields.append(fieldset);
  }
  sites.append(sitesLegend, siteFields);
  get("sec-translate").after(sites, advanced);

  const maintenance = document.createElement("fieldset"); maintenance.id = "sec-maintenance"; maintenance.dataset.navGroup = "Maintenance";
  const legend = document.createElement("legend"); legend.textContent = "Maintenance"; maintenance.append(legend);
  for (const [id, label] of [["sec-data", "Data"], ["sec-log", "Diagnostics"]]) {
    const section = get(id!);
    const fold = document.createElement("details"); fold.className = "maintenance-section";
    const summary = document.createElement("summary"); summary.textContent = label!;
    section.querySelector("legend")?.remove();
    section.setAttribute("aria-label", label!);
    fold.append(summary, section); maintenance.append(fold);
  }
  const reset = get("reset");
  reset.textContent = "Reset preferences";
  reset.title = "Restore reading defaults while keeping your connections and data. Save to apply, or discard to cancel.";
  reset.classList.add("extension-reset");
  get("sec-reset").remove();
  document.body.append(maintenance, reset, get("savebar"));

  // Model setup is the usual first step; sync keeps a separate connection save flow.
  get("sync-settings").before(get("sec-llm"));
  get("sec-llm").dataset.navGroup = "Connections";
  delete get("sync-settings").dataset.navGroup;
}
