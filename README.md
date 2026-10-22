# UCL Learning System

A study site for **COMP0178 Database Fundamentals** at UCL. It rebuilds the lecture slides and lab sheets into one readable path, with worked examples, diagrams and a memory hook for every idea.

It's plain HTML and CSS with no build step and no dependencies, so it opens in any browser.

## What's inside

The site is split into parts. Section numbers match the slide numbers in the original decks, so you can switch between the site and the slides.

| Part | Page | Covers | Source |
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

## Viewing it

Open `index.html` in a browser.

Or use the startup file for your system. It serves the site on this computer and opens it in your browser:

- **Linux:** `./startup/linux.sh`
- **macOS:** double-click `startup/macos.command`, or run that file in Terminal
- **Windows:** double-click `startup/windows.bat`

Leave that window open while you study. The site is at <http://127.0.0.1:8000>. Press Ctrl+C in the window to stop the server.

You need Python 3.7 or newer. To use a different port, add it on the end, for example `./startup/linux.sh 8080`. The macOS and Windows files take the same argument.

If macOS refuses to open the startup file, right-click it and choose Open.

## How it's built

```
index.html, store.html, …   one page per part
assets/site.css             shared styles (UCL-style purple palette, DM Sans)
assets/site.js              scaling, sidebar highlighting, "Open all More detail"
startup/                    start the site on localhost (Linux, macOS, Windows)
```

- **Look:** modelled on [ucl.ac.uk](https://www.ucl.ac.uk/), with a white masthead, a dark-purple nav bar and footer, square cards and purple accents. Colours are defined once in `assets/site.css`.
- **Slide content:** each section's content (the `.canvas` block) is laid out at a fixed 1664px width with inline styles. `site.js` zooms it to fit the column. On narrow screens it switches to a stacked phone layout.
- **Navigation:** the part links in the purple bar and the footer are repeated in every page. If you add a new page, update them in all of them.

## Adding a part

1. Copy an existing part page, for example `seek.html`, and rename it.
2. Replace the hero, the sections, and the "On this page" lists. There are two lists, one for the desktop sidebar and one for phones.
3. Add the new page to the nav bar and footer in every page.
4. Add a card for it on `index.html`, and fix the Previous/Next links on the neighbouring pages.

## Notes

- These are personal study notes. They are not official UCL material, and the site is not affiliated with UCL. The content is based on the COMP0178 lecture slides and lab sheets.
- Use the original slides as the authority. If something here disagrees with them, the slides win, and please open an issue.
