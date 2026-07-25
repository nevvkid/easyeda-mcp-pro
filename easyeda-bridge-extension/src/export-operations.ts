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
 * Extract copper-region geometry into plain flat rings: a list of rings, each a
 * flat `[x, y, x, y, ...]` number array. Handles the shapes an EasyEDA
 * ComplexPolygon can take: an object with `discretize()`, a `{ polygon: [...] }`
 * boundary, a nested `[[ring], [hole]]` array, or a flat token array (control
 * tokens like 'L'/'R' are dropped). Returning plain numbers (not class
 * instances) is what lets the whole payload be JSON-serialised without tripping
 * the WS depth limit that truncates `PCB_PrimitivePoured.getAll` to "[MaxDepth]".
 */
function extractRings(cp: unknown): number[][] {
  if (cp == null) return [];
  const obj = cp as { discretize?: unknown; polygon?: unknown };
  if (typeof obj.discretize === 'function') {
    try {
      return extractRings((obj.discretize as () => unknown)());
    } catch {
      /* fall through to the array/polygon paths */
    }
  }
  if (Array.isArray(obj.polygon)) return extractRings(obj.polygon);
  if (!Array.isArray(cp)) return [];
  const arr = cp as unknown[];
  if (arr.length > 0 && Array.isArray(arr[0])) {
    return arr.flatMap((ring) => extractRings(ring));
  }
  const nums = arr.filter((token): token is number => typeof token === 'number');
  return nums.length >= 6 ? [nums] : [];
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
    return normalizeBinaryResult(
      await callFirst(['PCB_ManufactureData.getGerberFile'], params),
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
        boundary: extractRings(p.complexPolygon),
      };
    });

    const pouredList = poured.map((raw) => {
      const pr = asRecord(raw);
      const fills = Array.isArray(pr.pourFills) ? (pr.pourFills as unknown[]) : [];
      return {
        pourId: pr.pourPrimitiveId,
        fills: fills.map((rawFill) => {
          const f = asRecord(rawFill);
          return {
            solid: f.fill,
            lineWidth: f.lineWidth,
            rings: extractRings(asRecord(f.path).complexPolygon),
          };
        }),
      };
    });

    // One-time structure probe so a future run can refine extraction if a pour's
    // resolved geometry comes back empty (learn the shape instead of guessing).
    const firstFill = extractRings(
      asRecord(asRecord((asRecord(poured[0]).pourFills as unknown[])?.[0]).path).complexPolygon,
    );
    const sampleCp = asRecord(asRecord((asRecord(poured[0]).pourFills as unknown[])?.[0]).path)
      .complexPolygon;
    const probe = {
      pourCount: pours.length,
      pouredCount: poured.length,
      boundariesExtracted: pourList.filter((p) => p.boundary.length > 0).length,
      pouredFillsWithRings: pouredList.reduce(
        (sum, p) => sum + p.fills.filter((f) => f.rings.length > 0).length,
        0,
      ),
      firstFillCpType: Array.isArray(sampleCp) ? 'array' : typeof sampleCp,
      firstFillRingsExtracted: firstFill.length,
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

  return {
    exportGerbers,
    exportRouteContext,
    exportPickPlace,
    exportPdf,
    exportNetlist,
    exportPours,
    exportPads,
    exportRouting,
  };
}
