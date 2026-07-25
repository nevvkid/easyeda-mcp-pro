# Plan — Programmatic layout-analysis toolchain (+ screenshot-free layout-quality review)

**Goal:** analyze PCB layout *quality* — not just DRC pass/fail — and suggest improvements, **without screenshots**, driven from the EasyEDA API. Motivated by the TBD Main board: "is this layout good, and how do we improve it?"

**Source of API knowledge:** EasyEDA's own [`easyeda-api-skill`](https://github.com/easyeda/easyeda-api-skill), now vendored as a **git submodule** at [`vendor/easyeda-api-skill/`](../../../vendor/easyeda-api-skill) (pinned at `72d3ce9`). It ships the **complete raw API reference** (`vendor/easyeda-api-skill/references/` — classes/enums/interfaces/types) and the **PCB source-file format spec** (`vendor/easyeda-api-skill/format/pcb/`). *That repo has no LICENSE file → it's referenced via submodule (not copied into our tree); when building tools, re-derive signatures rather than copying its text.* Init with `git submodule update --init`.

---

## A. What the API actually exposes for analysis (verified 2026-07-25)

### A1. Geometry engine — `SYS_Math` (this is the key unlock)
A full computational-geometry toolkit, so "layout goodness" (a geometric property) is computable, not visual:
`distanceToPoint(polygon, point): number`, `getBBox`, `getCentroid`, `calculateArea`, `calculatePerimeter`, `bboxIntersects`, `intersects`, `contains`, `containsPoint`, `intersection`, `union`, `subtract`, `xor`, `rotate`, `scale`, `translate`. Plus `PCB_MathPolygon` (createPolygon, discretize, splitPolygon, calc W/H, image→polygon).

### A2. Data access (positions + connectivity + copper)
- `PCB_PrimitiveComponent.getAll(layer?)` → every component: position, rotation, layer, bbox, designator.
- `PCB_Net.getAllPrimitivesByNet(net, types)` → all copper primitives of a net (tracks/pads/vias/pours) — for per-net geometry.
- `PCB_Net.getNetLength(net)` → routed length (diff-pair matching, stub detection).
- Already wrapped in this fork: `pcb.listTracks` / `listVias` / `listComponents`, `board.getStackup/Layers/Dimensions`, DSN + Gerber export.

### A3. DRC with *object detail* — closes the `{obj1}/{obj2}` gap
`PCB_Drc.check()` (already wrapped) returns only coarse per-severity counts. But **`PCB_Event.addRealTimeDrcResultEventListener(id, 'all', callFn)`** fires with `{ drcResult }` — the **actual offending objects/nets**. `@beta`, extension-only (throws in standalone scripts). **Wrap this in the extension dispatcher** → a `pcb.drcDetails` method that runs DRC, captures the event payload, and returns which nets/objects violate. This directly fixes the TBD F13/F14 blind spot (we currently can't see *which* two objects overlap).

### A4. DFM/DFA/DFT — already have `easyeda_pcb_production_review`
Rules engine over board metrics (drill, copper-to-edge, annular ring, silk-over-pad, test pads, net classes…). Feed it `board.*` data.

### A5. Offline parsing — `format/pcb/` spec
The raw PCB file format is documented (component, pad_via, primitive, rule, shape, text, dimension, panel, partition). With it, a board can be analyzed **from its source export, no live bridge** — good for CI / batch review.

---

## B. Toolchain to build in this fork (new MCP tools)
Follow the net-class pattern (extension op + dispatcher case + `pro`/`full` tool + tests):
1. **`pcb_drc_details`** — wraps A3; returns DRC violations *with* the offending nets/objects. Highest value (closes the gap).
2. **`pcb_power_audit`** — pull power-net tracks (`getAllPrimitivesByNet`), find min width per rail, compare to worst-case current via the bundled IPC-2221 (`design_rules_lookup`). Flags under-width power/ground.
3. **`pcb_decoupling_audit`** — for each IC power pin, nearest same-net cap, distance via `SYS_Math`; flag caps too far from the pin.
4. **`pcb_diffpair_report`** — `getNetLength` per pair; report skew.
5. **`pcb_placement_check`** — component bbox overlaps, edge/keepout clearance, silk-over-pad (or route through `pcb_production_review`).
6. **`pcb_loop_area`** — for switchers, enclosed area of the in-cap→IC→L→out-cap loop from component centroids.

All read-only; each returns structured findings (like the expert-review pattern) → no screenshots.

---

## C. Screenshot-free **layout-quality review** (the "is it good like the datasheet shows?" ask)

Datasheets show *recommended layouts*; "matching" them is a set of **geometric relationships**, which we have as data. Three layers:

1. **Generic heuristics (no datasheet):** decoupling proximity (B3), switcher loop area (B6), crystal cluster/short-traces, sensitive-net-to-switch-node distance, thermal copper area (`getAllPrimitivesByNet`+`calculateArea`), courtyard overlap, diff-pair skew. All from `SYS_Math` + positions.
2. **Datasheet-derived part rules:** read a part's "recommended PCB layout" section (we keep the PDFs in `datasheets/`) and encode it as rules (proximity/order/keepout) — e.g. AK4619 AVDRV/VCOM cap placement, TLV62569 loop, TPS7A2033 in/out caps, USB pair routing. A small per-part rule library.
3. **LLM-assisted comparison (the "visual" part, done from data not pixels):** feed the model *(a)* the datasheet's recommended-layout description and *(b)* our board's **local geometry** around that part (relative component positions, trace widths, layers, distances) — reconstructed from the API. The model judges "does our placement/routing follow the recommendation, and how to improve it." This is screenshot-free because the layout is delivered as **structured geometry**, not an image.

**Residual (screenshots still help, minimize):** final aesthetic pass, complex copper-shape judgement, 3D/mechanical fit. ~90% of "is it good" is geometric and covered above.

**Pipeline:** `extract (MCP: components + net primitives + tracks/vias) → compute (SYS_Math or Python) → check (heuristics + datasheet rules) → assess (LLM w/ datasheet layout text + our geometry) → report (findings + fixes, no images)`.

---

## D. Open-source tools (for anything the API doesn't expose)
- **gerbonara / pcb-tools / pcbdl** (Python) — parse exported Gerbers for custom geometric checks (widths, clearance, copper area/thermal).
- **KiCad** — import DSN/Gerber → its DRC + Python API (lossy conversion → cross-check only).
- **Gerbv** — Gerber view/verify. **FreeRouting** — DSN re-route, not analysis.
- This fork already bundles **IPC-2221** current/width/clearance reference (`design_rules_lookup`).

## Sequencing
`pcb_drc_details` first (closes the concrete F13/F14 gap), then `pcb_power_audit` + `pcb_decoupling_audit` (highest layout-quality value), then the datasheet-rule library + LLM review. Each ships as a normal PR-shaped tool with tests/docs.

---

## Addendum 2026-07-25 — pour-geometry review (implemented as a skill) + bridge bugs found

**Key discovery — copper pours ARE available with net identity, live:** `PCB_PrimitivePour.getAll` returns every pour tagged with `Net`, `Layer` (1=Top, 2=Bottom, 15=Inner1, 16=Inner2), `PourPriority`, `PourFillMethod`, `PrimitiveLock`, and a boundary `ComplexPolygon.polygon` (mil, `[x,y,'L',...]` or `['R',cx,cy,w,h,rot,ccw]`). This is the clean answer to "colour copper by voltage" and to the width-audit blind spot (the DSN/Gerber trace exports omit pours) — **no Gerber, no raster segmentation, no via heuristics, no coordinate alignment.** Region resolution = boundary minus same-layer pours of lower `PourPriority` number (lower number wins the overlap). Built as the **`pcb-plane-integrity` skill** in `tbd-hardware/.claude/skills/` (pour-map + HS return-path audit); ~a day of work, replaces the earlier Gerber+via-dot render approach entirely.

**Two confirmed bridge/fork bugs to fix (both hit while building the above):**
1. **`easyeda_export_gerbers` returns no data** — every call (project name, board name, with/without `filePath`) → `{"exported":false,"not_available":true,"error":"Bridge did not return export data."}`. The DSN export (`easyeda_pcb_export_route_context`) works, so it's specific to the Gerber path in the extension dispatcher. Workaround: manual GUI Gerber export. Fix: trace the `PCB_ManufactureData` gerber call in the bridge.
2. **`PCB_PrimitivePoured.getAll` truncates geometry** — the *resolved* copper (antipad/thermal subtracted) serialises each fill's `path.complexPolygon` as the literal string `"[MaxDepth]"` (depth-limited serializer). So the antipad-accurate copper is currently un-exportable over the bridge; only the `Pour` **boundaries** are usable. Fix options: raise the serialization depth for this method, or add a dedicated `easyeda_pcb_export_pours` tool that writes net+layer+resolved polygons to an artifact **file** (like the DSN export does) — this is the clean "Option C" for antipad-accurate plane maps and the `pcb_power_audit`/`pcb_decoupling_audit` tools above.

Note also: `easyeda_board_stackup` returns **layer count only** (`data_source: copper_layer_count_only`) — no physical order/dielectric — so the skill assumes order `1,15,16,2`. A real stackup readout would let the return-path audit pick reference planes without that assumption.
