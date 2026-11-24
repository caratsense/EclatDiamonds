import os
import sys
import unittest
from contextlib import ExitStack
from datetime import datetime
from unittest.mock import Mock, patch


# Make importing the agent deterministic without using a real backend or secret.
os.environ["ECLAT_BASE_URL"] = "http://127.0.0.1:3000"
os.environ["CARATOS_APPROVED_BACKEND_ORIGIN"] = "http://127.0.0.1:3000"
os.environ["CARATOS_AGENT_TOKEN"] = "cxa_test-only"

import sync_sjep  # noqa: E402  (environment must be fixed before module import)


BASE_URL = "http://127.0.0.1:3000"
RESTRICTED_HEADERS = {
    "Authorization": "Bearer cxa_test-only",
    "Content-Type": "application/json",
    "x-caratos-profile-id": "gati-sjep-legacy-v1",
    "x-caratos-profile-hash": "a" * 64,
    "x-caratos-source-instance-hash": "b" * 64,
    "x-caratos-config-revision": "revision-2",
}


class Response:
    def __init__(self, body=None, status=200, json_error=None):
        self.status_code = status
        self.text = "test response"
        self._body = body
        self._json_error = json_error

    def json(self):
        if self._json_error:
            raise self._json_error
        return self._body


def ack(entity, received, upserted=None, skipped=0, watermark="2026-09-08T10:00:00.000Z"):
    if upserted is None:
        upserted = received - skipped
    return {
        "entity": entity,
        "received": received,
        "upserted": upserted,
        "skipped": skipped,
        "watermark": watermark,
    }


class SyncAcknowledgementTests(unittest.TestCase):
    def setUp(self):
        sync_sjep.CHECKPOINT_CONTEXTS.clear()
        sync_sjep.APPROVAL_HEADERS[BASE_URL] = dict(RESTRICTED_HEADERS)

    @patch.object(sync_sjep.requests, "post")
    def test_valid_complete_ack_is_the_only_success_path(self, post):
        post.return_value = Response(ack("parties", 1))

        ok, watermark = sync_sjep.push_chunked(
            "cxa_test-only", BASE_URL, "parties", [{"PartyId": 1}]
        )

        self.assertTrue(ok)
        self.assertEqual(watermark, "2026-09-08T10:00:00.000Z")
        request = post.call_args
        self.assertEqual(request.kwargs["headers"], RESTRICTED_HEADERS)
        self.assertFalse(request.kwargs["allow_redirects"])

    @patch.object(sync_sjep.requests, "post")
    def test_invalid_json_and_inconsistent_counts_reject_http_2xx(self, post):
        cases = (
            Response(json_error=ValueError("not JSON")),
            Response(["not", "an", "object"]),
            Response(ack("wrong-entity", 1)),
            Response({"entity": "parties", "received": 1, "upserted": 1,
                      "skipped": 0}),
            Response(ack("parties", 2, upserted=2)),
            Response(ack("parties", 1, upserted=0, skipped=0)),
            Response(ack("parties", 1, watermark=123)),
        )
        for response in cases:
            with self.subTest(body=response._body):
                post.return_value = response
                ok, watermark = sync_sjep.push_chunked(
                    "cxa_test-only", BASE_URL, "parties", [{"PartyId": 1}]
                )
                self.assertFalse(ok)
                self.assertIsNone(watermark)

    @patch.object(sync_sjep.requests, "post")
    def test_skipped_second_2xx_discards_prior_ack_and_cannot_advance_watermark(self, post):
        old_watermark = "2026-09-01T00:00:00.000Z"
        post.side_effect = (
            Response(ack("parties", 3000, watermark="2026-09-07T00:00:00.000Z")),
            Response(
                ack(
                    "parties",
                    1,
                    upserted=0,
                    skipped=1,
                    watermark="2026-09-08T00:00:00.000Z",
                )
            ),
        )
        records = [{"PartyId": value} for value in range(3001)]

        ok, watermark = sync_sjep.push_chunked(
            "cxa_test-only", BASE_URL, "parties", records
        )
        state = {BASE_URL: old_watermark}
        if ok and watermark:
            state[BASE_URL] = watermark

        self.assertFalse(ok)
        self.assertIsNone(watermark)
        self.assertEqual(state[BASE_URL], old_watermark)
        self.assertEqual(post.call_count, 2)

    @patch.object(sync_sjep.requests, "post")
    def test_raw_skipped_2xx_cannot_advance_per_table_watermark(self, post):
        post.return_value = Response(
            ack("raw:PartyMst", 1, upserted=0, skipped=1)
        )

        ok, watermark = sync_sjep.push_raw(
            "cxa_test-only", BASE_URL, "PartyMst", [{"PartyId": 1}]
        )

        self.assertFalse(ok)
        self.assertIsNone(watermark)
        self.assertFalse(post.call_args.kwargs["allow_redirects"])

    def test_mapped_watermarks_are_per_source_and_survive_interleaving_updates(self):
        state = {BASE_URL: "2026-09-08T12:00:00.000Z"}
        first_ok = {
            "parties": True,
            "products": True,
            "stock": True,
            "sales": True,
            "sale-lines": True,
            "orders": True,
            "order-items": True,
            "bags": True,
            "ledger": True,
            "stock-movements": True,
        }
        first_wm = {
            "parties": "2026-09-08T10:00:00.000Z",
            "products": "2026-09-08T10:05:00.000Z",
            "stock": "2026-09-08T10:10:00.000Z",
            "sales": "2026-09-08T10:15:00.000Z",
            "orders": "2026-09-08T10:20:00.000Z",
            "bags": "2026-09-08T10:25:00.000Z",
            "ledger": "2026-09-08T11:00:00.000Z",
            "stock-movements": "2026-09-08T11:30:00.000Z",
        }

        self.assertTrue(
            sync_sjep.advance_mapped_watermarks(
                state, BASE_URL, first_ok, first_wm
            )
        )
        watermarks = sync_sjep.mapped_watermarks(state, BASE_URL)

        # The old global maximum must not become the parties boundary. A party
        # updated at 10:30 after parties were read but before ledger/movements
        # completed is therefore still selected on the next cycle.
        self.assertEqual(watermarks["parties"], "2026-09-08T10:00:00.000Z")
        self.assertEqual(
            watermarks["stock-movements"], "2026-09-08T11:30:00.000Z"
        )
        self.assertNotEqual(watermarks["parties"], state[BASE_URL])

    def test_checkpoint_keys_are_generation_scoped_and_raw_is_separate(self):
        contexts = (
            {
                "backend": BASE_URL,
                "profileHash": "a" * 64,
                "sourceInstanceHash": "b" * 64,
                "configRevision": "revision-1",
            },
            {
                "backend": BASE_URL,
                "profileHash": "c" * 64,
                "sourceInstanceHash": "b" * 64,
                "configRevision": "revision-1",
            },
            {
                "backend": BASE_URL,
                "profileHash": "a" * 64,
                "sourceInstanceHash": "d" * 64,
                "configRevision": "revision-1",
            },
            {
                "backend": BASE_URL,
                "profileHash": "a" * 64,
                "sourceInstanceHash": "b" * 64,
                "configRevision": "revision-2",
            },
        )
        mapped = []
        for context in contexts:
            sync_sjep.CHECKPOINT_CONTEXTS[BASE_URL] = context
            mapped.append(sync_sjep.mapped_state_key(BASE_URL, "products"))

        self.assertEqual(len(set(mapped)), len(contexts))
        sync_sjep.CHECKPOINT_CONTEXTS[BASE_URL] = contexts[0]
        self.assertNotEqual(
            sync_sjep.mapped_state_key(BASE_URL, "products"),
            sync_sjep.raw_state_key(BASE_URL, "products"),
        )

    def test_dependency_changes_select_unchanged_parent_rows(self):
        base = [{"StyleId": 1}]
        with patch.object(
            sync_sjep,
            "table_columns",
            return_value={"styleid": "StyleId", "metaltoneNo".lower(): "MetalToneNo"},
        ), patch.object(
            sync_sjep, "_base", side_effect=[base]
        ), patch.object(
            sync_sjep,
            "_changed_dependency_values",
            side_effect=[
                {2: datetime(2026, 9, 7, 10, 0, 0)},
                {3: datetime(2026, 9, 8, 10, 0, 0)},
            ],
        ), patch.object(
            sync_sjep,
            "_select_by_values",
            side_effect=[
                [{"StyleId": 2, "MetalToneNo": 8}],
                [{"StyleId": 3, "MetalToneNo": 3}],
            ],
        ):
            result = sync_sjep._dependency_aware_base(
                object(),
                "StyleMst",
                "StyleId",
                "2026-09-01T00:00:00",
                "2026-09-08T00:00:00",
                (
                    ("StyleMstSummary", "StyleId", "StyleId"),
                    ("ToneMst", "ToneNo", "MetalToneNo"),
                ),
            )

        self.assertEqual([row["StyleId"] for row in result], [1, 2, 3])
        self.assertEqual(
            result[-1]["UpdateDate"], datetime(2026, 9, 8, 10, 0, 0)
        )

    def test_child_only_changes_and_changed_parent_children_are_both_selected(self):
        with patch.object(
            sync_sjep,
            "table_columns",
            return_value={
                "jeweltransid": "JewelTransId",
                "updatedate": "UpdateDate",
            },
        ), patch.object(
            sync_sjep,
            "_base",
            return_value=[{"JewelTransId": 2, "JewelId": "changed-child"}],
        ), patch.object(
            sync_sjep,
            "_select_by_values",
            return_value=[{"JewelTransId": 1, "JewelId": "changed-parent"}],
        ):
            result = sync_sjep._extract_child_rows(
                object(),
                "JewelTransInward",
                "JewelTransId",
                [1],
                "2026-09-01T00:00:00",
                "2026-09-08T00:00:00",
            )

        self.assertEqual(
            {row["JewelId"] for row in result},
            {"changed-child", "changed-parent"},
        )

    def test_summary_only_change_becomes_the_outgoing_source_watermark(self):
        parent = {
            "StyleId": 1,
            "UpdateDate": datetime(2026, 9, 1, 10, 0, 0),
        }
        summary = {
            "StyleId": 1,
            "UpdateDate": datetime(2026, 9, 8, 11, 0, 0),
            "MRP": 125000,
        }
        cursor = Mock()
        with patch.object(
            sync_sjep,
            "table_columns",
            return_value={
                "styleid": "StyleId",
                "updatedate": "UpdateDate",
                "mrp": "MRP",
            },
        ), patch.object(sync_sjep, "_wm", return_value=("1=1", [])), patch.object(
            sync_sjep, "rows", return_value=[summary]
        ):
            sync_sjep._merge_1to1(
                cursor,
                [parent],
                "StyleMstSummary",
                "StyleId",
                datetime(2026, 9, 8, 12, 0, 0),
            )

        self.assertEqual(parent["MRP"], 125000)
        self.assertEqual(parent["UpdateDate"], summary["UpdateDate"])
        self.assertIn("WHERE", cursor.execute.call_args.args[0])

    @patch.object(sync_sjep.requests, "post")
    def test_generation_change_prevents_mapped_and_raw_http_upload(self, post):
        with patch.object(
            sync_sjep,
            "heartbeat",
            side_effect=RuntimeError("configuration changed"),
        ):
            self.assertEqual(
                sync_sjep.push_chunked(
                    "unused", BASE_URL, "parties", [{"PartyId": 1}]
                ),
                (False, None),
            )
            self.assertEqual(
                sync_sjep.push_raw(
                    "unused", BASE_URL, "PartyMst", [{"PartyId": 1}]
                ),
                (False, None),
            )
        post.assert_not_called()

    def test_parent_checkpoint_waits_for_child_ack_but_other_sources_advance(self):
        state = {}
        ok = {
            "parties": True,
            "products": True,
            "stock": True,
            "sales": True,
            "sale-lines": False,
            "orders": True,
            "order-items": True,
            "bags": True,
            "ledger": True,
            "stock-movements": True,
        }
        watermarks = {source: f"2026-09-08T10:{index:02d}:00.000Z"
                      for index, source in enumerate(sync_sjep.MAPPED_SOURCES)}

        sync_sjep.advance_mapped_watermarks(state, BASE_URL, ok, watermarks)

        self.assertNotIn(sync_sjep.mapped_state_key(BASE_URL, "sales"), state)
        self.assertEqual(
            state[sync_sjep.mapped_state_key(BASE_URL, "orders")],
            watermarks["orders"],
        )
        self.assertEqual(
            state[sync_sjep.mapped_state_key(BASE_URL, "parties")],
            watermarks["parties"],
        )

    def test_watermark_query_replays_equal_timestamps_and_bounds_future_outliers(self):
        cursor = object()
        upper = "2026-09-08T12:00:00"
        with patch.object(
            sync_sjep,
            "table_columns",
            return_value={"updatedate": "UpdateDate", "entrydate": "EntryDate"},
        ):
            clause, params = sync_sjep._wm(
                cursor,
                "PartyMst",
                "2026-09-08T10:00:00",
                upper,
            )

        # Inclusive lower overlap prevents a row committed later with the same
        # coarse SQL timestamp from being skipped. The captured server-time
        # upper bound prevents a 2099 source typo becoming a permanent boundary.
        self.assertIn(">= CONVERT(datetime, ?)", clause)
        self.assertIn("<= CONVERT(datetime, ?)", clause)
        self.assertEqual(params[-2:], [upper, upper])

    def test_schema_probe_only_swallows_a_genuinely_missing_optional_table(self):
        missing = Mock()
        missing.execute.side_effect = RuntimeError(
            "42S02 [Microsoft][ODBC SQL Server Driver] Invalid object name 'Optional'."
        )
        self.assertEqual(sync_sjep.table_columns(missing, "Optional"), {})

        disconnected = Mock()
        disconnected.execute.side_effect = RuntimeError("08S01 communication link failure")
        with self.assertRaisesRegex(RuntimeError, "communication link failure"):
            sync_sjep.table_columns(disconnected, "PartyMst")

    def test_mirror_continues_after_table_failure_but_returns_failed(self):
        cursor = Mock()
        state = {}
        with patch.object(sync_sjep, "list_tables", return_value=["Broken", "Good"]), patch.object(
            sync_sjep,
            "_wm",
            side_effect=[RuntimeError("bad table"), ("1=1", [])],
        ), patch.object(
            sync_sjep, "rows", return_value=[{"Id": 1, "UpdateDate": "2026-09-08"}]
        ), patch.object(sync_sjep, "pk_columns", return_value=["Id"]), patch.object(
            sync_sjep,
            "push_raw",
            return_value=(True, "2026-09-08T10:00:00.000Z"),
        ) as push, patch.object(sync_sjep, "save_state", return_value=True), patch.object(
            sync_sjep, "heartbeat"
        ):
            ok = sync_sjep.dump_all(
                cursor,
                "unused",
                BASE_URL,
                state,
                "2026-09-08T12:00:00",
            )

        self.assertFalse(ok)
        push.assert_called_once()
        self.assertEqual(
            state[sync_sjep.raw_state_key(BASE_URL, "Good")],
            "2026-09-08T10:00:00.000Z",
        )

    def test_sync_continues_later_entities_and_returns_failed_after_extraction_error(self):
        connection = Mock()
        cursor = connection.cursor.return_value
        cursor.fetchone.return_value = [datetime(2026, 9, 8, 12, 0, 0)]
        original = (
            sync_sjep.DRY_RUN,
            sync_sjep.LIMIT,
            sync_sjep.ONLY,
            sync_sjep.SAMPLE,
            sync_sjep.STORE,
            sync_sjep.ENTITY,
            sync_sjep.BACKENDS,
        )
        sync_sjep.DRY_RUN = False
        sync_sjep.LIMIT = 0
        sync_sjep.ONLY = []
        sync_sjep.SAMPLE = False
        sync_sjep.STORE = ""
        sync_sjep.ENTITY = ""
        sync_sjep.BACKENDS = [BASE_URL]
        try:
            with ExitStack() as stack:
                stack.enter_context(patch.object(sys, "argv", ["sync_sjep.py", "--no-mirror"]))
                def approved_login(base_url):
                    sync_sjep.APPROVAL_HEADERS[base_url] = dict(RESTRICTED_HEADERS)
                    sync_sjep.CHECKPOINT_CONTEXTS[base_url] = sync_sjep._checkpoint_context(
                        base_url
                    )
                    return "cxa_test"

                stack.enter_context(
                    patch.object(sync_sjep, "login", side_effect=approved_login)
                )
                stack.enter_context(patch.object(sync_sjep, "connect_sql", return_value=connection))
                stack.enter_context(patch.object(sync_sjep, "load_state", return_value={}))
                stack.enter_context(patch.object(sync_sjep, "push_stores", return_value=True))
                stack.enter_context(patch.object(sync_sjep, "push_staff", return_value=True))
                stack.enter_context(
                    patch.object(sync_sjep, "extract_parties", side_effect=RuntimeError("SQL read failed"))
                )
                for name in (
                    "extract_items",
                    "extract_stock",
                    "extract_sales",
                    "extract_sale_lines",
                    "extract_orders",
                    "extract_order_items",
                    "extract_bags",
                    "extract_payments",
                    "extract_stock_movements",
                ):
                    stack.enter_context(patch.object(sync_sjep, name, return_value=[]))
                stack.enter_context(
                    patch.object(sync_sjep, "build_book_branch_map", return_value={})
                )
                pushed = stack.enter_context(
                    patch.object(sync_sjep, "push_chunked", return_value=(True, None))
                )
                stack.enter_context(
                    patch.object(sync_sjep, "terminal_heartbeat", return_value=True)
                )

                ok = sync_sjep.sync_once()
        finally:
            (
                sync_sjep.DRY_RUN,
                sync_sjep.LIMIT,
                sync_sjep.ONLY,
                sync_sjep.SAMPLE,
                sync_sjep.STORE,
                sync_sjep.ENTITY,
                sync_sjep.BACKENDS,
            ) = original

        self.assertFalse(ok)
        uploaded_entities = [call.args[2] for call in pushed.call_args_list]
        self.assertNotIn("parties", uploaded_entities)
        self.assertIn("products", uploaded_entities)
        self.assertIn("stock-movements", uploaded_entities)

    def test_dry_run_needs_no_approved_generation_and_never_reads_checkpoint(self):
        connection = Mock()
        cursor = connection.cursor.return_value
        cursor.fetchone.return_value = [datetime(2026, 9, 8, 12, 0, 0)]
        original = (
            sync_sjep.DRY_RUN,
            sync_sjep.LIMIT,
            sync_sjep.ONLY,
            sync_sjep.SAMPLE,
            sync_sjep.STORE,
            sync_sjep.ENTITY,
            sync_sjep.BACKENDS,
        )
        sync_sjep.DRY_RUN = True
        sync_sjep.LIMIT = 0
        sync_sjep.ONLY = []
        sync_sjep.SAMPLE = False
        sync_sjep.STORE = ""
        sync_sjep.ENTITY = ""
        sync_sjep.BACKENDS = [BASE_URL]
        sync_sjep.APPROVAL_HEADERS.clear()
        sync_sjep.CHECKPOINT_CONTEXTS.clear()
        try:
            with ExitStack() as stack:
                stack.enter_context(patch.object(sync_sjep, "connect_sql", return_value=connection))
                stack.enter_context(patch.object(sync_sjep, "load_state", return_value={}))
                stack.enter_context(
                    patch.object(
                        sync_sjep,
                        "mapped_watermarks",
                        side_effect=AssertionError("dry run read an approved checkpoint"),
                    )
                )
                for name in (
                    "extract_parties",
                    "extract_items",
                    "extract_stock",
                    "extract_sales",
                    "extract_sale_lines",
                    "extract_orders",
                    "extract_order_items",
                    "extract_bags",
                    "extract_payments",
                    "extract_stock_movements",
                ):
                    stack.enter_context(patch.object(sync_sjep, name, return_value=[]))
                stack.enter_context(
                    patch.object(sync_sjep, "build_book_branch_map", return_value={})
                )

                self.assertTrue(sync_sjep.sync_once())
        finally:
            (
                sync_sjep.DRY_RUN,
                sync_sjep.LIMIT,
                sync_sjep.ONLY,
                sync_sjep.SAMPLE,
                sync_sjep.STORE,
                sync_sjep.ENTITY,
                sync_sjep.BACKENDS,
            ) = original


if __name__ == "__main__":
    unittest.main()
