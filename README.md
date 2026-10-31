# Lectern

A reading companion for Chrome, Edge and Android. Lectern tracks article progress and focus time, translates selected text with your own AI provider, and helps you revisit vocabulary with FSRS spaced repetition.

The interface and documentation are in English. AI translations, teaching notes, article reviews and vocabulary coaching can still use Chinese. Your articles, books and saved content keep their original language.

- [Chrome Web Store](https://chromewebstore.google.com/detail/fpplijdeabekpbadojohidampfnjhcdf)
- [Extension packages and Android APKs](https://github.com/xbghc/lectern/releases)
- [Interactive interface previews](https://xbghc.github.io/lectern/storybook/)
- [Privacy policy](https://xbghc.github.io/lectern/privacy/)
- [Sync server deployment](docs/server-deployment.md)
- [Chrome Web Store listing and publishing](docs/chrome-web-store.md)

## Getting started

Install from the Chrome Web Store, or extract a release ZIP and load its directory through **chrome://extensions → Developer mode → Load unpacked**. Chrome and Edge 114 or newer are supported; Firefox is not supported because the extension uses `chrome.sidePanel`.

The settings page opens after installation. Choose a provider, enter your API key and select a model. Advanced connection settings contain the protocol, URL and response limits; choosing a custom endpoint opens them automatically. Review the content-sharing notice and confirm it. **Save changes and test** saves both reading preferences and model configuration, then checks the connection; **Save** saves without a model request. Consent is still required before any model request. Saved settings and the connection-test result are reported separately. Without a configured model and key, Lectern cannot classify new articles or translate; existing history remains available.

The store extension and an unpacked extension have different IDs and separate local data. Sync or export your records before switching installations.

For Android, install `lectern-vX.Y.Z.apk` from Releases and configure the model separately in **Settings**. Android and the extension keep separate API keys. Packages with different signing certificates cannot update each other; export your data before replacing an installation.

## Reading workspace

The desktop workspace has Reading, Vocabulary, Review, Statistics and Settings navigation. The reading overview uses your actual recent activity, unfinished articles and due review counts. Articles support list/grid views, search, completion filters and bulk actions; each article's menu provides details, completion status and review.

The extension popup opens on **Focus**, with today's total, a comparison to yesterday, the longest session, a selectable timeline and a seven-day chart. **Translate** independently controls translation for the page and the site's allowlist entry. Switching tabs does not change tracking or translation state.

Pausing focus settles the current session and keeps that page paused until you resume it. Scrolling or switching away and back does not resume it. Pausing translation does not change its global setting or site allowlist. These choices survive browser back/forward restoration, but a refresh or a different article uses the default rules again.

Android puts reading first: the bottom navigation contains Reading, Vocabulary and Settings. Continue a recent article or book, browse the bookshelf, or add an article URL. **All articles and management** opens search, filters and bulk actions. Review starts from Vocabulary; Statistics is available beside the home search control.

The interface follows [shadcn/ui's theme conventions](https://ui.shadcn.com/docs/theming): neutral surfaces, clear borders, rounded controls and consistent light/dark colors. Shared tokens and controls live in `src/ui/theme.css`; the existing TypeScript interfaces use these styles directly. Long-form reading retains its serif typography and unobtrusive bottom progress line.

## Model connection

All model features share one connection: article detection, translation, teaching notes, follow-up questions, article review, vocabulary chat and rule suggestions. There is no preset provider for a new installation.

- The searchable provider catalog is a build-time [models.dev](https://models.dev) snapshot under its MIT license. Provider names, IDs, domains and aliases are searchable. Selecting one fills the URL and protocol; you can edit them or choose **Custom URL**. Model IDs can be entered manually.
- Supported protocols are OpenAI-compatible **Chat Completions** and Anthropic-compatible **Messages**, sent directly in their native request formats. There is no protocol-converting proxy.
- Include the version segment in the base URL, such as `https://api.openai.com/v1`. HTTPS is required except for `localhost`, `127.0.0.1` and `[::1]`. Credentials in URLs, query strings, fragments and redirects are rejected; enter the final endpoint.
- Changing the protocol, host or effective port requires a different API key. The old key is cleared and is never sent to the new destination. Changing only a path or spelling out the default port does not require a replacement key.
- API keys are stored separately, excluded from exports and kept out of extension content scripts. Extension model requests run in the background service worker.
- Earlier MiniMax configurations are preserved on upgrade. JSON response handling was initially tuned with MiniMax; compatibility with every provider/model has not been verified. Reasoning models may need a higher output-token limit to avoid truncation.

Update the catalog with `npm run providers:update`, review the diff, then commit it. The snapshot does not contact models.dev at runtime. `scripts/update-providers.ts` supplies a small set of explicit endpoint overrides; providers requiring account-specific URLs or request signing are excluded.

## Article detection and rules

After consent and model setup, opened pages outside the **Reading blocklist** are classified using only their URL. Before sending, Lectern removes URL usernames, passwords, query strings and fragments. The model receives the remaining HTTP(S) URL, with no page title or text, and infers the page type from its domain and path. URL paths can still contain sensitive information; use the reading blocklist for sites you do not want classified. Classification requests and their failure diagnostics use the same cleaned URL.

URL-only classification is less reliable for ambiguous paths or sites whose routes depend on query strings or fragments. An inconclusive answer leaves the page untracked; Lectern does not fall back to sending content or fetching the page for classification. Tracking and local body extraction begin only after an affirmative result. Readability locates the body text; it does not decide whether a page is an article.

Network failures retry after 5 and 20 seconds. Content-policy refusals do not retry; the extension suppresses repeated requests for the same URL for one hour within its browser session. Errors appear in page status and diagnostics. Existing history is not deleted automatically.

**AI filter** rechecks selected saved records using the same cleaned URL alone and labels the source as **URL only**. It does not read saved article text or fetch the original page. Inconclusive answers and model failures remain errors, rather than being treated as non-articles. You can stop new requests, retry failures and select non-articles, then explicitly delete selected records. Results last only for the current panel session.

Bulk deletion removes the selected articles' sessions, paragraphs, positions, cached text, review material and article review cards, and recalculates reading speed. It preserves translations and vocabulary cards. Deletion propagates through sync and cannot be undone. To prevent future tracking, add a reading blocklist rule.

The model can also suggest blocklist rules from selected titles and URLs. Each suggestion includes its rationale, possible collateral matches and the number of existing records it affects. Only selected, confirmed rules are saved; history is not deleted and translation rules are not changed.

Rules accept one bare domain or complete HTTP(S) URL per line. A domain includes its subdomains. A URL matches the same origin and its case-sensitive path or child paths, without query strings or fragments: `/search` does not match `/searching`. Legacy shared blocklists migrate to the reading blocklist.

Reading tracking and translation are independent. A reading block does not disable translation. The **Translation allowlist** automatically enables selection translation on matching sites; elsewhere, enable it from the popup for the current visit or choose **Always enable on this site**. The allowlist is device-local and does not sync.

### Edit rules in plain language

Use the popup's translation tab or the settings rule editor to request changes such as “Stop tracking example.com” or “Enable translation on GitHub.” In the popup, “this site” refers to the active page; settings has no current-page context.

The model proposes changes; nothing is written until you confirm. Rules are validated both when proposed and against the latest stored lists when applied. Invalid patterns, public-suffix-wide blocks, duplicates, covered rules and missing removal targets are rejected. Existing unsaved edits in settings are preserved. The conversation includes the last eight messages and summaries of applied changes, and lasts only while that editor remains open.

## Focus, progress and reading time

Focus requires a visible page and a focused window. Idle and stall timeouts distinguish no activity from activity without scrolling. Both adapt to visible text: the inactivity limit is the greater of its fixed value and 1.5 times the estimated screen-reading time, capped by the adaptive maximum. Set that maximum to zero to disable adaptation. Very short sessions are discarded.

Paragraphs count as read after a configurable fraction of their estimated reading time in view, with a minimum dwell time. Estimates use 238 words/minute for English and 400 characters/minute for CJK text. The default fraction is 50%; briefly scrolling past text is not enough.

The extension's optional top progress strip sizes segments by text length. Dark segments were read this visit, blue-gray segments were read before, pale segments were briefly visible and empty segments are unseen. The current viewport is highlighted. This display preference is local to the device. The Android reader uses a faint progress line at the bottom edge instead.

An article is finished only when its read percentage reaches the configured threshold **and** its final paragraph has been visible. Completion can also be changed manually. Article review, when enabled, saves the body text and generates an outline and three recall questions at the threshold, ready for the completion card. This automatic model call consumes tokens.

Reading rounds combine nearby sessions on the same article; the overview displays the merge threshold. This avoids treating every tab switch or inactivity boundary as a separate reading effort. Estimated reading times and historical statistics are approximate, not a measure of comprehension.

### Resume reading

Lectern remembers the last paragraph and restores it when you reopen the article. URL anchors, browser-restored positions and scrolling during extraction take priority. In the extension, a notice offers **Back to top** after restoration. The Android reader restores the position without a notice. Synced article positions can continue on another device, although changed page structure may prevent an exact match.

### Statistics

The popup's seven-day chart uses local calendar days and splits sessions crossing midnight by their actual overlap. Saved sessions and live session snapshots are deduplicated. The statistics page's round percentiles retain their rolling 168-hour window.

Android statistics offer Today, Last 7 days and Last 30 days. Select a bar to see article and book time. Finished articles use completion dates and exclude EPUB chapters; saved vocabulary is deduplicated within the selected dates. The 30-day chart groups five days per bar without changing stored records.

## Translation and vocabulary

Select text on an enabled page for a context-aware translation. Short selections are ignored; selections over the automatic word limit require confirmation. The surrounding paragraph helps choose the meaning. Teaching notes add usage, collocations or word distinctions, and can explain unfamiliar words within a selected sentence. They increase response length and latency; translation appears first.

Classical Chinese, in simplified or traditional characters, translates into modern Chinese without a separate language switch. Teaching notes explain classical meanings, function words, borrowed characters and grammar in context. A single Chinese character can be looked up with the default selection limit. Multi-character Chinese selections are treated as passages, so an unspaced sentence does not become a vocabulary card. The automatic limit counts Chinese characters and English words; punctuation does not add to the Chinese count.

On Android, tap an English word or a Chinese character to translate it, or double-tap for its sentence. A short delay distinguishes the gestures. Links keep working, and scrolling does not translate. Tapping outside an open translation panel closes it; another deliberate tap is needed for a new translation.

The translation panel supports streamed output, pronunciation where available, source context and follow-up questions. Explanations use Chinese; examples and review exercises follow the source language. Chinese pronunciation uses Mandarin voices, and speech availability depends on voices installed on the device.

### Screenshot translation

Use **Alt+Shift+S** in the extension, or the Android reader's tools, and select a region. OCR runs locally with bundled Tesseract in the extension and ML Kit in Android. The screenshot is not uploaded; recognized text is sent to your configured model. Because this is an explicit action, it does not depend on the selection-translation switch or allowlist.

Both hosts recognize English and simplified/traditional Chinese. OCR can mix simplified and traditional forms or misread individual characters, even in clear print. Check the recognized source text when meaning depends on a particular character. Horizontal printed text works best; vertical layouts, handwriting and damaged historical scans may require selecting the original page text instead.

### Review

Looked-up words and phrases become FSRS review cards. Reveal an answer and rate recall to schedule the next review. AI assistance can provide examples, a different explanation or a quiz. Article review separately revisits saved outlines and recall questions. Editing or deleting one translation preserves a card while other sources remain; an orphaned card is hidden, with its review history retained for a later matching source.

**Undo last rating** returns to the previous card and restores its schedule during the current review queue. It retracts that exact rating through sync, preserves other cards and refuses a stale undo when that card has a newer rating. **How to rate your recall** explains the four choices. Vocabulary lists show meaning and a short source context first; management actions are in each item's more menu.

### Vocabulary chat

Choose one to three words from Vocabulary to practice context, sentences or a short role-play. Chat uses the configured model and consent, supports streaming and stopping, and sends the selected words, source context, current message and recent six rounds of conversation. It does not change review schedules automatically.

The latest 20 practices, up to 20 rounds each, and drafts stay on this device. History can be deleted locally and is excluded from sync and exports. Storybook supplies isolated sample replies instead of calling a model.

## Android reader and books

Add a URL, share one from a browser, or open an article saved by the extension. A fetched article is cleaned for the reader; sites requiring login, complex interaction or anti-bot checks may not extract correctly. A browser-saved archive is preferable when the desktop browser already has access. The reader does not execute source-site scripts.

On phones, reading shows only the article and a faint 2px progress line at the very bottom of the screen. System bars and reading tools start hidden; scrolling up or returning to the beginning does not reveal them. Tap the margins beside the article to show or hide tools. Text and paragraph spacing keep their word and sentence translation gestures. Keyboard and screen-reader users have a separate **Show reading tools** button.

Reader controls include font size, device-local bookmarks and a chapter outline. Previous chapter, Contents and Next chapter are available at the end of each chapter; they scroll with the text. The exact progress percentage and source details live inside the tools. Scrolling 24px in either direction, closing the outline or pressing Back hides the tools again without shifting the text. Changing font size preserves the visible paragraph. Translation panels remain available on demand. Font size and bookmarks do not sync. Opening a book resumes its most recently visited chapter and saved paragraph, including positions within the final paragraph.

The text-size button opens a panel without changing the text. Decrease/increase controls adjust 14–28 px, show the current value and restore the 18 px default. Contents contains only chapter navigation; the separate **Reading tools** menu holds bookmarks and translation actions. A one-time introduction explains the margin gesture before reading, and can be reopened from Reading tools.

The Android reader does not show the extension's top progress strip, position notice or completion card. Position restoration, reading records and the review queue continue to work.

Import EPUB files from the bookshelf or open them with Lectern from a file manager. Chapter HTML uses the same sanitizer as saved articles; images are stored locally by content hash. Books, their images and chapter progress remain on this device and are excluded from sync and JSON exports. Import the original EPUB again on another device; its chapter progress starts fresh. Vocabulary and cards derived from books are independent and can sync.

The Android shell handles back navigation, foreground/background transitions, safe-area insets, local file sharing, OCR and updates. Reading text remains selectable; controls are sized for touch. A web preview cannot verify every native behavior.

### App updates

The app checks public GitHub releases at most once a day unless disabled in Settings, including when an older update has already been downloaded. Stable installations check the latest stable release; installing a `vX.Y.Z-preview.N` APK opts into subsequent preview updates instead. Both use the existing release signing certificate, so newer packages can update an existing installation without removing its data. To change channels, install a newer APK from the other channel. The app remembers the latest offer between checks. This anonymous request does not include API keys, reading data or the current version; comparison happens locally. Manual checks remain available.

Automatic downloading, when enabled, uses an unmetered network and HTTPS GitHub APK URLs, then attempts installation after you leave the app. Android may require permission or confirmation. Disable this option to use the update banner manually. The extension instead receives updates through the Chrome Web Store. A submitted extension update still requires store review.

## Data, sync and privacy

Business data is local-first. Optional sync uses the server URL and token you configure; read [deployment and recovery instructions](docs/server-deployment.md) before operating one. The server stores structured records in PostgreSQL and article files separately. It does not fetch original websites or call models.

Test a connection to verify the account and server identity before enabling it. The first sync merges local and server records. Offline work remains available and queues for later upload.

- **Pause sync** keeps credentials and queued changes.
- **Disconnect** removes the local token and keeps records and their account binding.
- **Clear this device's records** disconnects and clears local records and binding while preserving settings and model keys. It does not delete server data.
- Clearing also invalidates reading sessions, queued article captures and resource downloads already in progress. Old pages must be reopened before recording into the new profile.
- To switch accounts or servers, export a backup first, clear local records, then connect. Already-bound data cannot be silently uploaded to another identity.

Reading and translation preferences sync by field, except explicitly device-local options such as the translation allowlist and progress-strip display. Model configuration, keys, consent, sync tokens, font size, bookmarks, update preferences, EPUB data and chat history remain local. Diagnostic logs and usage counts have separate upload endpoints when sync is enabled; they are not downloaded to other devices.

### Saved article archives

On an accessible, fully loaded desktop article, choose **Save article to sync library** in the popup. Body text and available images are saved locally and uploaded when sync is connected. Missing images are reported; retry after the source page loads, although access restrictions can still prevent capture.

After syncing on Android, open the saved article to download its resources. The **Available offline** state indicates downloaded content can be read without a network. Syncing the article list does not download all files in advance. Ordinary URL caches are not automatically converted into browser archives. The archive reader never reloads the source URL or executes its scripts.

If one archive has missing or rejected resources, its upload stays pending with an error shown in sync details. Other archives and reading records continue to upload. Deleting a book preserves images still used by saved articles or another book.

### JSON export and merge

Export JSON for a backup or to merge records on another device. Articles, sessions, translations, review cards and available review events merge by identity. Importing the same file twice does not duplicate records. Cards for the same word merge, using the latest review history or scheduling baseline. Book vocabulary backups include their pre-review baseline so importing them does not count the same review twice. Older files without individual review events retain their latest schedule as a baseline. Import commits records and review history together.

Exports do not contain API keys, sync tokens, complete archive resources, local EPUB content or vocabulary chat history. They are not a substitute for a server database-and-file backup. Import does not replace settings or keys.

Manual finished/unfinished choices survive reopening chapters and backup merges. Import preserves the newer explicit choice; you can change it immediately afterward, including on profiles restored by older releases.

### Diagnostics and usage counts

Local diagnostics keep the latest 10 model failures, 50 request timings, translation traces, and (in the app) 30 fetch logs and 30 runtime errors. Failure details can contain selected text, context and raw model output. Keys are excluded. Diagnostics are separate from record exports and can be copied, downloaded or cleared in Settings.

When sync is enabled, new or updated diagnostic entries are uploaded to the configured server. Server operators can inspect them with the admin `logs` command; server retention is 30 days. Translation trace previews include up to 160 characters of selected text. Treat diagnostic exports as private reading data.

Workspace buttons record daily counts for 90 days locally. Counts contain event identifiers, not article identities or search terms. Enabled sync uploads cumulative counts for administrator analysis; retries cannot double-count them. **Clear logs** does not clear usage counts. Event definitions live in `src/lib/uiUsage.ts`; keep event IDs stable when changing display labels.

## Development

Use Node.js 22.14 or newer within the supported Node 22 line.

```bash
npm ci
npm run check                 # TypeScript, unit tests, extension and Android web builds
npm run watch                 # Extension development build
npm run build:app             # Android web assets
```

Extension output is `dist/`. Android web output is copied into the app's assets by the build script.

For a native debug APK, use JDK 17, Android SDK 36 and build-tools 36.0.0:

```bash
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The Gradle build runs the web build first. Set `sdk.dir` in an untracked `android/local.properties`, or use Android Studio. Never commit signing keys or local credentials.

### Storybook

```bash
npm run storybook             # http://localhost:6006
npm run typecheck:storybook
npm run test:storybook
npm run build-storybook       # storybook-static/
```

Choose **Extension** or **Android** stories for the popup, workspace, vocabulary, review, statistics, settings, side panel, bookshelf, reader and chat. Controls change frame size, state and initial tab. Media queries use the iframe's actual width.

Previews compile the real templates and entry points. `storybook/fixtures.ts` provides sample records; `storybook/runtime.ts` supplies memory storage and simulated host/model responses. Search, filters, settings and review actions work within the preview. Reloading resets sample data without touching real history. OCR, installation and cross-page native navigation require their actual host.

Add scenarios in `storybook/*.stories.ts`. Register new full pages in `.storybook/pages-plugin.mjs`. Frames are isolated documents, destroyed on exit to clean up listeners and timers. Serve the static build over HTTP instead of opening it as a file.

### Architecture

`src/core/` coordinates page and background hosts. Reading and translation features live under `src/features/`, with their own page hooks, background handlers and settings declarations. `src/lib/` contains shared model, parsing, scheduling and statistics logic. `src/sync/` defines shared protocol and merge behavior; the backend compiles the same protocol sources. `src/archive/` and `src/books/` handle saved content and local EPUBs.

Keep feature boundaries, storage keys, protocol IDs and account binding intact. UI language changes must not rewrite user content or change AI output-language instructions. New UI controls should register a stable event in `UI_EVENTS` where appropriate.

### CI and releases

Main and pull-request workflows check client/server code, run PostgreSQL integration tests, build the extension, Android app and Storybook, and validate server images as configured in `.github/workflows/`. Main publishes the preview and static site to GitHub Pages.

Every push to `main` runs the Release workflow and publishes a GitHub prerelease containing an extension ZIP and Android APK after checks pass. Preview versions use the next patch and the Release workflow run number, for example `v0.3.30-preview.30`; the source package version stays unchanged. Preview builds do not submit to the Chrome Web Store. Download the newest preview from [Releases](https://github.com/xbghc/lectern/releases), then use the app's normal update checks for subsequent previews. Running the Release workflow manually on `main` also creates a preview.

A stable `vX.Y.Z` tag continues to trigger release ZIP/APK artifacts, server images and Chrome Web Store submission. Root and server package versions and lockfiles must match the tag. Published Android packages use `1,000,000 + Release workflow run number` as their versionCode across both channels; keep this workflow's sequence when changing the release setup. Local builds retain their package-derived versionCode. Keep the Android release certificate stable so existing installations can update. Required signing secrets are documented in the release workflow; never substitute a different key for an existing release app.

Chrome Web Store automation uploads the same extension ZIP and submits it for review when configured. Upload success does not mean public availability. Store descriptions, screenshots and privacy declarations are maintained separately; see the [store guide](docs/chrome-web-store.md).

## Migration and limits

The project was renamed from Focus Session to Lectern. The extension migrates legacy IndexedDB data on first open. Existing deployment names, the `focus-session` Compose project, `focus` PostgreSQL role/database, `FOCUS_SERVER_IMAGE` and `fs:` storage prefixes are intentionally retained to preserve data and compatibility.

The old Android package `com.focussession.app` cannot update in place to `io.github.xbghc.lectern`; install Lectern separately and transfer records through sync or export/import. Preserve local book files yourself.

Model compatibility, site extraction, OCR accuracy and system speech voices vary. Focus/progress metrics estimate activity rather than understanding. Storybook verifies web interfaces with simulated services; native installation, real credentials and production sync require separate environment checks. Lectern does not currently add OAuth sign-in, cloud-hosted model keys, or synchronization of local EPUB content.

