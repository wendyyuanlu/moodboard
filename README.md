# moodboard

A mobile-first, offline-first moodboard builder. Original images, customizable tabs and collapsible sections, and portable saves. No account, external image hosts, runtime dependencies, or image compression.

## Start locally

Open `index.html` directly in a desktop browser. It contains the entire app.

For an installable offline web app, use Node.js:

```powershell
npm start
```

Open http://localhost:8085. Wait for **Offline ready**. HTTPS hosting or localhost is required for service workers, installation, and the clipboard read button. Keyboard pasting works wherever the browser permits clipboard events; a file picker is always available.

## Collect and organize

- **Paste:** Ctrl+V / Command+V outside a text field, or use **Paste** where clipboard access is supported. Pasted clipboard bytes and uploaded image files are stored without resizing or recompression.
- **Source pages:** pasting also saves the original page link when the clipboard explicitly provides it (a `SourceURL` header, canonical URL, or Open Graph page URL in its HTML). This works with keyboard paste and the Paste button when those formats are available. An image's `src` or an arbitrary surrounding hyperlink is not assumed to be the page address. Browsers frequently omit page metadata, and screenshots normally contain none. Add or correct **Source page URL** in the image's **···** details menu; open saved links using **Source page** in the viewer. Links survive copies, moves, offline HTML exports, and JSON backups. Visiting the source website still requires internet; it is not downloaded.
- **Placement:** click a **Paste here** gap before an image, or the end of a section. Change that location anytime. **Append at bottom** returns to the bottom of the current tab. Consecutive pastes keep their incoming order.
- **Upload:** **Add images**, a section's **+ Add**, or drag files onto a section/image gap. Multiple files are accepted together.
- **Browse:** click/tap an image to open its original-resolution viewer. Use arrow keys, previous/next buttons, or horizontal swipes. **Actual size** allows panning; **Open original** and download preserve the original file.
- **Select:** checkboxes appear on desktop hover, keyboard focus, and selected images. They remain visible on touch devices, which have no hover. You can also use Ctrl/Command-click, Shift-click range, Ctrl/Command+A, or a desktop selection rectangle dragged from blank space. The bottom toolbar offers bulk copy, move, and delete.
- **Rearrange:** hold an image, or hold its dotted grip, then drag. Selected groups retain their relative order. On mobile the grip prevents scrolling during the drag. Drop before/after images, on insertion gaps, or into a section. Hover another tab while dragging to switch tabs. **Move to…** and numeric positions work without dragging.
- **Delete one image:** use the card's **×** button between its move grip and **···** menu, then confirm. Card editing controls are hidden when Edit is off.
- **Tabs:** with editing on, double-click a tab to rename, reposition, duplicate, or delete it. Keyboard users can focus a tab and press **F2**; touch users can press and hold it. A single click still switches tabs.
- **Sections:** use their **···** menus to rename, reposition, duplicate, move sections between tabs, and delete. Duplicates have independent organization and share original image bytes locally.
- **Layouts:** full-width masonry, grid, list, and thumbnail-size slider. Masonry fills the horizontal space first, then places subsequent images in the shortest column. Grid stretches occupied columns to use the available width. The slider only changes display size, never source image dimensions.
- **Card captions:** the existing caption blocks currently show clickable source-page URLs for testing, or **No source URL available** when none was supplied. Filenames, notes, and sizes remain in those blocks but are hidden with CSS, not deleted; they are still available in the image viewer/editor.
- **Edit mode:** starts on each time the app opens. Use the pencil beside Masonry/Grid/List to toggle it. Turning it off hides editing controls and prevents accidental edits while browsing. The intro section is hidden; **+ Images** remains available in the paste toolbar.

PNG, JPEG, GIF, WebP, AVIF, BMP, and ICO raster images are supported when the browser can decode them. SVG and unrecognized image formats are rejected explicitly. Screenshots preserve the clipboard's bytes and dimensions, which may differ from the source image copied by another application.

## Take it offline on a computer or USB

1. Add your images and organize the board.
2. Click **Save portable copy**. This downloads `moodboard-YYYY-MM-DD.html`.
3. Copy that HTML file to your computer or USB. It contains the app, organization, and every original image. No companion folder is required.
4. Open it in a desktop browser without internet.
5. After editing, **Save portable copy again** and keep the latest download. The original file on disk/USB is a snapshot and is **not automatically overwritten**.

Also keep a **JSON backup** from **Settings and backups**. A portable file can be large because it embeds originals as base64. Export requires device memory proportional to the collection. There is no artificial upload-size limit; browser storage, file decoding, and available memory set practical limits.

## Use it offline on a phone

1. While online, open the HTTPS website in the phone's browser.
2. Use **Add to Home Screen** / **Install app**, if offered.
3. Export a JSON backup on the device where your collection lives, transfer it using USB, AirDrop, Files, or another method of your choice, then import it from the app's settings on the phone.
4. Wait for **Offline ready** and test launching/browsing in airplane mode before travelling.
5. Export a new JSON backup after editing on the phone.

Mobile file managers sometimes only preview HTML files and do not execute their JavaScript. Opening portable HTML directly from Files/USB is therefore not a reliable phone installation strategy. Hosted installation plus JSON import is recommended. Phone clipboard APIs differ; use the photo/file picker if image paste is unavailable. Pinch zoom/panning is available through the browser; the built-in viewer provides original-size panning.

## Bring offline changes back to the website

The hosted app and a portable file each keep their own local collection:

1. In the offline copy, open **Settings and backups → Export JSON backup**.
2. Open the hosted website on your target device.
3. Choose **Import JSON backup** and select that file.
4. Confirm replacement of the open collection. Export the previous collection first if you want to keep it.

**This is manual transfer, not automatic synchronization or merging.** Imported changes are available in that browser only. GitHub Pages serves static app code; it does not receive your private images or edits. Visitors do not see each other's boards. Publishing a board for everyone or automatically synchronizing devices would require a separate, authenticated storage/sync service. Never place GitHub tokens in client-side code.

## Storage and safety

- IndexedDB autosaves original image blobs and metadata on the current device/origin. Portable embedded images also work without IndexedDB, with a visible warning and export requirement.
- Storage failures and stale edits from a second window are reported rather than silently overwriting data.
- A portable copy reopens newer autosaved edits for the same collection in that browser; embedded content is the fallback on a fresh browser/device.
- Deletions require confirmation. Backups/imports are validated before replacement.
- Clearing site data, browser eviction, or private browsing can remove local edits. Export backups regularly. **Protect browser storage** requests persistence but is not a backup.
- No analytics, network image loads, or runtime third-party scripts/fonts. A hosted app requests its same-origin shell and offline assets only.

## Develop and test

Requires Node.js. The committed `index.html` is generated from `shell.html`, `styles.css`, and `app.js`:

```powershell
npm ci
npm run check
npm run build
npm test
```

Tests use Playwright and an installed Chrome browser, including mobile touch emulation, original-byte checks, portable file reopening, offline reloads, and stale-window protection. Test dependencies are not used by the app.

## GitHub Pages

Publish this folder in a separate `moodboard` repository. In **Settings → Pages**, select deployment from `main`, root directory. All paths work at `https://YOUR-USERNAME.github.io/moodboard/`. Increment the cache version in `sw.js` when publishing app updates.
