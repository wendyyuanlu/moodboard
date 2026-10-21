# moodboard

A mobile-first, offline-first moodboard builder. Original images, customizable tabs and collapsible sections, and complete portable saves. The published board is publicly viewable; publishing edits requires GitHub repository write access. There are no runtime dependencies or image recompression.

## Save the shared board to GitHub

The published website loads the shared board from this repository's **`board` branch**, not from another device's browser storage. Anyone can browse it, including a phone or incognito browser. Your existing local collection is preserved when connecting: a separate local collection is merged into the shared board, and conflicting versions are reported rather than silently overwritten.

To upload edits:

1. Open **Settings and backups → Enable auto-sync**.
2. Use **Open GitHub sign-in and token setup**, sign in, and create a fine-grained access token restricted to the **moodboard** repository. Grant **Contents: Read and write**; metadata read access is automatic.
3. Paste that token into the masked field in the app, not into chat, and save. This is token authentication to GitHub, not a native OAuth popup.
4. Pasting, uploading, cropping, reordering, editing, and deleting now autosave after a short debounce. Wait for **Saved to GitHub** before expecting a new device to see the change.

The GitHub token is kept **only in the open tab**, sent only to `api.github.com`, and never written to source files, browser storage, JSON backups, or portable HTML. Enter it directly in the masked **Enable auto-sync** dialog. Rejected authentication or reloading clears it. No credential is prefilled or hard-coded into the website. Revoke any exposed token in GitHub settings. Reconnect after reloading to upload further edits. Public viewing never needs the token. There is **no separate save server, tunnel, or cloud storage account**.

The separate **Coupon code** box above **Destructive actions** displays the public coupon `l33thelper`. Its 20px **Copy coupon** icon copies that value, including offline. The coupon is intentionally public, is part of the app and portable HTML, and is never used for GitHub authentication. To change it, edit the `couponCode` constant in `app.js` and rebuild.

Original files are committed under `images/`, with the original filename retained in the path and board metadata. `board.json` stores tabs, sections, titles, notes, source URLs, and nondestructive crop coordinates. Copies share their original file; deleting its last placement removes the current Git file. **Git history still retains earlier copies.** The separate data branch avoids rebuilding GitHub Pages for every pasted image.

Offline changes are saved in IndexedDB with a persistent outbox. Reconnect to the internet and choose **Enable auto-sync** to upload them. Another person's newer save produces a visible conflict: export a backup, then use **Merge local with Github version**, **Replace local with Github version**, or **Replace Github with local version**. Merge preserves both versions and can produce duplicate placements for you to organize. Load/replace actions require confirmation where they would discard edits.

Fresh public visits resolve the latest Git commit through GitHub's API, then load the manifest and all originals from that **same immutable commit**, avoiding stale branch-file caches and mixed versions. Public pages recheck approximately every five minutes while visible (or when returning after a minute); connected editors recheck more frequently. **Force re-sync** also refreshes the shared version. A shared board is installed only after **every original image** has loaded and passed its checksum/format checks. A missing original is an error, not a successful partial board. GitHub's anonymous/authenticated API rate limits and 100 MiB individual-file limit apply; failed uploads remain local. Image bytes are never reduced to work around those limits.

## Start locally

Open `index.html` directly in a desktop browser. It contains the entire app.

For an installable offline web app, use Node.js:

```powershell
npm start
```

Open http://localhost:8085. Wait for **Offline ready**. HTTPS hosting or localhost is required for service workers, installation, and the clipboard read button. Keyboard pasting works wherever the browser permits clipboard events; a file picker is always available.

## Collect and organize

- **Paste:** Ctrl+V / Command+V outside a text field. The paste toolbar and its former menu shortcuts are hidden. Pasted clipboard bytes and uploaded image files are stored without resizing or recompression.
- **Source pages:** pasting also saves the original page link when the clipboard explicitly provides it (a `SourceURL` header, canonical URL, or Open Graph page URL in its HTML). This works with keyboard paste and the Paste button when those formats are available. An image's `src` or an arbitrary surrounding hyperlink is not assumed to be the page address. Browsers frequently omit page metadata, and screenshots normally contain none. Add or correct **Source page URL** in the image's **···** details menu; open saved links using **Source page** in the viewer. Links survive copies, moves, offline HTML exports, and JSON backups. Visiting the source website still requires internet; it is not downloaded.
- **Placement:** click a **Paste here** gap before an image, or the end of a section to append. An empty section contains one large **Add or paste at the end** target instead of a decorative placeholder; clicking it selects that section for subsequent pastes/uploads, and it also accepts dropped image files. Change that location anytime. Consecutive pastes keep their incoming order. **Add a section** spans the full board width. The board/footer omit decorative filler text while retaining the offline guide and readiness status.
- **Upload:** **Add images**, a section's **+ Add**, or drag files onto a section/image gap. Multiple files are accepted together.
- **Browse:** click/tap an image to open its original-resolution, edge-to-edge viewer (no left/right padding). Use arrow keys, previous/next buttons, or horizontal swipes. **Actual size** allows panning. **Open original** opens the actual source image URL when recorded, separately from the source webpage; otherwise it opens the saved original blob. Clipboard HTML's unambiguous HTTP(S) image `src` is saved when available; missing URLs are never invented. The download button always uses the saved original, including offline. External source links need internet.
- **Select:** Grid and List always show checkboxes while editing. Masonry shows them on desktop hover, keyboard focus, and selected images; touch devices always show them. Checkboxes are 30% smaller, with larger touch/click targets. Use Ctrl/Command-click, Shift-click range, Ctrl/Command+A, or quickly drag a desktop selection rectangle from an image, checkbox, or blank space. Hold Ctrl/Command/Shift while dragging to add to the selection; Escape cancels a selection drag. The bottom toolbar has **All** plus icons for selecting the sections containing already-selected images, copy, move, delete, and clear. Section selection includes every represented section, not unrelated sections or tabs.
- **Crop:** each image has an icon-only crop button. The compact editor is titled **Crop image** without the filename or numeric fields and always loads the full original. Drag on the original to draw a crop, drag inside the frame to move it, or resize with the four corners. Focus the frame and use arrows to move, or Shift+arrows to resize in one-percent steps. **Reset crop**, **Cancel**, and **Save** share the bottom bar. Reset restores the full view; Cancel discards editor changes. Crops affect the board view in all layouts, not the original-resolution viewer or downloads. Only crop coordinates are saved: originals are never modified or recompressed. Crops survive copies, moves, reloads, JSON backups, and portable HTML saves, including offline use.
- **Rearrange:** hold an image, or hold its dotted grip, then drag. Selected groups retain their relative order. On mobile the grip prevents scrolling during the drag. Drop before/after images, on insertion gaps, or into a section. Hover another tab while dragging to switch tabs. **Move to…** and numeric positions work without dragging.
- **Delete one image:** use the card's **×** button between its move grip and **···** menu, then confirm. Card editing controls are hidden when Edit is off.
- **Delete warnings:** the confirmation dialog lets you enter how many future delete clicks should skip the warning. Entering 10 skips the next 10 successful delete actions after the current confirmation; deleting 10 selected images counts as one action. Canceling or a failed save does not consume/grant skips. Zero warns every time. The allowance is per open tab and resets on reload; it is not shared or included in exports.
- **Tabs:** with editing on, double-click a tab to rename, reposition, duplicate, or delete it. Keyboard users can focus a tab and press **F2**; touch users can press and hold it. A single click still switches tabs.
- **Sections:** use their **···** menus to rename, reposition, duplicate, move sections between tabs, and delete. Duplicates have independent organization and share original image bytes locally.
- **Layouts:** icon-only Masonry, Grid, and List buttons have accessible names and tooltips. Masonry fills the horizontal space first, then places subsequent images in the shortest column. Grid stretches occupied columns to use the available width. The unlabeled display-size slider changes only thumbnails, never source image dimensions.
- **Shy header:** the tabs and layout/edit bar stick to the top while browsing, hide when scrolling down, and return when scrolling up or focusing a header control. Keyboard focus and active drag/editor/viewer interactions keep the controls accessible.
- **Card captions:** **Settings and backups → Caption** has a compact switch beside the Caption heading for the entire caption, plus inline filename and URL switches. **Save** and **Cancel** sit directly beneath these controls. Captions are off by default, including older backups without a caption preference; explicitly saved preferences are preserved. Turning captions on initially shows URLs, not filenames. Missing source URLs have no placeholder text or empty caption space. Original filenames are retained on import, including files collected from blog entries. Notes and file sizes remain hidden in caption markup and available in the details editor/viewer. Each image's 30px editing/link buttons overlay the picture's bottom-right corner in every layout, without reserving caption space.
- **Source shortcut:** images with a saved page URL have an icon-only link beside their hover controls and in their **···** details menu. It opens the original webpage in a separate tab, independently of caption visibility. Images without a source URL do not have a fake or disabled link.
- **Photo details:** fields are ordered Source page URL, Section, Position, Notes, Filename, then original-file metadata and action buttons. A 20px **Go to site** icon sits beside the source URL label and follows edits to that URL. The selection bar uses 30px buttons with 20px icons, a folder-and-arrow Move icon, and Clear selection beside the count. Copies create independent placements/crops while sharing one original asset, including in GitHub and portable exports.
- **Header and settings:** the hamburger and upload buttons are on the left, with save status before Save portable copy on the right; there is no logo or tagline. **Manage** starts with Login / Enable auto-sync and Force re-sync. Backup export/import share a row, followed by Protect browser storage directly above Merge local with Github version; the guide is last. The info icon toggles descriptions directly underneath each management button, not in a separate help section. It is filled when enabled, works offline, and does not close settings. Login is hidden once this tab is connected, and Disconnect GitHub is hidden. **Enable auto-sync** authorizes the app using the token flow and displays a checkmark without changing button size; a GitHub website session alone is not an app connection. Text mentions of **Enable auto-sync**, including the save-status prompt, link to that authorization dialog. Connected edits sync automatically; Force re-sync retries/refreshes manually. GitHub controls remain visible when unavailable: internet-dependent actions are greyed out offline and sync actions are disabled in local/portable copies, with explanatory tooltips. Local editing, backups, and portable export remain usable offline. Conflict warnings appear at the top of Manage. **Last sync** shows the local date and time of this device's last successful GitHub read or upload, retained across reloads in browser metadata; offline edits, failed requests, and unresolved conflicts do not advance it. **Destructive actions** separately lists replacing GitHub with the local version and replacing the local version with GitHub. Caption switches and their Save/Cancel controls follow Manage; accent color remains at the bottom. Protect browser storage requests protection from automatic eviction, not from clearing site data or losing the device. An existing collection's theme is preserved.
- **Edit mode:** starts on each time the app opens. Use the horizontally flipped pencil beside the layout icons to toggle it. Its button is a 38px square; control icons are 20px square, with their larger touch/click targets preserved. Turning it off hides editing controls and prevents accidental edits while browsing. The intro and paste toolbar are hidden; the header image-plus icon uploads images and **+ Add a section** remains at the bottom.

PNG, JPEG, GIF, WebP, AVIF, BMP, and ICO raster images are supported when the browser can decode them. SVG and unrecognized image formats are rejected explicitly. Screenshots preserve the clipboard's bytes and dimensions, which may differ from the source image copied by another application.

## Take it offline on a computer or USB

1. Add your images and organize the board.
2. Click **Save portable copy**. This downloads `moodboard-YYYY-MM-DD.html`.
3. Copy that HTML file to your computer or USB. It contains the entire app and **every full original image from every tab and section, including collapsed sections**, plus filenames, notes, source URLs, crop coordinates, and organization. It does not rely on GitHub image links or thumbnails. No companion folder is required.
4. Open it in a desktop browser without internet.
5. After editing, **Save portable copy again** and keep the latest download. The original file on disk/USB is a snapshot and is **not automatically overwritten**.

Also keep a **JSON backup** from **Settings and backups**. Portable HTML works with no internet, no GitHub login, and even without IndexedDB when the browser permits running local HTML; in that case edits remain in memory until you export again. Portable copies deliberately have online sync disabled and contain no authentication token. A portable file can be large because it embeds originals as base64. Export requires device memory proportional to the collection. Browser storage, file decoding, available memory, and GitHub's file/API limits set practical limits.

## Use it offline on a phone

1. While online, open the HTTPS website in the phone's browser.
2. Use **Add to Home Screen** / **Install app**, if offered.
3. Let the shared GitHub board finish loading all originals. If you are using a separate, unshared local collection, transfer and import its JSON backup instead.
4. Wait for **Offline ready** and test launching/browsing in airplane mode before travelling.
5. For shared edits, choose **Enable auto-sync** on the phone and wait for **Saved to GitHub** when online. Also export a new JSON backup after editing.

Mobile file managers sometimes only preview HTML files and do not execute their JavaScript. Opening portable HTML directly from Files/USB is therefore not a reliable phone installation strategy. Hosted installation plus JSON import is recommended. Phone clipboard APIs differ; use the photo/file picker if image paste is unavailable. Pinch zoom/panning is available through the browser; the built-in viewer provides original-size panning.

## Bring offline changes back to the website

The hosted shared app syncs through GitHub after you connect it. A portable USB file is intentionally an independent snapshot with no credentials or automatic publishing. To bring its edits back:

1. In the offline copy, open **Settings and backups → Export JSON backup**.
2. Open the hosted website on your target device.
3. Choose **Import JSON backup** and select that file.
4. Confirm replacement of the open collection and shared board. Export the previous collection first if you want to keep it.
5. Choose **Enable auto-sync** and wait for **Saved to GitHub**.

USB-to-site transfer is manual; connected edits on the hosted site autosave to GitHub. GitHub Pages serves the static app, and the app uses GitHub's APIs directly for authenticated commits. **The published board and its images are public.** Do not publish private images or commit credentials. Only people with repository write access can publish edits.

## Storage and safety

- IndexedDB caches complete original image blobs, metadata, and the pending GitHub outbox on the current device/origin. Unsynced edits still exist only on that device. Portable embedded images also work without IndexedDB, with a visible warning and export requirement.
- Storage failures and stale edits from a second window are reported rather than silently overwriting data.
- A portable copy reopens newer autosaved edits for the same collection in that browser; embedded content is the fallback on a fresh browser/device.
- Deletions require confirmation. Backups/imports are validated before replacement.
- Clearing site data, browser eviction, or private browsing can remove local edits. Export backups regularly. **Protect browser storage** requests persistence but is not a backup.
- No analytics or runtime third-party scripts/fonts. The hosted shared app contacts `raw.githubusercontent.com` to read originals and `api.github.com` for authenticated reads/writes. Ordinary source-page links are not fetched until opened. Portable HTML makes no network requests.

## Develop and test

Requires Node.js. The committed `index.html` inlines `shell.html`, `styles.css`, `board-format.js`, `github-store.js`, `app.js`, and the public repository configuration from `cloud-config.json`:

```powershell
npm ci
npm run check
npm run test:sync
npm run build
npm test
```

Tests use Playwright and an installed Chrome browser, including mobile touch emulation, original-byte checks, portable file reopening, offline reloads, and stale-window protection. Test dependencies are not used by the app.

## GitHub Pages

Publish this folder in a separate `moodboard` repository. In **Settings → Pages**, select deployment from `main`, root directory. Update `cloud-config.json` with the public site URL, repository owner/name, and data branch; never put a token there. Shared sync is enabled only on that configured site, not local previews or USB exports. All paths work at `https://YOUR-USERNAME.github.io/moodboard/`. Increment the cache version in `sw.js` when publishing app updates.
