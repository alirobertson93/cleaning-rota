# Cleaning Rota

A small static web app for a shared house cleaning rota. Replaces the "Cleaning Rota" Google Sheet.

- **My tasks** (`#/`) — each housemate picks their name once per device, then sees only their tasks for the week, grouped by room, and ticks them off.
- **Everyone** (`#/house`) — the whole house's allocation and live progress. Anyone can tick anything; if someone other than the assignee ticks a task it shows "Done by …".
- **Person page** (`#/person/<id>`) — shareable link to one housemate's list.
- **Admin** (`admin/`, a separate unlisted page) — housemates (add / rename / reorder / remove / colour), zones and rooms, tasks and their frequencies (each with a "next 2N occurrences per housemate" tally from `tallyUpcoming()` and an expandable "next 6 due weeks and who has it" list from `upcoming()`), an 8-week rotation preview, a "nudge rotation" control, settings and JSON backup. Not linked from the housemate page and has no password: anyone who knows the URL can edit. The housemate page never mentions it.

No build step. Plain HTML/CSS/ES modules; Firebase (Firestore + anonymous Auth) loaded from the gstatic CDN.

## Allocation model

Same as the original sheet, generalised:

- Rooms belong to **zones**. Zones rotate between housemates weekly, in housemate order.
- In week index `w` (whole weeks since `config.anchor`, a Monday), the zone at position `z` is held by person `people[mod(z - w - rotationShift, N)]`.
  - `N > zones` → `N − zones` people have a week off each week.
  - `N < zones` → some people hold more than one zone.
- A task is due when `mod(w - task.offset, task.every) === 0`.
- `anchor` defaults to `2025-01-20` — the sheet's first week — so the rotation carries on exactly where the sheet would be (verified in `tests/schedule.test.mjs` against the sheet's FULL tab).
- Seeded tasks all have `offset: 0`, matching the sheet: every occasional task is due in the anchor week and every `every` weeks after (so all 3-weekly tasks land in the same week). When a task is added or its frequency changes, `offsetStartingAt()` sets the offset so it is due in the current week.
- `rotationShift` changes who holds which zone without changing which tasks are due. Admin → Rotation lets you nudge it; adding/removing people or zones re-picks it via `stableShift()` so as few of the current week's assignments change as possible.
- With `N` housemates, a task every `k` weeks only ever reaches `N / gcd(k, N)` people (e.g. every 4 weeks with 4 people → always the same person). Admin → Tasks warns about this.

All of that lives in `js/schedule.js` (pure, no DOM — tested with `node --test`).

## Data (Firestore)

| Path | Contents |
|---|---|
| `rota/config` | `{ houseName, anchor, rotationShift, people[], zones[], rooms[], tasks[] }` |
| `weeks/{YYYY-MM-DD}` | `{ done: { [taskId]: { by: personId, at: timestamp } } }` — one doc per week, keyed by Monday |

Allocations are computed client-side and never stored, so admin changes apply immediately (including to the current and past weeks' display). Completion history is keyed by task id and person id, so renames are safe.

There is no admin authentication. `admin/index.html` sets `<body data-page="admin">`; `js/app.js` renders the admin UI only in that mode and ignores admin actions otherwise. Security is by obscurity only (plus `noindex`). To make the URL harder to guess, rename the `admin/` folder — nothing else references it. Seeding (`createConfig`) is only offered on the admin page; housemates see "Nothing here yet" while the database is empty.

## Files

```
index.html             housemate page
admin/index.html       admin page (same app, data-page="admin"; paths are ../)
css/styles.css         all styles (light + dark)
js/app.js              views, routing, events
js/schedule.js         allocation logic (pure)
js/store.js            Firebase / demo (localStorage) storage adapters
js/seed.js             the 52 tasks / 5 rooms / 3 zones / 4 people from the sheet
js/firebase-config.js  your Firebase web config (null = demo mode)
js/vendor/             idiomorph 0.3.0 (BSD-2) — DOM morphing so re-renders keep focus/taps/open selects
firestore.rules        security rules to paste into Firebase
tests/                 node --test
```

## Run locally

```sh
npm start        # python3 -m http.server 8080 → http://localhost:8080
npm test         # scheduling tests
```

With `firebaseConfig = null` the app runs in **demo mode**: data lives in this browser's localStorage only.

## Going live

Three parts, about 15 minutes in total: **A** create the Firebase database, **B** connect the app to it, **C** publish the site on GitHub Pages. Do them in order.

### A. Create the Firebase database

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with your Google account.
2. Click **Create a project** (or **Add project**).
   - Name: anything, e.g. `cleaning-rota`. Click **Continue**.
   - If asked about Gemini or Google Analytics, turn them **off**. Click **Create project**, wait, then **Continue**.
3. Turn on the database:
   - Left menu: **Build → Firestore Database** → **Create database**.
   - If asked for an edition, choose **Standard**.
   - Location: `europe-west2 (London)` (or whatever is nearest). This can't be changed later.
   - Choose **Start in production mode** → **Create**.
4. Set the security rules:
   - Still in Firestore Database, open the **Rules** tab.
   - Delete everything in the editor.
   - Open `firestore.rules` from this folder in a text editor, copy all of it, and paste it in.
   - Click **Publish**.
5. Turn on anonymous sign-in (this is what lets housemates use the app without accounts):
   - Left menu: **Build → Authentication** → **Get started**.
   - **Sign-in method** tab → **Anonymous** → switch **Enable** on → **Save**.
6. Get the app's connection details:
   - Click the **cog** next to "Project Overview" (top left) → **Project settings**.
   - Scroll to **Your apps** → click the **`</>`** (Web) icon.
   - Nickname: `rota`. Leave "Firebase Hosting" **unticked**. Click **Register app**.
   - You'll see a block of code containing `const firebaseConfig = { apiKey: "...", authDomain: "...", ... };`. Copy just the `{ ... }` part. Click **Continue to console**.

These values are not secret — they identify the project; the rules from step 4 control access.

### B. Connect the app

7. Open `js/firebase-config.js` and replace `null` with the `{ ... }` you copied, so it reads:

   ```js
   export const firebaseConfig = {
     apiKey: '…',
     authDomain: '…',
     projectId: '…',
     storageBucket: '…',
     messagingSenderId: '…',
     appId: '…',
   };
   ```

8. Optional local check: `npm start`, open http://localhost:8080/admin/ — the yellow "Demo mode" banner should be gone and you should see **Set up your rota**. (Don't press the button yet if you'd rather do it on the live site; either is fine — it's the same database.)

### C. Publish on GitHub Pages

9. Go to [github.com/new](https://github.com/new).
   - Repository name: e.g. `cleaning-rota`. This becomes part of the address.
   - **Public** (GitHub Pages is free for public repos; the repo contains no secrets).
   - Don't add a README, .gitignore or licence. Click **Create repository**.
10. Put the files in it — either:
    - **Upload in the browser:** on the new repo page click **uploading an existing file**, drag in *everything inside* this folder (`index.html`, `admin`, `css`, `js`, `icon.svg`, `firestore.rules`, `README.md`, `package.json`, `tests`), then **Commit changes**; or
    - **git:** `git init -b main && git add . && git commit -m "Cleaning rota" && git remote add origin git@github.com:<user>/<repo>.git && git push -u origin main`.
11. In the repo: **Settings → Pages**. Under **Build and deployment**: Source **Deploy from a branch**, Branch **`main`**, folder **`/ (root)`** → **Save**.
12. Wait a minute or two, then refresh the Pages settings screen. It shows **"Your site is live at `https://<user>.github.io/<repo>/`"**.
13. Back in Firebase: **Authentication → Settings → Authorized domains → Add domain** → `<user>.github.io` → **Add**.

### D. First run

14. Open `https://<user>.github.io/<repo>/admin/` (note `/admin/` on the end). Press **Start with our current rota**. Bookmark this page — it's the only way back to admin.
15. Open `https://<user>.github.io/<repo>/` (no `/admin/`), pick your name, check it looks right.
16. Send that second link to the house. Each person picks their name once per phone. On iPhone: Share → **Add to Home Screen** makes it open like an app.

### If something goes wrong

| You see | Fix |
|---|---|
| Yellow "Demo mode" banner on the live site | `js/firebase-config.js` still says `null`, or the change wasn't uploaded. |
| "The database refused access" | Rules not published (step 4). |
| "Anonymous sign-in is turned off" | Step 5. |
| "Still can't reach the database" | Check `js/firebase-config.js` matches step 6 exactly; check step 13. |
| GitHub page shows 404 | Wait a few minutes after step 11; make sure `index.html` is at the top level of the repo, not inside a folder. |

Any static host works instead of GitHub Pages (Firebase Hosting, Netlify, …) — there is no build step.
