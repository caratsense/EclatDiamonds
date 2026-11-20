"""Every user table in an APRSSJEP.bak, with its row count and columns.

Read-only. Uses the page reader already written for the item master, so no SQL
Server is involved.

    python bak_tables.py "E:\\ep\\SJEP BACKUP\\APRS-SJEP-2606081711\\APRSSJEP.bak" out.json
"""
import json
import sys
import importlib.util

SRC = r'C:/Users/Shrey/OneDrive/Desktop/Eclat/synceclatcaratsense/bak_item_master.py'
spec = importlib.util.spec_from_file_location('bim', SRC)
bim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bim)


def main(bak, out):
    bim.BAK = bak
    db = bim.Db()
    tables = db.tables()
    result = []
    for name, oid, rows in tables:
        cols = sorted(db.cols.get(oid, []), key=lambda c: c['colid'])
        result.append({
            'table': name,
            'rows': rows,
            'columns': [{'name': c['name'], 'xtype': c['xtype'], 'scale': c['scale']} for c in cols],
        })
    result.sort(key=lambda t: -t['rows'])
    json.dump(result, open(out, 'w', encoding='utf-8'), indent=1)
    total = sum(t['rows'] for t in result)
    print(f'tables: {len(result)}   rows: {total:,}')
    print(f'{"TABLE":45} {"ROWS":>10}  COLS')
    for t in result[:70]:
        print(f'  {t["table"]:43} {t["rows"]:>10,}  {len(t["columns"])}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
