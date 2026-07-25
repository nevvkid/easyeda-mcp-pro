# Plan — Net-class / design-rule MCP tools (+ how to run this fork locally)

**Goal:** add MCP tools that create & manage **net classes**, **differential pairs**, and **net rules** (width/clearance/impedance) on the active EasyEDA Pro PCB — so things like the TBD main-board F5 (DIGI_POWER/AUDIO_POWER classes + 90 Ω USB pairs) can be driven from the MCP instead of hand-editing the Net Class Manager.

**Feasibility: confirmed.** EasyEDA's extension API exposes the full surface via `eda.pcb_Drc` — verified live with `easyeda_api_inventory` and against the official [PCB_Drc reference](https://prodocs.easyeda.com/en/api/reference/pro-api.pcb_drc.html). The fork already wraps `PCB_Drc.check` (DRC); it just doesn't wrap the write methods yet.

---

## Part A — Run THIS fork locally (prerequisite)

Today the MCP that's actually running is the **global npm install** (`/opt/homebrew/lib/node_modules/easyeda-mcp-pro`, v0.35.1), **not** this fork (v0.35.4). Two things must point at the fork: (1) the **server** the MCP client spawns, and (2) the **extension** imported into EasyEDA Pro. Both must be version-matched, or `easyeda_health_check` reports `extension_version_mismatch`.

### A1. Build the fork
```bash
cd /Users/jlo/Documents/GitHub/easyeda-mcp-pro
corepack enable && corepack prepare pnpm@11.5.1 --activate   # pnpm 11.5.1, Node 24.18.0 (see .nvmrc)
pnpm install --frozen-lockfile
pnpm build              # sync versions + compile TS → dist/index.js
pnpm build:extension    # build the bridge extension → its dist + packaged .eext
```

### A2. Point the MCP client(s) at the fork's server
**Claude Code** — edit the consuming repo's `.mcp.json` (e.g. `tbd-hardware/.mcp.json`), change the args path:
```json
{ "mcpServers": { "easyeda-mcp-pro": {
  "command": "/opt/homebrew/opt/node@24/bin/node",
  "args": ["/Users/jlo/Documents/GitHub/easyeda-mcp-pro/dist/index.js"],
  "env": { "TOOL_PROFILE": "pro" }
}}}
```
**Codex** — same change in `~/.codex/config.toml` (`args = [ ".../easyeda-mcp-pro/dist/index.js" ]`).
Then reload the client (Claude Code: Developer → Reload Window) so it re-spawns the server from the fork.

### A3. Re-import the fork's extension into EasyEDA Pro
The net-class write methods live in the **extension dispatcher**, so the extension must be the fork's build.
- EasyEDA Pro → Settings → Extensions → Extension Manager → **Import** the fork's `.eext` (produced by `pnpm build:extension`; if a separate pack step is needed, see `easyeda-bridge-extension/` + `scripts/`).
- Enable **Allow External Interaction**; **Connect** (or Auto-Connect).

### A4. Verify the fork is live
- `easyeda_health_check` → `bridge_connected: true`, `version: 0.35.4`, **no** `extension_version_mismatch`.
- `easyeda_run_self_test` → confirms `method_registry_match` (extension dispatch matches server expectations — catches a stale extension).
- **Gotcha (we hit this before):** only one EasyEDA bridge binds to one server instance. Make sure the **old global server isn't also running** and that EasyEDA connected to the fork's port — `lsof -nP -iTCP -sTCP:LISTEN | grep 4962`, kill any stale `node …/lib/node_modules/easyeda-mcp-pro/…` process, reconnect.

### A5. Fast dev loop (optional, for iterating on this feature)
The extension is split into a **loader** (`easyeda-bridge-extension/src/index.ts`, imported once) and a **dispatcher** (hot-swapped live):
```bash
pnpm --filter @easyeda-mcp-pro/bridge-extension build:dev   # one-time: build dev extension, import that .eext
pnpm dev:hotloop                                            # terminal 1: server + dispatcher hot-swap watch
pnpm dev:extension                                          # terminal 2: rebuild dispatcher on save
```
Dispatcher edits reload live (no re-import); only re-import the `.eext` when the **loader** changes. `easyeda_run_self_test` fails loudly if the served dispatch is stale.

> Keep a way back: to revert to the official install, point the configs back at `/opt/homebrew/lib/node_modules/easyeda-mcp-pro/dist/index.js` and re-import the official `.eext`.

---

## Part B — Feature implementation spec

### B1. API basis (from the live inventory + prodocs)
`eda.pcb_Drc` methods & signatures:
```
createNetClass(netClassName, nets, color)              // nets = string[] of net names; color = hex
addNetToNetClass(netClassName, net)
removeNetFromNetClass(netClassName, net)
getAllNetClasses()                                     // read-back for verify
modifyNetClassName(originalName, newName)
deleteNetClass(netClassName)
createDifferentialPair(name, positiveNet, negativeNet)
getNetRules() / overwriteNetRules(netRules)            // width/clearance/impedance config object
overwriteNetByNetRules(netByNetRules)
```
> Types (array vs csv, color format, netRules object shape) are documented as *names/order only* — **confirm live** (see B5), exactly how the existing `PCB_Primitive*.create` signatures were "live-confirmed" (`pcb-write-operations.ts`).

### B2. Extension changes (`easyeda-bridge-extension/src/`)
- New `pcb-netclass-operations.ts` mirroring `pcb-write-operations.ts`: functions `createNetClass`, `addNetToNetClass`, `listNetClasses`, `createDiffPair` calling `callFirst(['PCB_Drc.createNetClass'], name, nets, color)` etc.
- Wire into `dispatcher.ts`: add method names to the allow-list array (near `'pcb.addTrack'`), add `case 'pcb.createNetClass':` etc. in the switch, and construct the ops in the toolkit init block (like `designRuleCheckOperations`).
- Add dispatcher unit tests (`tests/dispatcher.test.ts` pattern: `makeToolkit({ PCB_Drc: { createNetClass } })` and assert `callFirst` args).

### B3. Server (MCP) changes (`src/`)
- New tool file `src/tools/L1_pcb_net_class.ts` (or extend `L1_design_rules.ts`) with Zod input schemas + handlers that send the bridge method + return the result. Proposed tools:
  - `easyeda_pcb_create_net_class(projectId, name, nets[], color?)`
  - `easyeda_pcb_add_net_to_class(projectId, name, net)`
  - `easyeda_pcb_list_net_classes(projectId)`
  - `easyeda_pcb_create_diff_pair(projectId, name, positiveNet, negativeNet)`  *(pairs already exist on our board — mostly a completeness/verify tool)*
  - *(tier-2)* `easyeda_pcb_set_net_rules(...)`
- Register in `src/tools/register.ts` / `registry.ts`; assign to the **`pro`** profile; add tool metadata (the `lint:tools` / `verify:tool-coverage` gates require it).
- Add server-side tool tests (`tests/unit/tools/…`).

### B4. Docs / gates
- Update capability docs (`pnpm generate:capability-docs`), tools doc (`pnpm generate:tools-doc`), README tool tables.
- The PR must pass `pnpm verify` (format, typecheck ×2, lint, lint:tools, tool-coverage, tests ×2, build ×2, secrets, metadata, docs:build).

### B5. Live-confirm step — DONE 2026-07-25 (via `easyeda_api_call`, full profile, on the TBD Main PCB) ✅
**The whole feature already works today** through the existing `easyeda_api_call` tool (profile `full`, `confirmWrite=true`) — no new code strictly required to *use* it; the dedicated tools are UX/`pro`-profile sugar. Confirmed against `@jlceda/pro-api-types@0.3.5` `index.d.ts` + live calls:

- `createNetClass(netClassName: string, nets: string[], color)` → `Promise<boolean>`. **`@beta`.**
- **`color` is an RGBA OBJECT, not a hex string:** `{ r: number; g: number; b: number; alpha: number } | null`. Passing `"#ff8800"` returns `null`/no-op (the silent-fail we hit); passing `{r,g,b,alpha}` returns `true` and the class appears.
- **alpha is 0–255-scaled on the way in** (passed `alpha:1` → read back `0.0039 = 1/255`). Use `alpha:255` for opaque, or `null` color.
- `getAllNetClasses()` → `Array<{name, nets:string[], color:{r,g,b,alpha}|null}>` (`IPCB_NetClassItem`). Read-only but the `api_call` tool still demands `confirmWrite=true` (blanket gate).
- `addNetToNetClass(name, net: string | string[])`, `removeNetFromNetClass(name, net: string|string[])`, `deleteNetClass(name)`, `modifyNetClassName(old, new)` — all `Promise<boolean>`.
- `createDifferentialPair(name, positiveNet, negativeNet)` → `Promise<boolean>`.
- Live sequence run: `getAllNetClasses`→`[]`; `createNetClass('MCP_TEST',['+5V','+3.3V'],{r:255,g:136,b:0,alpha:255})`→`true`; read→class present; `deleteNetClass('MCP_TEST')`→`true`; read→`[]`. **Design left unchanged.**
- Bonus confirmed read: `getAllRuleConfigurations()` returns the JLCPCB capability presets (Two/Single/Multiple-Layer, High-Freq, …) — the width/clearance/impedance surface for tier-2.

**Implication for the dedicated tool:** schema takes `color` as `{r,g,b,alpha}` (or accept a hex string and convert, alpha→255); the extension op just forwards to `PCB_Drc.createNetClass`. Signatures are now certain, so the `pro` tool can be written without further probing.

---

## Part C — Scope tiers
- **MVP:** net-class create / list / add-net (+ delete). Covers F5's DIGI_POWER / AUDIO_POWER directly.
- **Tier 2:** `createDifferentialPair` + net rules (`overwriteNetRules`) for **90 Ω** on the USB pairs → all of F5 electrical.
- **Tier 3 (bonus, same API neighborhood):** stackup via `PCB_Layer.overwriteCurrentPhysicalStackingConfiguration` / `setTheNumberOfCopperLayers` (the 90 Ω prerequisite), and confirm the `PCB_ManufactureData` gerber/pick-place export tools already wrapped.

## Risks / notes
- **Undocumented arg types** → mitigated by the B5 live probe.
- **Extension re-import** needed if the loader changes (not for dispatcher-only edits).
- **Upstream divergence:** keep changes additive and PR-shaped so they can go upstream (`oaslananka/easyeda-mcp-pro`) rather than living only in the fork.
- Writes act on the **live** board — wrap multi-step edits with the existing transaction tools where applicable, and always `getAllNetClasses` to verify.
