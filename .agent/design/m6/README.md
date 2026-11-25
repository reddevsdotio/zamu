# M6 to M8 design: work record, pull requests, archiving, check-again dates, waves and gates

One design pass for three releases, in the Margin direction from M5. All three are designed; M6 was reviewed and approved on 2026-11-25.

- **Canvas** (the M5 canvas, three new pages):
  - M6: https://claude.ai/artifact/Qf4nELj16FMAKRzSWei9z5#page-m6-M6---Work-record
  - M7: https://claude.ai/artifact/Qf4nELj16FMAKRzSWei9z5#page-m6-M7---Pull-requests--archive--check-again
  - M8: https://claude.ai/artifact/Qf4nELj16FMAKRzSWei9z5#page-m6-M8---Waves-and-gates

## What's here

| Path | What it is |
|---|---|
| `brief.md` | The brief for all three releases |
| `screens/` | 126 PNGs, every frame of the three canvas pages in order |
| `source/m6/` | Canvas sources for all three releases: one `.dc.html` per component, the three canvas pages, a harness, and `m6.css`, `m7.css`, `m8.css` |
| `components.md` | The new components and their states, with the frames that show them |
| `shortcuts.md` | Keys proposed for the new actions, with conflicts resolved |
| `notes.md` | Changes to the brief, calls made in the design, answers and open questions |

No token was added in any of the three releases: the stylesheets use the M5 tokens only, so there is no new tokens file.

## Screen names

`<n>-<release>-<section>-<component>-<theme>-<state>[-1280].png`, numbered in canvas order: each section's light frames come first, then its dark frames.

| Frames | Release | Section | Brief screens |
|---|---|---|---|
| 001–008 | M6 | Task view with the work record (in review, at 1280, just started, nothing set) | 1, 2, 3 |
| 009–012 | M6 | Editing criteria (reword, focus, add; waive with a reason) | 4 |
| 013–018 | M6 | Timeline (all, notes only with the note switch, history with machine and branch) | 5, 8 |
| 019–020 | M6 | Finishing with open items | 6 |
| 021–022 | M6 | Mirrored task | 7 |
| 023–024 | M6 | Compact progress on rows, cards and the peek | 9 |
| 025–030 | M6 | Project settings, Task defaults | 10 |
| 031–046 | M6 | Switch to Zamu | 11 |
| 047–050 | M6 | Long content | 12 |
| 051–056 | M7 | Pull requests on a task (one open, every state, branch only) | 13 |
| 057–062 | M7 | Linking by hand (recognised, not a request, another repository) | 14 |
| 063–068 | M7 | Merged with open criteria: the task with its history, Home Mine and Everyone | 15, 16 |
| 069–080 | M7 | Project settings, Repository | 17 |
| 081–094 | M7 | Archived tasks: the setting, the list, archiving by hand, search, an archived task | 18, 19 |
| 095–100 | M7 | Check-again date: picker, waiting, the day has come | 20, 22 |
| 101–102 | M7 | Markers on rows, cards and the peek; Display options; waiting tasks on a board | 21, 22 |
| 103–106 | M8 | Milestone with waves, also at 1280; the plan link | 23, 30 |
| 107–112 | M8 | Gates: recording a result, failed, all passed | 24, 25, 28 |
| 113–116 | M8 | Editing waves; starting a task in a locked wave | 26, 27 |
| 117–120 | M8 | A milestone without waves; the milestone list | 28, 29 |
| 121–126 | M8 | Long content, loading, error | 31 |

## Opening the sources locally

The pages load the M5 stylesheets, sample data and runtime by relative path, so serve a folder that holds both:

```sh
mkdir -p /tmp/zamu-canvas && cd /tmp/zamu-canvas
cp -r <repo>/.agent/design/m5/round2/source/. . && cp -r <repo>/.agent/design/m6/source/m6 .
python3 -m http.server 8000
# a canvas:   http://localhost:8000/m6/M6%20%C2%B7%20Work%20record.dc.html
# one frame:  http://localhost:8000/m6/_Harness.dc.html#task-dark-review   (#<key>-<theme>-<state>)
```

Harness keys: `task`, `marks`, `set` (M6); `t7` task, `home`, `s7` settings, `l7` list, `k7` markers (M7); `plan` (M8). The states are listed in each file's `data-props`.
