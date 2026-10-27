# Chrome Web Store

[Public listing](https://chromewebstore.google.com/detail/fpplijdeabekpbadojohidampfnjhcdf), extension ID `fpplijdeabekpbadojohidampfnjhcdf`.

This file is the source copy for the developer dashboard. Update the dashboard when permissions, data flows, features or screenshots change. Listing fields may change over time; use the current dashboard labels. The project interface and listing copy are English; AI explanations can still be Chinese.

## Listing checklist

1. Open the [developer dashboard](https://chrome.google.com/webstore/devconsole) with the publisher account and verify its contact details.
2. Upload the release artifact `lectern-extension-vX.Y.Z.zip`.
3. Use English as the listing language and the copy below. Use `src/icons/icon128.png` and the five 1280×800 screenshots under `docs/store/`.
4. Set the privacy policy to `https://xbghc.github.io/lectern/privacy/` and review the disclosures below.
5. Choose the intended visibility and regions, then submit for review. Uploading and submitting do not make a release publicly available until review completes.

Store and unpacked extension IDs differ, so local data does not transfer automatically. Use device sync or export/import before switching installations.

## Listing copy

Category: Productivity / Tools, where available.

**Name:** Lectern — Reading Companion

**Short description:** Track reading progress, translate selected text with your own AI provider, and review vocabulary with spaced repetition.

**Detailed description:**

```text
Lectern brings your reading tools together in a calm workspace.

• Reading progress: identify article pages, track focus time and paragraphs read, and return to where you stopped.
• Context-aware translation: select English text for a translation, usage notes and explanations of unfamiliar words.
• Screenshot translation: select text in an image; text recognition runs locally before the recognized text is translated.
• Spaced review: turn looked-up words into vocabulary cards scheduled with FSRS.
• Vocabulary practice: use words you have read in explanations, sentence practice and short AI conversations.
• Optional device sync: connect to a server you operate or trust to merge records across computers and the Android app.

Before you start:
• Bring your own model-provider API key. Choose a provider, model and key in Settings; OpenAI-compatible Chat Completions and Anthropic-compatible Messages are supported. A model connection is required for article detection and translation.
• Read the content-sharing notice and choose “Agree and start.” After consent and setup, opened pages' URLs, titles and text are automatically sent directly to your chosen provider to identify articles. Exclude sites with the Reading blocklist.
• Translation sends selected text and its context. Other AI features send the material involved in the requested action. Automatic article review, when enabled, also sends article text at the reading threshold.
• Sync is optional and off by default. Enabling it sends records, diagnostic logs and daily button counts to your configured server. Model API keys stay on your device.
• The interface is English. AI translations, explanations, reviews and vocabulary coaching can still use Chinese.

Source and documentation: https://github.com/xbghc/lectern
Privacy policy: https://xbghc.github.io/lectern/privacy/
```

## Privacy disclosures

**Single purpose:** Assist reading by tracking article progress, translating and explaining selected text, and reviewing vocabulary in its original context.

Permission justifications:

| Permission | Purpose |
| --- | --- |
| `storage` | Save settings, reading records, vocabulary and review schedules locally. |
| `unlimitedStorage` | Retain reading history and saved article resources without the standard extension storage quota. |
| `alarms` | Schedule background maintenance and sync. |
| `sidePanel` | Display vocabulary from the current article. |
| `tabs` | Identify the active article and coordinate its popup/side panel. |
| `offscreen` | Run bundled local OCR outside the visible page. |
| `contextMenus` | Provide article/translation actions from the browser menu. |
| `activeTab` | Capture a screenshot only after an explicit user action. |
| `http://*/*`, `https://*/*` | Run reading features on user-visited sites, fetch article resources and call the configured model/sync endpoints. |

Disclose website content, browsing activity and user-provided content according to the actual implementation. Page URLs, titles and text are sent for article detection only after consent and model setup. Selected text, its paragraph and related material are sent for requested AI features. OCR screenshots stay local. Reading records, diagnostic content and usage counts go to the configured server only when sync is enabled. API keys remain local and are excluded from record exports. There is no third-party advertising or analytics integration.

Keep the settings consent notice, this listing and `site/privacy/index.html` consistent. Do not claim all data always stays local or that a configured server operator cannot access uploaded records.

### Reviewer test instructions

Provide a dedicated, limited-use model credential only through an appropriate private reviewer field if required; never put credentials in listing copy, screenshots or this repository.

```text
A model-provider API key is required for AI features.
1. The settings page opens after installation. Read the notice and click “Agree and start.”
2. In Model, choose a provider, enter a model ID and API key, then click “Save and test connection.”
3. Open an English article, such as https://en.wikipedia.org/wiki/Reading. The popup shows reading progress after article detection.
4. In the popup's Translate tab, enable translation for this page. Select English text to view its translation and notes.
5. Alt+Shift+S starts screenshot translation; select a region containing English text.
6. Open Vocabulary and Review to inspect saved words and review cards.
Sync is optional and disabled by default. AI explanations may be Chinese even though the interface is English.
```

## Consent behavior

From version 0.3.18, the settings page displays a prominent notice before the first model request. It explains automatic page classification, explicitly used features and the chosen recipient. No model request is made until **Agree and start** is selected.

Earlier installations with existing keys also open settings once after upgrading and wait for consent. Consent can be withdrawn in Model settings. It belongs to the installation and is excluded from exports.

## Automated upload and review submission

After a `v*` release, `release.yml` invokes `store.yml` with the same extension ZIP when the required secrets exist; otherwise the store job skips. Every version still needs store review. Descriptions, screenshots and privacy declarations are edited separately in the dashboard.

One-time setup:

1. Enable the Chrome Web Store API in the publisher's Google Cloud project.
2. Create a service account, then a JSON key. Do not grant unrelated project roles.
3. Add that service account email in the Chrome Web Store publisher account settings. Record its Publisher ID.
4. Store the complete key JSON and Publisher ID as GitHub repository secrets:

   ```bash
   gh secret set CWS_SERVICE_ACCOUNT_JSON -R xbghc/lectern < /path/to/service-account-key.json
   gh secret set CWS_PUBLISHER_ID -R xbghc/lectern
   ```

5. Keep the key in protected credential storage and remove unnecessary downloaded copies. Never commit it.

The workflow logs the upload and review-submission states. If a previous version is still in review and the store rejects a new upload, the GitHub Release/APK remains unaffected. After resolving the pending review, rerun **Actions → Chrome Web Store** with the same release tag.

For a local upload, provide `CWS_SERVICE_ACCOUNT_JSON` and `CWS_PUBLISHER_ID` through your credential environment, then run:

```bash
node --experimental-strip-types scripts/store-upload.ts lectern-extension-vX.Y.Z.zip
```

Add `--no-publish` to upload a draft without submitting for review. `test/storeUpload.test.ts` verifies API requests using a simulated store. A response of `PENDING_REVIEW` means submitted, not published. GitHub log masking can replace standalone JSON braces with `***` when a multiline JSON secret contains those lines; this does not affect the request.
