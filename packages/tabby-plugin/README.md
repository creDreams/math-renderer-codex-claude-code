# Tabby Agent Math 0.1 preview

Render complete LaTeX display blocks inside verified Codex assistant replies as local SVG overlays.
Supports Tabby **1.0.238 on Windows**. Preview: other versions/platforms are unverified.

Extract this package into the directory opened by Tabby's **Settings → Plugins → Open Plugins Directory**:
`node_modules/tabby-agent-math/`, with `package.json` directly inside it. Restart Tabby.
Run your existing `codex` command in a local Tabby terminal. Right-click the terminal for the rendering toggle and matching status.

The plugin observes xterm and reads local Codex rollout files under `$CODEX_HOME/sessions`
(default `~/.codex/sessions`). It renders only when a complete assistant message uniquely agrees
with a session in the terminal's current working directory. Selection reveals the original buffer text.
Disabling the toggle immediately reveals the source. It does not rewrite terminal I/O, invoke Codex,
create a PTY, or make network requests.

Supports complete `\[...\]` and raw `$$...$$` blocks outside code fences, using base/AMS TeX.
Codex 0.166.0 on the tested machine already converts dollar blocks into character math;
the plugin preserves that display. Inline math, incomplete/ambiguous/clipped messages and formulas
that cannot fit at readable size remain as source. Full assistant message matching is conservative;
complex Markdown can fall back to source. Transparent terminal backgrounds are not a tested configuration.

To uninstall, close Tabby and move this directory outside `node_modules`, then restart.
The project's install/uninstall scripts automate this and retain a backup.
