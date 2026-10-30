import type { LlmConfig, Settings } from "../types.ts";
import { AdvancedConfigError, advancedModel, advancedReading, advancedTranslation, parseAdvancedPreferences, type AdvancedPreferences } from "./advancedPreferences.ts";

export class AdvancedPreferencesEditor {
  readonly section: HTMLFieldSetElement;
  readonly input: HTMLTextAreaElement;
  private readonly disclosure: HTMLDetailsElement;
  private readonly message: HTMLParagraphElement;
  private readonly format: HTMLButtonElement;
  private current: Partial<AdvancedPreferences> = {};
  private initialized = false;
  private busy = false;
  error: AdvancedConfigError | null = null;
  get ready(): boolean { return this.initialized; }

  constructor(onChange: () => void) {
    this.section = document.createElement("fieldset");
    this.section.id = "sec-advanced";
    this.section.dataset.nav = "Advanced JSON";
    const legend = document.createElement("legend"); legend.textContent = "Advanced JSON";
    this.disclosure = document.createElement("details"); this.disclosure.className = "advanced-editor";
    const summary = document.createElement("summary"); summary.textContent = "Edit reading rules, translation limits and model budgets";
    const hint = document.createElement("p"); hint.className = "muted small"; hint.id = "advanced-json-hint";
    hint.textContent = "Edit the shown keys. Times use milliseconds; reading ratios use 0–1. Save applies these values together with your preferences.";
    this.input = document.createElement("textarea"); this.input.id = "advanced-json"; this.input.spellcheck = false;
    this.input.setAttribute("aria-label", "Advanced preferences JSON");
    this.input.setAttribute("aria-describedby", "advanced-json-hint advanced-json-error");
    this.input.autocomplete = "off"; this.input.disabled = true;
    this.message = document.createElement("p"); this.message.id = "advanced-json-error"; this.message.className = "small error";
    this.message.setAttribute("role", "alert"); this.message.hidden = true;
    this.format = document.createElement("button"); this.format.type = "button"; this.format.textContent = "Format JSON"; this.format.disabled = true;
    this.format.addEventListener("click", () => {
      if (!this.validate(true)) return;
      this.input.value = JSON.stringify(this.current, null, 2);
      onChange();
    });
    this.input.addEventListener("input", () => { this.validate(); onChange(); });
    this.disclosure.append(summary, hint, this.input, this.message, this.format);
    this.section.append(legend, this.disclosure);
  }

  private write(): void {
    if (!this.current.reading || !this.current.translation || !this.current.model) return;
    this.initialized = true;
    this.input.value = JSON.stringify({ reading: this.current.reading, translation: this.current.translation, model: this.current.model }, null, 2);
    this.validate();
    this.setBusy(this.busy);
  }

  setSettings(settings: Settings): void {
    this.current.reading = advancedReading(settings);
    this.current.translation = advancedTranslation(settings);
    this.write();
  }
  setModel(model: LlmConfig): void { this.current.model = advancedModel(model); this.write(); }
  settings(): Partial<Settings> { return { ...this.current.reading, ...this.current.translation }; }
  model(): Partial<LlmConfig> { return { ...this.current.model }; }

  validate(focus = false): boolean {
    if (!this.initialized) return false;
    try {
      this.current = parseAdvancedPreferences(this.input.value);
      this.error = null;
      this.input.removeAttribute("aria-invalid");
      this.input.setCustomValidity("");
      this.message.hidden = true;
      this.message.textContent = "";
      return true;
    } catch (error) {
      this.error = error instanceof AdvancedConfigError ? error : new AdvancedConfigError(this.input.value, "", "Invalid configuration.");
      this.input.setAttribute("aria-invalid", "true");
      this.input.setCustomValidity(this.error.message);
      this.message.textContent = this.error.message;
      this.message.hidden = false;
      if (focus) {
        this.disclosure.open = true;
        this.input.focus();
        this.input.setSelectionRange(this.error.offset, this.error.offset);
      }
      return false;
    }
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.input.disabled = busy || !this.initialized;
    this.format.disabled = busy || !this.initialized;
  }
}
