"""Shared handle on the backup: `db` is a ready Db, `TABLES` its inventory.

Read-only. The backup file is never written.
"""
import importlib.util
import json
import os

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
    try:
        return list(db().rows(table))
    except StopIteration:
        return []


def tables():
    return {name: n for name, _oid, n in db().tables()}


def write(name, records, meta=None):
    out = os.path.join(HERE, f'{name}.json')
    json.dump({'entity': name, 'count': len(records), 'meta': meta or {}, 'records': records},
              open(out, 'w', encoding='utf-8'), indent=1, default=str)
    return out
