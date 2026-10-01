/**
 * The item master and every design's default materials, built from Gati's own
 * tables as the sync mirrors them (`LegacyRow`).
 *
 * The same mapping the one-off loader used on a backup
 * (`synceclatcaratsense/bak_item_master.py`), so a design keyed into Gati
 * today can be quoted from tomorrow without anyone loading a file.
 *
 * Pure: rows in, rows out. Sale rates only, never cost.
 */

type Rec = Record<string, unknown>;

/** The Gati tables this reads, by their own names. */
export const GATI_ITEM_MASTER_TABLES = [
  'RawMst', 'QualityMst', 'ToneMst', 'ShapeMst', 'SizeMst', 'SPM_CommonMaster', 'MainProduct',
  'RateChartRangeMstDetail', 'RateMst', 'SPM_Items', 'StyleMstDetail', 'StyleMst',
] as const;

export interface GatiItemMaster {
  materials: {
    code: string; name: string; kind: string; groupCode?: string; groupName?: string; legacyId?: string;
    karat?: number; tone?: string; shape?: string; quality?: string;
    saleRates?: { bands?: [number, number, number][]; groups?: Record<string, number> };
  }[];
  sizes: { code: string; sortOrder: number; legacyId?: string; mm?: string; caratPerPiece?: number; sizeGroup?: string }[];
  styles: {
    styleCode: string; legacyId?: string; itemType?: string; itemSize?: string;
    lines: { code: string; weight: number; size?: string; pieces?: number }[];
  }[];
}

/** RawMitNo: 1 metal, 0/5 diamond, 2/6 colour stone, 3 other, 4 charges. */
const KIND: Record<string, string> = {
  '1': 'metal', '0': 'diamond', '5': 'diamond', '2': 'stone', '6': 'stone', '3': 'other', '4': 'charge',
};

/** A value as the text Gati's export shows; '' when there is none. */
const s = (v: unknown): string => (v == null ? '' : String(v).trim());
const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
/** SQL Server's bit, however it arrived: true, 1, "True", "1". */
const yes = (v: unknown): boolean => v === true || v === 1 || /^(true|1)$/i.test(s(v));
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/**
 * Column names without their case: Gati spells the same column `GsizeNo` in one
 * table and `GSizeNo` in another.
 */
const lower = (rows: Rec[] = []): Rec[] =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])));

export function buildGatiItemMaster(tables: Record<string, Rec[]>): GatiItemMaster {
  const T = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name.toLowerCase(), lower(rows)]));
  const R = (name: string) => T[name.toLowerCase()] ?? [];
  const by = (name: string, key: string) => new Map(R(name).map((r) => [s(r[key]), r]));

  const raw = by('RawMst', 'rawno');
  const qly = by('QualityMst', 'qlyno');
  const tone = by('ToneMst', 'toneno');
  const shape = by('ShapeMst', 'shapeno');
  const sizeByNo = by('SizeMst', 'sizeno');
  const common = by('SPM_CommonMaster', 'commonmasterid');
  const groups = by('MainProduct', 'grpno');

  const karat = (q: Rec | undefined): number | undefined => {
    const m = /^(\d+)(KT)?$/.exec(s(q?.qlycode));
    return m && Number(m[1]) <= 24 ? Number(m[1]) : undefined;
  };

  // Sale rates: chart 2 "Sale Rate" by per-stone weight band, chart 1 "Default" by size group.
  const band = new Map(
    R('RateChartRangeMstDetail').map((r) => [s(r.ratechartrangemstdetailid), [n(r.minweight), n(r.maxweight)] as const]),
  );
  const rates = new Map<string, { bands: [number, number, number][]; groups: Record<string, number> }>();
  for (const r of R('RateMst')) {
    const rate = n(r.salerate);
    if (rate <= 0) continue;
    const item = s(r.itemid);
    const entry = rates.get(item) ?? { bands: [], groups: {} };
    const detail = s(r.ratechartrangemstdetailid);
    if (s(r.ratechartid) === '2' && band.has(detail)) {
      const [lo, hi] = band.get(detail)!;
      entry.bands.push([lo, hi, rate]);
    } else if (s(r.ratechartid) === '1' && s(r.gsizeno)) {
      entry.groups[s(r.gsizeno)] = rate;
    } else {
      continue;
    }
    rates.set(item, entry);
  }

  const materials: GatiItemMaster['materials'] = [];
  const itemCode = new Map<string, string>();
  for (const it of R('SPM_Items')) {
    const code = s(it.itemcode);
    if (!code) continue;
    const rw = raw.get(s(it.rawno));
    // Old gold is taken in, never quoted.
    const kind = s(rw?.rawcode) === 'OG' ? 'other' : (KIND[s(rw?.rawmitno) || '0'] ?? 'other');
    const q = qly.get(s(it.qlyno));
    const rt = rates.get(s(it.itemid));
    const stone = kind === 'diamond' || kind === 'stone';
    const sale =
      stone && rt && (rt.bands.length || Object.keys(rt.groups).length)
        ? {
            ...(rt.bands.length ? { bands: [...rt.bands].sort((a, b) => a[0] - b[0] || a[1] - b[1]) } : {}),
            ...(Object.keys(rt.groups).length ? { groups: rt.groups } : {}),
          }
        : undefined;
    const k = kind === 'metal' && s(rw?.rawcode) === 'G' ? karat(q) : undefined;
    materials.push({
      code,
      name: s(it.itemname) || code,
      kind,
      ...(s(rw?.rawcode) ? { groupCode: s(rw?.rawcode) } : {}),
      ...(s(rw?.rawname) ? { groupName: s(rw?.rawname) } : {}),
      legacyId: s(it.itemid),
      ...(k != null ? { karat: k } : {}),
      ...(s(tone.get(s(it.toneno))?.tonecode) ? { tone: s(tone.get(s(it.toneno))?.tonecode) } : {}),
      ...(s(shape.get(s(it.shapeno))?.shapecode) ? { shape: s(shape.get(s(it.shapeno))?.shapecode) } : {}),
      ...(stone && s(q?.qlycode) ? { quality: s(q?.qlycode) } : {}),
      ...(sale ? { saleRates: sale } : {}),
    });
    itemCode.set(s(it.itemid), code);
  }
  // Item types (MainProduct: LADIES RING, PENDANT…) sit in the same list.
  const types = [...groups.values()]
    .filter((g) => s(g.grpprefix))
    .map((g) => ({ code: s(g.grpprefix), name: s(g.grpname) || s(g.grpprefix), kind: 'item_type', legacyId: s(g.grpno) }));

  const sizes: GatiItemMaster['sizes'] = [];
  for (const z of R('SizeMst')) {
    const code = s(z.sizename);
    if (!code) continue;
    const mm = s(z.sizemm);
    sizes.push({
      code,
      sortOrder: Math.trunc(n(z.sortorderno)),
      legacyId: s(z.sizeno),
      ...(mm && mm !== code ? { mm } : {}),
      ...(n(z.pointer) > 0 ? { caratPerPiece: round(n(z.pointer), 4) } : {}),
      ...(s(z.gsizeno) ? { sizeGroup: s(z.gsizeno) } : {}),
    });
  }

  const detail = new Map<string, Rec[]>();
  for (const d of R('StyleMstDetail')) {
    const id = s(d.styleid);
    detail.set(id, [...(detail.get(id) ?? []), d]);
  }
  const styles: GatiItemMaster['styles'] = [];
  for (const st of R('StyleMst')) {
    const styleCode = s(st.stylecode);
    if (!styleCode) continue;
    // The base metal first, then the lines in the order they were keyed.
    const rows = [...(detail.get(s(st.styleid)) ?? [])].sort(
      (a, b) => Number(!yes(a.isbase)) - Number(!yes(b.isbase)) || n(a.stylemstdetailid) - n(b.stylemstdetailid),
    );
    const lines = rows.flatMap((d) => {
      const code = itemCode.get(s(d.itemid));
      if (!code) return [];
      const size = s(sizeByNo.get(s(d.sizeno))?.sizename);
      return [{
        code,
        weight: round(n(d.netweight), 4),
        ...(size ? { size } : {}),
        ...(n(d.pieces) > 0 ? { pieces: Math.trunc(n(d.pieces)) } : {}),
      }];
    });
    const itemType = s(groups.get(s(st.grpno))?.grpprefix);
    const itemSize = s(common.get(s(st.itemsizeid))?.commonmastername);
    styles.push({
      styleCode,
      lines,
      legacyId: s(st.styleid),
      ...(itemType ? { itemType } : {}),
      ...(itemSize ? { itemSize } : {}),
    });
  }

  return { materials: [...types, ...materials], sizes, styles };
}
