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
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
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

  return {
    exportGerbers,
    exportRouteContext,
    exportPickPlace,
    exportPdf,
    exportNetlist,
    exportPours,
  };
}
