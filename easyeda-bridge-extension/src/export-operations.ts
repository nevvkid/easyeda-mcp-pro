import type { ApiRuntime } from './api-runtime.js';
import type { BinaryResultNormalizer } from './binary-result.js';

export interface ExportOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
  normalizeBinaryResult: BinaryResultNormalizer;
}

export interface ExportOperations {
  exportGerbers(params: Record<string, unknown>): Promise<unknown>;
  exportRouteContext(params: Record<string, unknown>): Promise<unknown>;
  exportPickPlace(params: Record<string, unknown>): Promise<unknown>;
  exportPdf(params: Record<string, unknown>): Promise<unknown>;
  exportNetlist(params: Record<string, unknown>): Promise<unknown>;
  exportPours(params: Record<string, unknown>): Promise<unknown>;
  exportPads(params: Record<string, unknown>): Promise<unknown>;
  exportRouting(params: Record<string, unknown>): Promise<unknown>;
  exportLengthMatch(params: Record<string, unknown>): Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** First defined value across candidate lowercase getters, then `state.Capital`. */
function pick(obj: Record<string, unknown>, state: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    const cap = k.charAt(0).toUpperCase() + k.slice(1);
    if (state[cap] !== undefined && state[cap] !== null) return state[cap];
  }
  return undefined;
}

/** Scalar-only view of a primitive's `state`, for the schema probe. */
function scalarState(obj: Record<string, unknown>): Record<string, unknown> {
  const state = asRecord(obj.state);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

/**
 * Parse one EasyEDA `TPCB_PolygonSourceArray` — the standard single-polygon source
 * format in board mil: `[x, y, 'L', x, y, 'ARC', angle, ex, ey, 'R', cx, cy, w, h, rot,
 * ccw, 'CIRCLE', cx, cy, r, 'C', c1x, c1y, c2x, c2y, x, y, ...]` — into a flat
 * `[x, y, x, y, ...]` point ring. Arcs/beziers are approximated by their endpoints;
 * rect/circle are expanded. (Per the easyeda-api-skill IPCB_ComplexPolygon docs, this
 * is the source data returned by getSource/getSourceStrictComplex — NOT the BETA
 * discretize(), which returns points in a scaled frame.)
 */
function parseSourceArray(src: unknown[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    const t = src[i];
    if (typeof t === 'number') {
      out.push(t, src[i + 1] as number);
      i += 2;
    } else if (t === 'L') {
      i += 1;
    } else if (t === 'ARC' || t === 'CARC') {
      out.push(src[i + 2] as number, src[i + 3] as number); // arc endpoint
      i += 4;
    } else if (t === 'C') {
      out.push(src[i + 5] as number, src[i + 6] as number); // bezier endpoint
      i += 7;
    } else if (t === 'R') {
      const cx = src[i + 1] as number, cy = src[i + 2] as number;
      const w = src[i + 3] as number, h = src[i + 4] as number;
      return [cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2, cx + w / 2, cy + h / 2, cx - w / 2, cy + h / 2];
    } else if (t === 'CIRCLE') {
      const cx = src[i + 1] as number, cy = src[i + 2] as number, r = src[i + 3] as number;
      const ring: number[] = [];
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * 2 * Math.PI;
        ring.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      return ring;
    } else {
      i += 1;
    }
  }
  return out;
}

/** True when every element is a number or a known source-format control token. */
function looksLikeSource(arr: unknown[]): boolean {
  return arr.some((t) => typeof t === 'string' && ['L', 'ARC', 'CARC', 'C', 'R', 'CIRCLE'].includes(t))
    || arr.every((t) => typeof t === 'number');
}

/**
 * Copper-region geometry → list of flat `[x,y,...]` rings, in board mil. Prefers the
 * documented clean accessors on an IPCB_ComplexPolygon (`getSourceStrictComplex` →
 * `Array<sourceArray>`, else `getSource`, else `toPolygon().getSource()`), then a
 * `{ polygon }` source array, then a raw source/nested array — and deliberately avoids
 * the BETA `discretize()` (returns scaled/scattered points).
 */
function polygonRings(cp: unknown): number[][] {
  if (cp == null) return [];
  const obj = cp as Record<string, unknown>;
  const call = (name: string): unknown =>
    typeof obj[name] === 'function' ? (obj[name] as () => unknown).call(obj) : undefined;
  const strict = call('getSourceStrictComplex');
  if (Array.isArray(strict)) return strict.map((s) => parseSourceArray(s as unknown[])).filter((r) => r.length >= 6);
  const src = call('getSource');
  if (Array.isArray(src)) {
    if (src.length > 0 && Array.isArray(src[0])) return src.map((s) => parseSourceArray(s as unknown[]));
    return [parseSourceArray(src)];
  }
  const polys = call('toPolygon');
  if (Array.isArray(polys)) {
    return polys
      .map((p) => {
        const ps = p as Record<string, unknown>;
        const s = typeof ps.getSource === 'function' ? (ps.getSource as () => unknown).call(ps) : undefined;
        return Array.isArray(s) ? parseSourceArray(s) : [];
      })
      .filter((r) => r.length >= 6);
  }
  if (Array.isArray(obj.polygon)) return [parseSourceArray(obj.polygon as unknown[])];
  if (!Array.isArray(cp)) return [];
  const arr = cp as unknown[];
  if (arr.length > 0 && Array.isArray(arr[0])) return arr.flatMap((r) => polygonRings(r));
  if (looksLikeSource(arr)) {
    const r = parseSourceArray(arr);
    return r.length >= 6 ? [r] : [];
  }
  return [];
}

/** Diagnostic: what accessors/shape does a poured fill's complexPolygon actually have? */
function probeCp(cp: unknown): Record<string, unknown> {
  const obj = cp as Record<string, unknown>;
  const isArr = Array.isArray(cp);
  const arr = isArr ? (cp as unknown[]) : [];
  return {
    type: isArr ? 'array' : typeof cp,
    hasGetSourceStrictComplex: typeof obj?.getSourceStrictComplex === 'function',
    hasGetSource: typeof obj?.getSource === 'function',
    hasToPolygon: typeof obj?.toPolygon === 'function',
    hasDotPolygon: Array.isArray(obj?.polygon),
    arrLen: isArr ? arr.length : undefined,
    arrFirst8: isArr ? arr.slice(0, 8) : undefined,
    arrHasTokens: isArr ? arr.some((t) => typeof t === 'string') : undefined,
  };
}

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function createExportOperations({
  callFirst,
  normalizeBinaryResult,
}: ExportOperationDependencies): ExportOperations {
  async function exportGerbers(params: Record<string, unknown>): Promise<unknown> {
    // getGerberFile(fileName?, colorSilkscreen?, unit?, digitalFormat?, other?, layers?, objects?)
    // takes POSITIONAL args — passing the whole params object as `fileName` returns undefined
    // ("Bridge did not return export data"). Pass a string fileName + `other` so the drill files,
    // drill table and flying-probe file are included in the zip (defaults omit them).
    const fileName =
      typeof params.fileName === 'string'
        ? params.fileName
        : typeof params.projectId === 'string'
          ? `${params.projectId}-Gerber`
          : 'Gerber';
    const other = {
      metallicDrillingInformation: true,
      nonMetallicDrillingInformation: true,
      drillTable: true,
      flyingProbeTestingFile: true,
    };
    return normalizeBinaryResult(
      await callFirst(
        ['PCB_ManufactureData.getGerberFile'],
        fileName,
        false,
        undefined,
        undefined,
        other,
      ),
      'gerbers.zip',
    );
  }

  async function exportRouteContext(params: Record<string, unknown>): Promise<unknown> {
    return normalizeBinaryResult(
      await callFirst(
        ['PCB_ManufactureData.getDsnFile'],
        typeof params.fileName === 'string' ? params.fileName : undefined,
      ),
      'route-context.dsn',
    );
  }

  async function exportPickPlace(params: Record<string, unknown>): Promise<unknown> {
    return normalizeBinaryResult(
      await callFirst(['PCB_ManufactureData.getPickAndPlaceFile'], params),
      `pick-place.${typeof params.format === 'string' ? params.format : 'csv'}`,
    );
  }

  async function exportPdf(params: Record<string, unknown>): Promise<unknown> {
    return normalizeBinaryResult(
      await callFirst(
        ['PCB_ManufactureData.getPdfFile', 'SCH_ManufactureData.getExportDocumentFile'],
        params.what === 'board' ? params : { ...params, type: 'schematic' },
      ),
      'export.pdf',
    );
  }

  async function exportNetlist(params: Record<string, unknown>): Promise<unknown> {
    return normalizeBinaryResult(
      await callFirst(
        [
          'SCH_Netlist.getNetlist',
          'SCH_ManufactureData.getNetlistFile',
          'PCB_ManufactureData.getNetlistFile',
        ],
        params,
      ),
      `netlist.${typeof params.format === 'string' ? params.format : 'txt'}`,
    );
  }

  /**
   * Export net-tagged copper pours to a JSON artifact. Composes
   * `PCB_PrimitivePour.getAll` (boundaries + net/layer/priority) with
   * `PCB_PrimitivePoured.getAll` (the resolved/antipad-subtracted copper),
   * joined by pour id, and flattens all geometry to plain number arrays so the
   * payload survives the WS transport intact (unlike the raw getAll, whose
   * nested geometry serialises as "[MaxDepth]"). Returned as a base64 JSON blob
   * that the server writes verbatim to the artifact dir.
   */
  async function exportPours(_params: Record<string, unknown>): Promise<unknown> {
    const pours = (await callFirst(['PCB_PrimitivePour.getAll'])) as unknown[];
    const poured = (await callFirst(['PCB_PrimitivePoured.getAll'])) as unknown[];

    const pourList = pours.map((raw) => {
      const p = asRecord(raw);
      return {
        id: p.primitiveId,
        net: p.net,
        layer: p.layer,
        priority: p.pourPriority,
        fillMethod: p.pourFillMethod,
        lock: p.primitiveLock,
        name: p.pourName,
        boundary: polygonRings(p.complexPolygon),
      };
    });

    const pouredList = poured.map((raw) => {
      const pr = asRecord(raw);
      const fills = Array.isArray(pr.pourFills) ? (pr.pourFills as unknown[]) : [];
      return {
        pourId: pr.pourPrimitiveId,
        fills: fills.map((rawFill) => {
          const f = asRecord(rawFill);
          // Emit the RAW source arrays (getSourceStrictComplex output, EasyEDA
          // TPCB_PolygonSourceArray format with L/ARC/CARC/R/CIRCLE tokens, in the
          // poured ~10-mil unit). Parsing + arc discretization happens on the Python
          // side so it can be refined without re-importing the extension.
          const cp = asRecord(f.path).complexPolygon;
          const cpObj = cp as Record<string, unknown>;
          const strict = typeof cpObj.getSourceStrictComplex === 'function'
            ? (cpObj.getSourceStrictComplex as () => unknown).call(cpObj)
            : typeof cpObj.getSource === 'function'
              ? (cpObj.getSource as () => unknown).call(cpObj)
              : cp;
          return { solid: f.fill, lineWidth: f.lineWidth, source: strict };
        }),
      };
    });

    // Structure probe — confirms which clean accessor the poured geometry exposes
    // (getSourceStrictComplex/getSource/toPolygon) and its coordinate range, so a run
    // can verify the source-format extraction instead of the BETA discretize() frame.
    const sampleCp = asRecord(asRecord((asRecord(poured[0]).pourFills as unknown[])?.[0]).path)
      .complexPolygon;
    let pmin = Infinity, pmax = -Infinity;
    const flatNums = (v: unknown): void => {
      if (typeof v === 'number') { if (v < pmin) pmin = v; if (v > pmax) pmax = v; }
      else if (Array.isArray(v)) for (const x of v) flatNums(x);
    };
    for (const p of pouredList) for (const f of p.fills) flatNums(f.source);
    const probe = {
      pourCount: pours.length,
      pouredCount: poured.length,
      boundariesExtracted: pourList.filter((p) => p.boundary.length > 0).length,
      pouredFillsWithSource: pouredList.reduce(
        (sum, p) => sum + p.fills.filter((f) => Array.isArray(f.source) && f.source.length > 0).length,
        0,
      ),
      pouredCoordRange: [pmin === Infinity ? null : Math.round(pmin), pmax === -Infinity ? null : Math.round(pmax)],
      firstFillCp: probeCp(sampleCp),
    };

    const json = JSON.stringify({ schema: 'easyeda-pours@1', pours: pourList, poured: pouredList, probe });
    return { base64: utf8Base64(json), fileName: 'pours.json' };
  }

  /**
   * Export every copper pad with its net, layer, position and size to a JSON
   * artifact. This is the data the DSN/Gerber exports don't carry per-pad with
   * net identity, and it's what enables cap→IC-power-pin decoupling proximity
   * and near-field (compact-aggressor) coupling checks. Defensive field access
   * (lowercase getter or `state.Capital`) plus a schema probe, so a first live
   * run yields usable net+position data regardless of the exact field names.
   */
  async function exportPads(_params: Record<string, unknown>): Promise<unknown> {
    const pads = (await callFirst(['PCB_PrimitivePad.getAll'])) as unknown[];
    const list = pads.map((raw) => {
      const p = asRecord(raw);
      const s = asRecord(p.state);
      return {
        id: pick(p, s, ['primitiveId']),
        net: pick(p, s, ['net']),
        layer: pick(p, s, ['layer']),
        x: pick(p, s, ['x', 'centerX', 'positionX']),
        y: pick(p, s, ['y', 'centerY', 'positionY']),
        pad: pick(p, s, ['padNumber', 'number', 'name', 'pinNumber']),
        designator: pick(p, s, ['designator', 'componentDesignator', 'parentDesignator']),
        width: pick(p, s, ['width', 'padWidth']),
        height: pick(p, s, ['height', 'padHeight']),
        hole: pick(p, s, ['holeDiameter', 'holeD', 'drill']),
        rotation: pick(p, s, ['rotation']),
      };
    });
    const first = asRecord(pads[0]);
    const probe = {
      padCount: pads.length,
      withNet: list.filter((p) => p.net != null).length,
      withXY: list.filter((p) => p.x != null && p.y != null).length,
      withDesignator: list.filter((p) => p.designator != null).length,
      // Reveal the true field names if any of the above come back empty:
      firstPadKeys: Object.keys(first).slice(0, 40),
      firstPadState: scalarState(first),
    };
    const json = JSON.stringify({ schema: 'easyeda-pads@1', pads: list, probe });
    return { base64: utf8Base64(json), fileName: 'pads.json' };
  }

  /**
   * Export routed copper tracks (PCB_PrimitiveLine segments) and vias with their
   * nets/layers/coordinates/widths to one JSON artifact. Field names mirror the
   * proven `pcb.listTracks`/`pcb.listVias` read ops. Lets analysis run fully from
   * EasyEDA's own primitives — no Specctra-DSN round-trip and its reuse-block
   * name quirks, and no 200-row pagination.
   */
  async function exportRouting(_params: Record<string, unknown>): Promise<unknown> {
    const lines = (await callFirst(['PCB_PrimitiveLine.getAll'])) as unknown[];
    const vias = (await callFirst(['PCB_PrimitiveVia.getAll'])) as unknown[];
    const tracks = lines.map((raw) => {
      const l = asRecord(raw);
      const s = asRecord(l.state);
      return {
        net: pick(l, s, ['net']),
        layer: pick(l, s, ['layer']),
        x1: pick(l, s, ['startX']),
        y1: pick(l, s, ['startY']),
        x2: pick(l, s, ['endX']),
        y2: pick(l, s, ['endY']),
        width: pick(l, s, ['lineWidth', 'width']),
      };
    });
    const viaList = vias.map((raw) => {
      const v = asRecord(raw);
      const s = asRecord(v.state);
      return {
        net: pick(v, s, ['net']),
        x: pick(v, s, ['x']),
        y: pick(v, s, ['y']),
        hole: pick(v, s, ['holeDiameter']),
        diameter: pick(v, s, ['diameter']),
      };
    });
    const probe = {
      trackCount: tracks.length,
      viaCount: viaList.length,
      tracksWithNet: tracks.filter((t) => t.net != null).length,
      tracksWithCoords: tracks.filter((t) => t.x1 != null && t.y1 != null).length,
      firstTrackState: scalarState(asRecord(lines[0])),
      firstViaState: scalarState(asRecord(vias[0])),
    };
    const json = JSON.stringify({ schema: 'easyeda-routing@1', tracks, vias: viaList, probe });
    return { base64: utf8Base64(json), fileName: 'routing.json' };
  }

  // Length-match report: the design's own equal-length net groups + EasyEDA's authoritative
  // per-net length. This is the RELIABLE basis for a length-match check — the tool knows the
  // true connectivity, unlike geometric track-graph reconstruction (which fragments on
  // via/inner-layer copper). Note: getNetLength is NET-TOTAL (includes any pull-up stub), same
  // basis EasyEDA's own equal-length DRC uses; within a bus the stubs are ~uniform so the
  // group spread is a faithful match indicator.
  async function exportLengthMatch(_params: Record<string, unknown>): Promise<unknown> {
    const groupsRaw = (await callFirst(['PCB_Drc.getAllEqualLengthNetGroups'])) as unknown[];
    const groups: unknown[] = [];
    for (const gRaw of groupsRaw ?? []) {
      const g = asRecord(gRaw);
      const nets = Array.isArray(g.nets) ? (g.nets as unknown[]).map(String) : [];
      const perNet: Array<{ net: string; length_mil: number | null }> = [];
      for (const net of nets) {
        const len = await callFirst(['PCB_Net.getNetLength'], net);
        perNet.push({ net, length_mil: typeof len === 'number' ? len : null });
      }
      const lens = perNet.map((n) => n.length_mil).filter((x): x is number => typeof x === 'number');
      const spread = lens.length ? Math.max(...lens) - Math.min(...lens) : null;
      groups.push({
        name: typeof g.name === 'string' ? g.name : null,
        spread_mil: spread == null ? null : Math.round(spread * 100) / 100,
        min_mil: lens.length ? Math.min(...lens) : null,
        max_mil: lens.length ? Math.max(...lens) : null,
        nets: perNet,
      });
    }
    const json = JSON.stringify({
      schema: 'easyeda-length-match@1',
      note: 'lengths = PCB_Net.getNetLength (EasyEDA authoritative, net-total incl. pull-up stubs); '
        + 'groups = PCB_Drc.getAllEqualLengthNetGroups (the design\'s own equal-length groups). '
        + 'Compare spread within each group.',
      groups,
    });
    return { base64: utf8Base64(json), fileName: 'length-match.json' };
  }

  return {
    exportGerbers,
    exportRouteContext,
    exportPickPlace,
    exportPdf,
    exportNetlist,
    exportPours,
    exportPads,
    exportRouting,
    exportLengthMatch,
  };
}
