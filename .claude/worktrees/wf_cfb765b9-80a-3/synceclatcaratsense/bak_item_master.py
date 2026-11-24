"""Build the Eclat item-master file (PUT /materials) straight from an APRSSJEP.bak.

Reads the backup's pages directly, so no SQL Server has to be installed or
started: it indexes the 8 KB pages in the (uncompressed) backup stream, decodes
the system catalog, and reads the item, size, category, rate and style tables.
Read-only; the backup is never written. Sale rates only, never cost.

    python bak_item_master.py "E:\...\APRSSJEP.bak" sjep_materials.json

Then load the file as head office: PUT /materials with the JSON as the body.
"""
import json, re
import struct, os, sys, datetime, decimal, collections

BAK = None  # set by main()
PAGE = 8192
DATA_TYPES = (1, 2, 3, 4, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20)


def build_index():
    f = open(BAK, 'rb'); idx = {}; off = 0; CH = 64 << 20
    while True:
        buf = f.read(CH)
        if not buf: break
        for i in range((7680 - off) % PAGE, len(buf) - 96, PAGE):
            if buf[i] == 1 and buf[i + 1] in DATA_TYPES:
                pid, fid = struct.unpack_from('<IH', buf, i + 32)
                if 1 <= fid <= 4:
                    idx[(fid, pid)] = (off + i, buf[i + 1], struct.unpack_from('<H', buf, i + 6)[0], struct.unpack_from('<I', buf, i + 24)[0])
        off += len(buf)
    return idx


class Bak:
    def __init__(self):
        self.idx = build_index()
        self.f = open(BAK, 'rb')
        self.by_au = collections.defaultdict(list)
        for key, (off, typ, index_id, obj_id) in self.idx.items():
            if typ == 1:
                self.by_au[(index_id << 48) | (obj_id << 16)].append(key)

    def page(self, key):
        self.f.seek(self.idx[key][0]); return self.f.read(PAGE)

    def allocated(self, key):
        fid, pid = key
        pfs = self.idx.get((fid, 1 if pid < 8088 else (pid // 8088) * 8088))
        if pfs is None: return True
        self.f.seek(pfs[0] + 96 + 4 + pid % 8088)
        return bool(self.f.read(1)[0] & 0x40)

    def records(self, au):
        for key in sorted(self.by_au.get(au, [])):
            if not self.allocated(key): continue
            p = self.page(key)
            for s in range(struct.unpack_from('<H', p, 22)[0]):
                o = struct.unpack_from('<H', p, PAGE - 2 * (s + 1))[0]
                if o == 0: continue
                if (p[o] >> 1) & 7 in (0, 1):  # primary or forwarded
                    yield p, o


def split(p, o):
    """-> (ncols, null bitmap, [var column bytes or None for off-row])"""
    sa = p[o]; fend = struct.unpack_from('<H', p, o + 2)[0]
    n = struct.unpack_from('<H', p, o + fend)[0]
    pos = o + fend + 2; nb = b''
    if sa & 0x10:
        nb = p[pos:pos + (n + 7) // 8]; pos += (n + 7) // 8
    var = []
    if sa & 0x20:
        vc = struct.unpack_from('<H', p, pos)[0]; pos += 2
        ends = struct.unpack_from('<%dH' % vc, p, pos); pos += 2 * vc
        start = pos
        for e in ends:
            end = o + (e & 0x7fff)
            var.append(None if e & 0x8000 else p[start:end])
            start = end
    return n, nb, var


def isnull(nb, bit):  # 1-based
    if not nb or bit <= 0: return False
    i = bit - 1
    return i // 8 < len(nb) and bool(nb[i // 8] & (1 << (i % 8)))


def dec(b, scale):
    v = int.from_bytes(b[1:], 'little'); v = v if b[0] == 1 else -v
    return decimal.Decimal(v).scaleb(-scale)


def fixed_val(b, xtype, scale):
    if xtype == 56: return struct.unpack('<i', b)[0]
    if xtype == 127: return struct.unpack('<q', b)[0]
    if xtype == 52: return struct.unpack('<h', b)[0]
    if xtype == 48: return b[0]
    if xtype in (106, 108): return dec(b, scale)
    if xtype == 60:
        return decimal.Decimal(struct.unpack('<q', b)[0]).scaleb(-4)
    if xtype == 122: return decimal.Decimal(struct.unpack('<i', b)[0]).scaleb(-4)
    if xtype == 62: return struct.unpack('<d', b)[0]
    if xtype == 59: return struct.unpack('<f', b)[0]
    if xtype == 61:
        t, d = struct.unpack('<Ii', b)
        return datetime.datetime(1900, 1, 1) + datetime.timedelta(days=d, milliseconds=round(t * 10 / 3))
    if xtype == 58:
        m, d = struct.unpack('<HH', b)
        return datetime.datetime(1900, 1, 1) + datetime.timedelta(days=d, minutes=m)
    if xtype == 40: return datetime.date(1, 1, 1) + datetime.timedelta(days=int.from_bytes(b, 'little'))
    if xtype == 175: return b.decode('cp1252').rstrip()
    if xtype == 239: return b.decode('utf-16-le').rstrip()
    return b.hex()


def var_val(b, xtype):
    if b is None: return None
    if xtype == 167: return b.decode('cp1252')
    if xtype == 231: return b.decode('utf-16-le')
    return b.hex()


FIXLEN = {56: 4, 127: 8, 52: 2, 48: 1, 60: 8, 122: 4, 62: 8, 59: 4, 61: 8, 58: 4, 40: 3, 36: 16}
DECLEN = lambda prec: 5 if prec <= 9 else 9 if prec <= 19 else 13 if prec <= 28 else 17


class Db:
    def __init__(self):
        self.b = Bak()
        # sysallocunits (au 7<<16): auid@4 type@12 ownerid@13
        self.au = collections.defaultdict(list)
        for p, o in self.b.records(7 << 16):
            auid, typ, owner = struct.unpack_from('<qBq', p, o + 4)
            self.au[owner].append((auid, typ))
        self.rowsets = collections.defaultdict(list)
        for p, o in self.recs_of_sys(5):
            rsid, ot, major, minor = struct.unpack_from('<qBii', p, o + 4)
            rc = struct.unpack_from('<q', p, o + 31)[0]
            self.rowsets[major].append((rsid, minor, rc))
        self.objs = {}
        for p, o in self.recs_of_sys(34):
            n, nb, var = split(p, o)
            oid = struct.unpack_from('<i', p, o + 4)[0]
            typ = p[o + 17:o + 19].decode('ascii', 'replace')
            self.objs[oid] = (var[0].decode('utf-16-le'), typ)
        self.cols = collections.defaultdict(list)
        for p, o in self.recs_of_sys(41):
            n, nb, var = split(p, o)
            oid, number, colid, xtype, utype, length, prec, scale = struct.unpack_from('<ihiBihBB', p, o + 4)
            if number == 0:
                self.cols[oid].append(dict(colid=colid, name=var[0].decode('utf-16-le'), xtype=xtype, length=length, prec=prec, scale=scale))
        self.rscols = collections.defaultdict(dict)
        for p, o in self.recs_of_sys(3):
            rsid, rscolid, hbcolid = struct.unpack_from('<qii', p, o + 4)
            status, offset, nullbit = struct.unpack_from('<iii', p, o + 40)
            bitpos = struct.unpack_from('<h', p, o + 52)[0]
            self.rscols[rsid][rscolid] = dict(offset=offset, nullbit=nullbit, status=status, bitpos=bitpos, hbcolid=hbcolid)

    def recs_of_sys(self, oid):
        # A system base table's clustered rowset: find its in-row allocation unit.
        rsid = None
        if oid == 5:
            yield from self.b.records(5 << 16); return
        for r, minor, rc in self.rowsets.get(oid, []):
            if minor == 1: rsid = r
        aus = [a for a, t in self.au.get(rsid, []) if t == 1] if rsid else [oid << 16]
        for a in aus:
            yield from self.b.records(a)

    def tables(self):
        out = []
        for oid, (name, typ) in self.objs.items():
            if typ.strip() == 'U':
                rows = sum(rc for rsid, minor, rc in self.rowsets.get(oid, []) if minor in (0, 1))
                out.append((name, oid, rows))
        return sorted(out)

    def oid(self, name):
        return next(o for o, (n, t) in self.objs.items() if n.lower() == name.lower() and t.strip() == 'U')

    def rows(self, name):
        oid = self.oid(name)
        rsid = next(r for r, minor, rc in self.rowsets[oid] if minor in (0, 1))
        rs = self.rscols[rsid]
        cols = sorted(self.cols[oid], key=lambda c: c['colid'])
        for au in [a for a, t in self.au[rsid] if t == 1]:
            for p, o in self.b.records(au):
                n, nb, var = split(p, o)
                row = {}
                for c in cols:
                    r = rs.get(c['colid'])
                    if r is None: row[c['name']] = '?'; continue
                    if isnull(nb, r['nullbit']): row[c['name']] = None; continue
                    off = r['offset'] & 0xffff
                    soff = off - 0x10000 if off & 0x8000 else off
                    x = c['xtype']
                    if soff < 0:
                        k = -soff - 1
                        row[c['name']] = var_val(var[k], x) if k < len(var) else None
                    elif x == 104:
                        row[c['name']] = bool(p[o + soff] & (1 << r['bitpos']))
                    else:
                        ln = DECLEN(c['prec']) if x in (106, 108) else FIXLEN.get(x, c['length'])
                        row[c['name']] = fixed_val(p[o + soff:o + soff + ln], x, c['scale'])
                yield row


def main(bak, out):
    global BAK, OUT
    BAK, OUT = bak, out
    db = Db()
    cache = {}

    def R(table):
        # Rows as text, the way the ERP export reads: None is '', True is 'True'.
        if table not in cache:
            cache[table] = [{k: '' if v is None else str(v) for k, v in row.items()} for row in db.rows(table)]
        return cache[table]

    nz = lambda v: v not in (None, '', 'None')
    f = lambda v: float(v) if nz(v) else 0.0

    raw = {r['RawNo']: r for r in R('RawMst')}
    qly = {r['QlyNo']: r for r in R('QualityMst')}
    tone = {r['ToneNo']: r for r in R('ToneMst')}
    shape = {r['ShapeNo']: r for r in R('ShapeMst')}
    sizes = R('SizeMst')
    size_by_no = {r['SizeNo']: r for r in sizes}
    common = {r['CommonMasterId']: r for r in R('SPM_CommonMaster')}
    groups = {r['GrpNo']: r for r in R('MainProduct')}

    # RawMitNo: 1 metal, 0/5 diamond, 2/6 colour stone, 3 other, 4 charges.
    KIND = {'1': 'metal', '0': 'diamond', '5': 'diamond', '2': 'stone', '6': 'stone', '3': 'other', '4': 'charge'}

    def karat(q):
        m = re.match(r'^(\d+)(KT)?$', (q or {}).get('QlyCode', '') or '')
        return int(m.group(1)) if m and int(m.group(1)) <= 24 else None


    # Sale rates: chart 2 "Sale Rate" by per-stone weight band, chart 1 "Default" by size group.
    bands_of_detail = {r['RateChartRangeMstDetailId']: (f(r['MinWeight']), f(r['MaxWeight'])) for r in R('RateChartRangeMstDetail')}
    rates = collections.defaultdict(lambda: {'bands': [], 'groups': {}})
    for r in R('RateMst'):
        rate = f(r['SaleRate'])
        if rate <= 0:
            continue
        if r['RateChartId'] == '2' and nz(r['RateChartRangeMstDetailId']) and r['RateChartRangeMstDetailId'] in bands_of_detail:
            lo, hi = bands_of_detail[r['RateChartRangeMstDetailId']]
            rates[r['ItemId']]['bands'].append([lo, hi, rate])
        elif r['RateChartId'] == '1' and nz(r['GSizeNo']):
            rates[r['ItemId']]['groups'][r['GSizeNo']] = rate

    materials = []
    item_code = {}
    for it in R('SPM_Items'):
        rw = raw.get(it['RawNo'], {})
        kind = KIND.get(rw.get('RawMitNo') or '0', 'other')
        if rw.get('RawCode') == 'OG':
            kind = 'other'  # old gold is taken in, never quoted
        q = qly.get(it['QlyNo'])
        rt = rates.get(it['ItemId'])
        sale = None
        if rt and (rt['bands'] or rt['groups']):
            sale = {k: v for k, v in (('bands', sorted(rt['bands'])), ('groups', rt['groups'])) if v}
        m = {
            'code': it['ItemCode'].strip(),
            'name': it['ItemName'].strip(),
            'kind': kind,
            'groupCode': rw.get('RawCode'),
            'groupName': rw.get('RawName'),
            'legacyId': it['ItemId'],
        }
        if kind == 'metal' and rw.get('RawCode') == 'G':
            m['karat'] = karat(q)
        if nz(it['ToneNo']):
            m['tone'] = tone[it['ToneNo']]['ToneCode']
        if nz(it['ShapeNo']):
            m['shape'] = shape[it['ShapeNo']]['ShapeCode']
        if q and kind in ('diamond', 'stone'):
            m['quality'] = q['QlyCode']
        if sale and kind in ('diamond', 'stone'):
            m['saleRates'] = sale
        materials.append({k: v for k, v in m.items() if v is not None})
        item_code[it['ItemId']] = m['code']

    # Item types (MainProduct) — plus ANKLET, which the live ERP has (22 Sep 2026
    # screenshot) but this June backup predates.
    types = [{'code': g['GrpPrefix'], 'name': g['GrpName'], 'kind': 'item_type', 'legacyId': g['GrpNo']} for g in groups.values()]
    if not any(t['code'] == 'AANK' for t in types):
        types.append({'code': 'AANK', 'name': 'ANKLET', 'kind': 'item_type'})
    materials = types + materials

    size_rows = []
    for s in sizes:
        row = {'code': s['SizeName'].strip(), 'sortOrder': int(s['SortOrderNo'] or 0), 'legacyId': s['SizeNo']}
        mm = (s['SizeMM'] or '').strip()
        if mm and mm != row['code']:
            row['mm'] = mm
        if f(s['Pointer']) > 0:
            row['caratPerPiece'] = round(f(s['Pointer']), 4)
        if nz(s['GsizeNo']):
            row['sizeGroup'] = s['GsizeNo']
        size_rows.append(row)

    detail = collections.defaultdict(list)
    for d in R('StyleMstDetail'):
        detail[d['StyleId']].append(d)
    styles = []
    for st in R('StyleMst'):
        lines = []
        for d in sorted(detail.get(st['StyleId'], []), key=lambda d: (d['IsBase'] != 'True', int(d['StyleMstDetailID']))):
            code = item_code.get(d['ItemId'])
            if not code:
                continue
            line = {'code': code, 'weight': round(f(d['NetWeight']), 4)}
            if nz(d['SizeNo']) and d['SizeNo'] in size_by_no:
                line['size'] = size_by_no[d['SizeNo']]['SizeName'].strip()
            if f(d['Pieces']) > 0:
                line['pieces'] = int(f(d['Pieces']))
            lines.append(line)
        row = {'styleCode': st['StyleCode'].strip(), 'lines': lines, 'legacyId': st['StyleId']}
        if st['GrpNo'] in groups:
            row['itemType'] = groups[st['GrpNo']]['GrpPrefix']
        if nz(st['ItemSizeId']) and st['ItemSizeId'] in common:
            row['itemSize'] = common[st['ItemSizeId']]['CommonMasterName']
        styles.append(row)

    out = {'materials': materials, 'sizes': size_rows, 'styles': styles}
    json.dump(out, open(OUT, 'w'), indent=0)
    print(dict(collections.Counter(m['kind'] for m in materials)), len(size_rows), 'sizes', len(styles), 'styles',
          sum(len(s['lines']) for s in styles), 'bom lines', sum(1 for s in styles if not s['lines']), 'styles without lines',
          sum(1 for m in materials if 'saleRates' in m), 'with rates')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
