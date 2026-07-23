# Mo's Management

An offline-first client formula tracker for a hairstylist. Vanilla HTML/CSS/JS — no
frameworks, no build step, and no network requests of any kind after the first load.

## Deploy to GitHub Pages

1. Create a repo and push the contents of this folder to it (`index.html` at the repo root).
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → branch `main`, folder `/ (root)`.
3. Wait for the green check, then open the published URL **in Safari on the iPhone**.
4. Tap the Share button → **Add to Home Screen**.

Everything is relative-pathed, so it works from a project page
(`user.github.io/repo/`) as well as a root domain.

> HTTPS is required for the service worker. GitHub Pages serves HTTPS by default.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | All five screens plus the overlays (action sheet, confirm, toast) |
| `styles.css` | Pastel-pink theme, safe-area handling, no-bounce layout |
| `app.js` | State, IndexedDB wrapper, rendering, gestures, backup/import |
| `sw.js` | Precaches every asset so the app runs forever offline |
| `manifest.json` | Standalone, portrait, pink theme |
| `icons/` | App icons (rounded "M" on soft pink) |

## After you edit any file

The service worker serves from cache first, so a changed file will not reach an
installed app until the cache name changes. Bump the version in `sw.js`:

```
var CACHE = 'mos-management-v2';
```

The next launch installs the new version and deletes the old cache.

## How it stores data

All clients and folders live in **IndexedDB** on the device. The wrapper in `app.js`
resolves rather than throws on every operation: if a write fails, the change still
applies in memory, a small message appears, and the app keeps running.

Nothing is ever sent anywhere. That makes **Settings → Back Up Now** the only copy
insurance — it writes a dated JSON file (share sheet on iPhone, download elsewhere).
**Import Backup** reads one back, replacing what is on the device after a confirm.

## Notes on the interaction details

- The list renders 60 rows at a time and grows as you scroll, so a keystroke in the
  search box costs the same at 5 clients or 5,000.
- Names are folded to a plain lowercase key once, at save time — so "Émile" sorts and
  groups under **E** and is found by typing "emile".
- Swipe a row left, or long-press it, to delete. Both ask first.
- Deleting a folder never deletes its clients; they move to All Clients.
