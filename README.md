# UCL CS Learning System

A study portal for UCL Computer Science. It rebuilds lecture slides and lab sheets into readable study guides, one module at a time, with worked examples, diagrams and a memory hook for every idea. **Scribe** transcribes lectures as they happen.

The pages are plain HTML and CSS with no build step. One startup file, `start.py`, serves the portal on your computer and runs Scribe's transcription server. It needs Python 3.7 or newer and nothing else: there are no packages to install.

## Starting the portal

**Double-click `start.py`** in the portal folder. It serves the portal at <http://127.0.0.1:8000> and opens it in your browser. Leave the window open while you study. To stop, press Ctrl+C in it or close it.

If double-clicking opens the file in an editor instead, run it from a terminal in the portal folder:

- **Windows:** `py start.py`
- **macOS and Linux:** `python3 start.py`

To use another port, add it at the end, for example `python3 start.py 8080`.

Install Python from <https://www.python.org/downloads/> (on Windows, tick "Add python.exe to PATH"). The python.org installers also set up double-clicking: on Windows `.py` files run with Python, and on macOS they open in Python Launcher, which runs them in Terminal.

The module pages also open straight from the files (for example `modules/databases/index.html`), but Scribe and the xAI settings need `start.py`.

## What's inside

| Section | Where | What it is |
| --- | --- | --- |
| Portal home | `index.html` | Every module and tool, and how the portal works |
| Database Fundamentals | `modules/databases/` | COMP0178 (below) |
| Python Programming | `modules/programming/` | COMP0066 Introductory Programming (below) |
| Algorithmics | `modules/algorithmics/` | COMP0070 Algorithmics (below) |
| Scribe | `scribe.html` | Live transcription of lectures, saved on this computer |
| Settings | `settings.html` | Light, dark or system theme; the xAI key, model, price and budget for Scribe; where recordings are saved |

Every page starts with the same dark portal bar: the way home, Modules, Scribe, **Settings** and a light/dark switch.

On a module page, the module's name and its parts bar stay at the top of the screen. Once you scroll, the name shrinks to a slim strip. Click the name to switch to another module.

### Module: Database Fundamentals (COMP0178)

The module is split into parts. Section numbers match the slide numbers in the original decks, so you can switch between the guide and the slides.

| Part | Page (in `modules/databases/`) | Covers | Source |
| --- | --- | --- | --- |
| Overview | `index.html` | Roadmap of every part and section | — |
| 1 · Store | `store.html` | What a database is, DBMS, tables, keys, three-level architecture | Week 1 lectures |
| 2 · Speak | `speak.html` | SQL syntax: CREATE, INSERT, SELECT, joins, grouping | Week 1 lectures · **Lab 1 (SQL)** |
| 3 · Shape | `shape.html` | ER diagrams, mapping to tables, functional dependencies, normal forms | Week 2 lecture · **Lab 2 (design)** |
| 4 · Ship | `ship.html` | A small auction web app: schema, queries, PHP, SQL injection | Week 2 lecture |
| 5 · Seek | `seek.html` | Storage, blocks, buffers, indexes, B+ trees, hashing | Lecture 3a |
| 6 · Sigma | `sigma.html` | Relational algebra: σ, Π, ∪, −, ×, joins, division, aggregation | Lecture 3b |
| 7 · Setup | `setup.html` | Group project kit: Git for teams, MySQL scripts, connecting PHP safely | **Lab 3** (project tutorial 3) |
| Revision | `revision.html` | SQL cheat sheet, every memory hook, week 3 on one page | — |

Every section has the same shape:
- a slide-style summary with diagrams and examples;
- a **Remember** line to learn by heart;
- a **More detail** panel with the full explanation.

Most examples use the same small estate-agent database (six staff, four branches), so you can check every answer by hand.

### Module: Python Programming (COMP0066 Introductory Programming)

One part per lecture notebook, numbered in order through the module. Every example is real Python shown with exactly what it prints, and each section's **More detail** names the lecture slides it comes from.

| Part | Page (in `modules/programming/`) | Covers | Source |
| --- | --- | --- | --- |
| Overview | `index.html` | Roadmap of every part and section | — |
| 1 · Values | `values.html` | print, variables, naming, typing, numbers, strings, % formatting, casting | Lecture 1 |
| 2 · Decide | `decisions.html` | if/elif/else, input(), all seven groups of operators, precedence | Lecture 2 |
| 3 · Repeat | `loops.html` | for, range(), while, infinite loops, break/continue/pass, loop-else, nesting | Lecture 3 |
| 4 · Collect | `collections.html` | Lists, comprehensions, tuples, sets, dictionaries | Lecture 4 |
| 5 · Define | `functions.html` | String methods, mutability, functions, arguments, return, LEGB scope | Lecture 5 |
| 6 · Handle | `errors.html` | try/except/else/finally, files, access modes, reading and writing | Lecture 6 |
| 7 · Objects | `objects.html` | Classes, self, `__init__`, class/static methods, privacy, inheritance | Lecture 7 |
| 8 · Import | `modules.html` | Modules, imports, `__main__`, the standard library, packages, logging | Lecture 8 |
| 9 · Analyse | `data.html` | NumPy arrays, pandas Series and DataFrames | Lecture 9 |
| Revision | `revision.html` | Python on one page, every memory hook | — |

### Module: Algorithmics (COMP0070)

Built from the lecture notes *Algorithms and Data Structures* (sections 2–7) and Problem sheet 1. Algorithms are shown in the notes' pseudocode (arrays numbered from 1), and every one is traced by hand on the notes' own examples.

| Part | Page (in `modules/algorithmics/`) | Covers |
| --- | --- | --- |
| Overview | `index.html` | Roadmap of every part and section |
| 1 · Measure | `analysis.html` | Pseudocode, running time, orders of growth, GCD, Fibonacci, insertion sort |
| 2 · Structure | `structures.html` | Stacks, queues, graphs, connectivity, trees, traversals, heaps |
| 3 · Greedy | `greedy.html` | Customer queues, change, Kruskal, Prim, Dijkstra, travelling salesperson |
| 4 · Divide | `divide.html` | Binary search, MergeSort, QuickSort and its Pivot procedure |
| 5 · Dynamic | `dynamic.html` | Optimal substructure, binomial coefficients, Floyd, FloydPath, Warshall |
| 6 · Traverse | `search.html` | Depth-first search (recursive and with a stack), breadth-first search |
| Revision | `revision.html` | Every algorithm in one table, memory hooks, **Problem sheet 1** with worked answers |

The problem-sheet answers are inside each question's **More detail** panel, so you can try the question first.

## Settings

**Settings** is a page of its own, `settings.html`. It's linked from the portal bar at the top of every page, from the portal home, and from the gear button in Scribe.

- **Theme:** System, Light or Dark. It's kept in your browser and applies to every page and every open tab straight away. System follows your computer's setting. The moon/sun button next to Settings switches between light and dark directly.
- **xAI API key:** saved to `.env` in the portal folder. The browser never gets the full key back, only its last 4 characters.
- **Transcription model:** the list shows every speech-to-text model your key can use. The portal asks xAI for its model list, then tries each speech-to-text model by opening a stream and closing it again without sending audio (so it costs nothing), and lists the ones that work. **Latest** lets xAI choose its current default, so you get new versions automatically. **Custom…** takes any other name.
- **Test connection** checks the key and model the same free way.
- **Price per hour** and **Monthly budget** drive Scribe's spend tracker.
- **Saving recordings:** the folder Scribe saves to (type a path or press **Choose…** for your system's folder picker), whether to save the transcript, the audio or both, and their formats. See [Saving to a folder](#saving-to-a-folder).

The theme applies as soon as you pick it. Everything else is saved when you press **Save changes** in the bar at the bottom of the page, which shows when you've changed something. Leaving the page with unsaved changes asks first.

Pages opened as files can still switch theme. The xAI and saving settings need `start.py`.

## Scribe: live transcription

Scribe writes down speech as it is spoken, using xAI's streaming speech-to-text, and saves each transcript on this computer.

```
Browser (mic → 16-bit PCM) ──WS──▶ server/serve.py (holds the key) ──WSS──▶ wss://api.x.ai/v1/stt
        ▲                                 │
        └──── live + final text ◀─────────┤
                                          ▼
                                .scribe/transcripts.db (SQLite)
```

1. Start the portal with `start.py` and open **Scribe** in the portal bar.
2. The first time, Scribe asks for your xAI key. Open **Settings**, paste the key (get one at <https://console.x.ai> → API Keys), press **Save changes**, then **Back to Scribe**.
3. Press **Start** and allow the microphone. Grey text is what Scribe is still hearing; each finished line is saved with its timestamp. With **Speaker labels** on, lines are split by speaker.
4. Press **Stop** to finish. Scribe waits for the last line before it closes the recording.

Leaving the page ends a recording, so while one is running Scribe asks before you leave, and its gear button opens Settings in a new tab. Settings saved in another tab reach Scribe straight away.

Every recording is listed in the sidebar. Search finds words in titles and transcripts. Click the title of an open transcript to rename it, or copy it, export it as `.txt` or `.md`, or delete it.

### Saving to a folder

With **Save to folder** switched on (next to Speaker labels), each recording is also saved as files in a folder of your choice: `Documents/Scribe` unless you pick another in Settings.

- The switch is read when you press **Start** and can't change mid-recording. If the folder can't be used (missing drive, no permission), Scribe says so and doesn't start, so nothing is spent.
- Both files share a name made of the start time and the title, for example `2026-11-01 17.34 Lecture 3a.md` and `2026-11-01 17.34 Lecture 3a.webm`. Rename a recording in Scribe and its files follow, once it has finished.
- **Transcript:** Markdown or plain text, rewritten each time a line is finished.
- **Audio:** what your microphone heard. **Compressed** is recorded by the browser (WebM/Opus in Chrome, Edge and Firefox; M4A in Safari), about 15 MB an hour. **WAV** is uncompressed, about 350 MB an hour, and plays and seeks in every player; some players can't seek in the compressed files.
- Files are written while you record, so closing the window mid-lecture keeps everything up to that point.
- **Show in folder** opens the files in your file manager. Deleting a recording in Scribe doesn't delete its saved files.
- Scribe's own copy (below) is kept either way, so the Recordings list and search work whether or not you save to a folder.

### Where Scribe keeps its own copy

Every transcript is stored in `.scribe/transcripts.db` (SQLite) in the portal folder. That's what the Recordings list, search and export use. Audio is only kept if you save it to a folder.

### Spend tracker

The card at the bottom of the Recordings list shows roughly how much you've spent this month. Click it for today, this month, all time, and a day-by-day table for the last 30 days. Each recording shows its own length and cost, and the cost so far appears next to the timer while you record.

- Cost = audio length × price per hour (default **$0.20/hour**, xAI's streaming price). The length is the duration xAI reports at the end of a recording, or the amount of audio sent if the recording ended abruptly. It's saved every 10 seconds, so closing the window mid-recording still counts.
- With a monthly budget set, a progress bar appears on the card, and you're asked to confirm before starting a recording once you've reached the budget.
- It's an **estimate** from this portal only. Other apps using the same key aren't included. Your exact balance is in the xAI console under Billing.

### Options (`.env`)

The Settings page writes this file for you. You can also edit it by hand; restart `start.py` afterwards.

| Variable | Default | |
| --- | --- | --- |
| `XAI_API_KEY` | — | Required for Scribe. Easiest to set in Settings |
| `XAI_STT_MODEL` | empty (xAI's default) | Also set in Settings |
| `XAI_STT_PRICE_PER_HOUR` | `0.20` | USD, for the spend estimate. Also set in Settings |
| `MONTHLY_BUDGET_USD` | none | Also set in Settings |
| `SCRIBE_SAVE_DIR` | `Documents/Scribe` | Folder for saved recordings. Also set in Settings |
| `SCRIBE_SAVE_TRANSCRIPT` | `1` | `0` saves no transcript file. Also set in Settings |
| `SCRIBE_SAVE_AUDIO` | `1` | `0` saves no audio file. Also set in Settings |
| `SCRIBE_TRANSCRIPT_FORMAT` | `md` | `md` or `txt`. Also set in Settings |
| `SCRIBE_AUDIO_FORMAT` | `compressed` | `compressed` or `wav`. Also set in Settings |
| `DB_PATH` | `.scribe/transcripts.db` | Scribe's own copy, relative to the portal folder |
| `DEBUG_EVENTS` | off | `1` prints every raw xAI event in the `start.py` window |

### Privacy

- The server only listens on this computer (`127.0.0.1` and `::1`).
- Scribe's API only answers pages the portal serves itself, so other websites open in your browser can't read your transcripts or spend your key.
- `.env` and `.scribe/` are hidden from the web server and ignored by Git.
- Saved recordings go to your chosen folder, which the web server never serves.

## How it's built

```
start.py                    the one startup file: serves the portal and runs Scribe
index.html                  portal home
scribe.html                 Scribe, the live-transcription page
settings.html               Settings for the whole portal
modules/databases/          Database Fundamentals: index.html (overview), store.html, …, revision.html
modules/programming/        Python Programming: index.html, values.html, …, data.html, revision.html
modules/algorithmics/       Algorithmics: index.html, analysis.html, …, search.html, revision.html
assets/site.css             shared styles: UCL-style palette, DM Sans, light and dark themes
assets/portal.js            theme switching, plus the module header and switcher; loaded by every page
assets/settings.js          the Settings page: theme choice, xAI key and model, saving options
assets/site.js              slide scaling, sidebar highlighting, "Open all More detail"
assets/scribe.js            Scribe's page: recording, transcript, spend tracker
assets/pcm-worklet.js       turns mic audio into 100 ms chunks of 16-bit PCM
assets/favicon.svg          the CS mark
server/serve.py             serves the portal on localhost and passes /api/ and /ws/ to Scribe
server/scribe.py            Scribe's API, the xAI settings and model list, and the relay to xAI
server/scribe_db.py         SQLite tables for recordings (sessions) and their lines (segments)
server/scribe_files.py      saving recordings to your folder, the folder picker, "Show in folder"
server/websocket.py         a small WebSocket implementation, so nothing needs installing
```

- **Look:** modelled on [ucl.ac.uk](https://www.ucl.ac.uk/). A dark portal bar sits above a white masthead with the section's name, then a dark-purple nav bar and footer, with square cards and purple accents. Colours are tokens in `assets/site.css`; dark mode swaps the tokens.
- **Dark mode for slide content:** each section's content (the `.canvas` block) uses inline colours. `site.css` maps every one of them, and the colours in its diagrams, to a dark equivalent. If you add a slide with a new colour, add a line for it in the "dark mode for the slide content" block.
- **Slide content:** laid out at a fixed 1664px width with inline styles. `site.js` zooms it to fit the column. On narrow screens it switches to a stacked phone layout.
- **Navigation:** the portal bar, nav bar and footer are repeated in every page. If you add a page, update them in all of them.
- **Module header:** on module pages the masthead and parts bar sit together in a `site-head` block that stays at the top. `portal.js` adds the `compact` class once you scroll, which shrinks the masthead. The module's name is a `<details class="mod-switch">` whose menu lists every module, so switching works even without JavaScript.
- **Code:** Python examples are dark boxes and their output sits in a grey box underneath. Pseudocode is in a light purple box. Code fonts have ligatures turned off, so `!=` and `<=` look exactly as you type them.

## Adding a module

1. Make a folder in `modules/`, for example `modules/architecture/`, and build it like the other modules. Each page needs the portal bar, the `site-head` block (masthead with the module switcher, then the nav bar with its parts), and `../../assets/` paths. Load `portal.js` in the `<head>` so the theme and the header work.
2. Add the new module to the switcher menu (`mod-menu`) on every module page, so you can reach it from the others.
3. On `index.html`, add a module card under **Modules**, a link in the nav bar, and a link in the footer. Add the same nav and footer links on `scribe.html` and `settings.html`.

## Adding a part to a module

1. Copy an existing part page in the module, for example `modules/databases/seek.html`, and rename it.
2. Replace the hero, the sections, and the "On this page" lists. There are two lists, one for the desktop sidebar and one for phones.
3. Add the new page to the module's nav bar and footer, in every page of the module.
4. Add a card for it on the module's `index.html`, update the module card on the portal home, and fix the Previous/Next links on the neighbouring pages.

## Notes

- These are personal study notes. They are not official UCL material, and the portal is not affiliated with UCL. The modules are based on the lecture slides, notes, notebooks, lab sheets and problem sheets of COMP0178, COMP0066 and COMP0070.
- Use the original slides as the authority. If something here disagrees with them, the slides win, and please open an issue.
