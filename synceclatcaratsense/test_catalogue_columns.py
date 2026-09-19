"""The catalogue columns the backend maps must reach it untouched.

The Gati reconciliation (docs/modules/05-catalogue-sources.md) reads these
Inward / InwardSummary / StyleMst columns. The extractors SELECT * and merge the
1:1 summary, so no column list exists to forget one; this pins that behaviour.
"""
import os
import unittest
from unittest.mock import Mock, patch

os.environ["ECLAT_BASE_URL"] = "http://127.0.0.1:3000"
os.environ["CARATOS_APPROVED_BACKEND_ORIGIN"] = "http://127.0.0.1:3000"
os.environ["CARATOS_AGENT_TOKEN"] = "cxa_test-only"

import sync_sjep  # noqa: E402

INWARD = {
    "JewelId": 7, "StyleId": 3, "InwardSKUNo": "11871RG-G-14KT-PG-7", "JewelCode": "TAG-7",
    "ProductCode": "RNG", "InwardQty": 1, "ItemSizeId": 42, "Jewelry_CertificateNo": "IGI-1",
    "MetalToneNo": 5, "Status": "A", "BranchNo": 9, "TagPrice": 60000, "MRP": 61000,
}
SUMMARY = {
    "JewelId": 7, "GrossWt": 4.25, "NetWt": 3.9, "PureWt": 2.28, "TotDiaWt": 0.35,
    "TotDiaPc": 18, "TotCZWt": 0.05, "TotCZPc": 4, "TotMtlAmt": 21000, "MRP": 1,
}
TONE = {"ToneNo": 5, "ToneCode": "PG", "ToneFor": "Gold"}


def cols(row):
    return {k.lower(): k for k in row}


class CatalogueColumnTests(unittest.TestCase):
    def test_stock_rows_carry_every_mapped_column(self):
        tables = {"Inward": INWARD, "InwardSummary": SUMMARY, "ToneMst": TONE}
        results = []

        def execute(sql, *params):
            for name, row in tables.items():
                if f"FROM {name} " in sql or f"FROM [{name}] " in sql:
                    results.append([dict(row)])
                    return
            raise AssertionError(sql)

        cursor = Mock()
        cursor.execute.side_effect = execute
        with patch.object(sync_sjep, "table_columns", side_effect=lambda c, t: cols(tables[t])), \
                patch.object(sync_sjep, "rows", side_effect=lambda c: results.pop(0)):
            (row,) = sync_sjep.extract_stock(cursor)

        for col in ("StyleId", "ProductCode", "InwardQty", "ItemSizeId", "Jewelry_CertificateNo",
                    "GrossWt", "NetWt", "PureWt", "TotDiaWt", "TotDiaPc", "TotCZWt", "TotCZPc",
                    "TotMtlAmt", "ToneCode", "ToneFor", "BranchNo", "TagPrice"):
            self.assertIn(col, row)
        self.assertEqual(row["MRP"], 61000)  # Inward wins over the summary on a clash
        self.assertEqual(row["TotCZPc"], 4)


if __name__ == "__main__":
    unittest.main()
