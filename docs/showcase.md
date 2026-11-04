# Documentation screenshots

The README comparisons were captured in real Windows Terminal with Agent Math `0.2.0-preview.30`. They use synthetic assistant transcripts and terminal replays, not private sessions or a newly generated model response.

| Image | Example | Verified rendered regions |
| --- | --- | --- |
| [Codex comparison](images/codex-comparison.png) | Explicit LaTeX block containing the PPO clipped objective and probability ratio | 1 block |
| [Claude comparison](images/claude-comparison.png) | Unmarked mathematical code blocks containing an objective, probability ratio, and custom `sg[...]` function | 3 expressions |

Each pair captures the same terminal window and visible source before and after enabling the companion. The capture script checks that UI Automation text and crop geometry are unchanged, that the expected native overlays exist, and that mouse hit testing still reaches the original terminal. It does not typeset or paste formulas into the screenshots itself. Post-processing only crops the terminal content, stacks the two captures, and adds labels.

To reproduce on an available interactive Windows desktop:

```powershell
npm ci
npm run build:windows
npm run capture:showcase
```

The script opens a disposable `AgentMathResearch-Showcase-*` window, creates isolated synthetic Codex/Claude homes and an application profile under `.cache/`, captures both examples, and exits its own renderer and terminal fixture. It temporarily pauses an existing default companion and restores its enabled state and exact settings bytes afterward. It also attempts to restore the previous foreground window and cursor. No agent is started and no model request is sent.

Reviewed outputs are `docs/images/codex-comparison.png` and `docs/images/claude-comparison.png`. Original captures, synthetic transcript files, geometry records, and the capture report remain in ignored `.cache/` and `test-results/`. The two final images are explicit exceptions to the repository's general image ignore rules.
