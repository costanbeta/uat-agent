# UAT agent

Design UAT for one screen at a time: compare a staging page (behind login) with its Figma frame, write UAT sheet rows with evidence screenshots, and re-check the same rows after devs fix them.

Design doc: `docs/designs/design-uat-agent.md`. Open items: `TODOS.md`.

## One-time setup

```bash
npm install
npx playwright install chromium
cp staging.config.example staging.config   # list your STAGING origin(s) only
```

Log in once with the dedicated browser profile (a Chrome window opens; you sign in yourself, the tool never sees your password):

```bash
npm run uat -- login --url https://<staging-host>/<screen> --expect "<selector visible only when logged in>"
```

## Use it (in Claude Code, from this folder)

```
/uat-check <staging-url> <figma-url>          # round 1 for one screen
/uat-recheck <exported-sheet.csv> <screen>    # after devs fix issues
```

`/uat-check` needs the Figma MCP server authorized (`/mcp`). Output goes to `uat-out/<screen>/`: the CSV in your sheet columns (plus `UAT ID`, `Needs human look`, `Tool verdict (round N)`), a delta CSV for merging into the live sheet by UAT ID, and one boxed screenshot per row under `evidence/roundN/`.

## What it guards

- Refuses origins not in `staging.config`, login redirects, HTTP errors, a missing `--expect` landmark and password screens (zero rows written).
- Blocks PUT, PATCH, DELETE and any POST not in `--allow-post` at the network layer, and lists what was blocked. It does not stop state-changing GET requests, WebSockets or beacons: use a staging test account.

## v1 limits

- One screen per run; hover, empty and modal states need an action file (YAML list of `hover:`, `click:`, `wait:` steps).
- Evidence is local PNGs. Upload them yourself, then `npm run uat -- set-links --root uat-out --screen <slug> --links links.json`. Google Drive upload is not wired up.
- The judgment runs in your Claude Code session (not a restricted subagent), because Figma MCP images are not available to subagents. Page text is treated as data by the skill instructions and by validation, but that is not isolation.
- CSV layout follows your Table3 sheet (open decision CQ4 in the design doc).

## Tests

```bash
npm test          # unit, Chromium guard tests against a local fixture server, CLI round trip
npm run typecheck
```
