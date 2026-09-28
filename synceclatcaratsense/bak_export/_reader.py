"""Shared handle on the backup: `db` is a ready Db, `TABLES` its inventory.

Read-only. The backup file is never written.

Two sources, one shape. By default rows come out of an APRSSJEP.bak. Set
SJEP_CSV_DIR to a SJEP_Master_Export `all_data` folder and they come out of
that export's CSVs instead, typed from its data dictionary so every extractor
sees the same Python values (datetime, Decimal, int, bool, None) either way.
The 4 Aug 2026 export is two months newer than the newest backup on disk.
"""
import csv
import importlib.util
import json
import os
from datetime import datetime
from decimal import Decimal

CSV_DIR = os.environ.get('SJEP_CSV_DIR')

BAK = os.environ.get('SJEP_BAK', r'E:/ep/SJEP BACKUP/APRS-SJEP-2606081711/APRSSJEP.bak')
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = r'C:/Users/Shrey/OneDrive/Desktop/Eclat/synceclatcaratsense/bak_item_master.py'

_spec = importlib.util.spec_from_file_location('bim', SRC)
bim = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bim)
bim.BAK = BAK

_db = None


def db():
    """One Db per process; building it re-reads the catalog, so share it."""
    global _db
    if _db is None:
        _db = bim.Db()
    return _db


def rows(table):
    """Every row of a table as a dict, or [] when the table is absent."""
    if CSV_DIR:
        return _csv_rows(table)
    try:
        return list(db().rows(table))
    except StopIteration:
        return []


def tables():
    if CSV_DIR:
        manifest = os.path.join(os.path.dirname(os.path.normpath(CSV_DIR)), '_ALL_MANIFEST.csv')
        with open(manifest, encoding='utf-8-sig') as fh:
            return {r['Table']: int(r['Rows']) for r in csv.DictReader(fh)}
    return {name: n for name, _oid, n in db().tables()}


# ------------------------------------------------------------ the CSV source

_INT = {'int', 'bigint', 'smallint', 'tinyint'}
_DEC = {'decimal', 'numeric', 'money', 'smallmoney'}
_FLOAT = {'float', 'real'}
_DATE = {'datetime', 'datetime2', 'smalldatetime', 'date'}
_types_cache = None


def _types():
    """table -> {column: SQL type}, from the export's own data dictionary."""
    global _types_cache
    if _types_cache is None:
        path = os.path.join(os.path.dirname(os.path.normpath(CSV_DIR)), '_ALL_DATA_DICTIONARY.csv')
        _types_cache = {}
        with open(path, encoding='utf-8-sig') as fh:
            for r in csv.DictReader(fh):
                _types_cache.setdefault(r['Table'], {})[r['Column']] = r['DataType'].lower()
    return _types_cache


def _date(v):
    # The export writes dd/mm/yy with a time; a bare date appears on date columns.
    for fmt in ('%d/%m/%y %H:%M:%S', '%d/%m/%Y %H:%M:%S', '%d/%m/%y', '%d/%m/%Y', '%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.strptime(v, fmt)
        except ValueError:
            pass
    raise ValueError(f'unreadable date {v!r}')


def coerce(value, sql_type):
    """One CSV cell as the value the .bak reader would have produced."""
    if value is None:
        return None
    if value == '':
        # A CSV cannot tell NULL from an empty string; only text keeps ''.
        return '' if sql_type not in _INT | _DEC | _FLOAT | _DATE | {'bit'} else None
    if sql_type in _INT:
        return int(Decimal(value))
    if sql_type in _DEC:
        return Decimal(value)
    if sql_type in _FLOAT:
        return float(value)
    if sql_type == 'bit':
        return value.strip().lower() in ('1', 'true')
    if sql_type in _DATE:
        return _date(value.strip())
    return value


def _csv_rows(table):
    path = os.path.join(CSV_DIR, f'{table}.csv')
    if not os.path.exists(path):
        return []
    types = _types().get(table, {})
    csv.field_size_limit(10**8)
    with open(path, encoding='utf-8-sig', newline='') as fh:
        return [{k: coerce(v, types.get(k, 'varchar')) for k, v in r.items()} for r in csv.DictReader(fh)]


def demo():
    assert coerce('4276182.0000', 'decimal') == Decimal('4276182')
    assert coerce('', 'decimal') is None and coerce('', 'varchar') == ''
    assert coerce('13/04/26 00:00:00', 'datetime') == datetime(2026, 4, 13)
    assert coerce('True', 'bit') is True and coerce('0', 'bit') is False
    assert coerce('29', 'bigint') == 29
    print('demo ok')


if __name__ == '__main__':
    demo()


def write(name, records, meta=None):
    out = os.path.join(HERE, f'{name}.json')
    json.dump({'entity': name, 'count': len(records), 'meta': meta or {}, 'records': records},
              open(out, 'w', encoding='utf-8'), indent=1, default=str)
    return out
