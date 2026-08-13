# Eclat ↔ Gati (APRS-SJEP) Data Contract

> The exact field mapping the sync relies on, per entity. Derived strictly from
> the extractor payloads (`synceclatcaratsense/sync_sjep.py`) and the backend
> `SyncService`. **Nothing here is invented** — mappings that cannot be
> established without live Gati access are marked **BLOCKED / CLIENT INPUT
> REQUIRED**. See [MULTI_STORE.md](MULTI_STORE.md) for store attribution rules.

## Architecture
**ONE Gati SQL Server / ONE database (`APRSSJEP`) containing all stores.** Stores
are rows split by branch id inside that one DB, never separate databases. A
per-store-DB topology (B) is **not supported today** — smallest extension:
loop the agent over `(db, storeLegacyId)` pairs and force-stamp `EclatBranchId`
(no backend change). **BLOCKED: client must confirm one-DB vs per-store-DB.**

Conventions below: every entity keys on a `legacyId` and upserts idempotently;
"watermark" = agent `UpdateDate` else `EntryDate`; "store attr" = the branch
columns `branchResolver` tries in order; a row with a null identity key is
skipped (never guessed).

---

## 1. Stores — `PartyMst` (branch subset) → `Store`
| Gati field | Eclat field | id key | store attr | watermark | transform | null/fail |
|---|---|---|---|---|---|---|
| PartyNo | Store.legacyId | ✔ | self | full pull | trim | required; skip if blank |
| FirmName/LegalName | name | | | | fallback chain | required; skip if missing |
| FirmCity, PartyCode | city, code | | | | | opt |
| FirmAdd1/2/3, FirmState, PinCode, FirmCountry, phone/mobile, FirmEmail, AccGst | address…, gstin | | | | add3 folds into line2 | opt; keeps stored value if omitted |
New branch → `status:'pending', isActive:false`; coordinates absent in Gati (`missingGeo`).

## 2. Staff — `PartyMst WHERE IsSalesMan=1` → `User`
| Gati field | Eclat field | id key | store attr | transform | null/fail |
|---|---|---|---|---|---|
| PartyNo | User.legacyId | ✔ | BranchNo/LocationId | | required; skip if blank |
| FirmName | name | | | | required |
| FirmEmail | email | | | lowercased; **clash → skip + conflict**, else synthetic `staff-<id>@imported.invalid` | placeholder |
| mobile/tele | phone | | | | opt |
Imported `role:'salesperson', isActive:false, passwordHash:null` — cannot log in until HO activates. **BLOCKED: `SPM_Users` designation is not read → staff designation/role always null (CLIENT INPUT if role import wanted).**

## 3. Customers / Parties — `PartyMst` → `Party`
| Gati field | Eclat field | id key | store attr | watermark | null/fail |
|---|---|---|---|---|---|
| PartyNo | Party.legacyId | ✔ | EclatBranchId→BranchNo→LocationId | UpdateDate/EntryDate | required; skip if null |
| IsCustomer/IsSupplier/IsSalesMan/IsLocation\|IsFactory/IsAccount | types[] | | | | bool→tags |
| FirmName/LegalName/PartyCode | name | | | | fallback chain |
| tele/mobile, WhatsAppNo, FirmEmail | phone, whatsapp, email | | | | opt |
| address fields, AccGst, FirmPan, AadhaarNo, birth/anniversary, CreditLimit, IsBlackList | address…, gstin, pan, aadhaar, birthday, anniversary, creditLimit, isBlacklisted | | | | opt; country default 'India' |

## 4. Products / Designs — `StyleMst` (+Summary +ToneMst) → `Product`
| Gati field | Eclat field | id key | store attr | transform | null/fail |
|---|---|---|---|---|---|
| StyleId | Product.legacyId | ✔ | **GLOBAL → storeId null** (company-wide) | | required; skip if null |
| ToneFor+ToneCode | metal, karat | | | `metalFromTone` — **see §Karat** | |
| StyleSKUNo/StyleCode | sku, name | | | `STYLE-<id>` fallback | |
| (all text) | category | | | `categoryFromRow` keyword scan → 'other' | |
| GrossWt/ModelWt, TotDiaWt, MRP/TagPrice/EndClientPrice, WebDescription, BestSeller | weightGrams, caratWeight, price, description, bestSeller | | | first non-null; '0' default | opt |

## 5. Stock — `Inward` (+Summary +ToneMst) → `StockItem`
| Gati field | Eclat field | id key | store attr | watermark | transform | null/fail |
|---|---|---|---|---|---|---|
| JewelId | StockItem.legacyId | ✔ | EclatBranchId→**BranchNo**→LocationId→FirstLocationId | UpdateDate/EntryDate | | required; skip if null |
| StyleId | productId (FK) | | | | via idMap; null if design not imported | opt |
| Status | status | | | | `stockStatusFromInward` (16-letter `Const_InwardStatus` map; only A=in_stock; unknown letter→transferred + **reported**) | unknown→not sellable |
| ToneFor+ToneCode | metal, karat | | | | **see §Karat** | |
| SKU/JewelCode, weights, diamond/stone, amounts, HallMarkId, cert, InwardDate | sku, name, weights, diamond…, amounts, hallmarkNo, certificateNo, inwardDate | | | | | opt |
| HUID | huid | | | | (entered in Eclat; not in legacy today) | opt |
**Source-of-truth guard (approved, live):** a piece mid/post Eclat transfer
(`ho_approved`/`dispatched`/`received`/`acknowledged`) keeps its Eclat
`storeId`+`status`; the sync updates every OTHER Gati-owned field. Tested.

## 6. Sales (headers) — `JewelTrans` → `Sale`
| Gati field | Eclat field | id key | store attr | transform | null/fail |
|---|---|---|---|---|---|
| JewelTransId | Sale.legacyId | ✔ | **EclatBranchId** (BookMaster) | | required; skip if null |
| PartyNo | partyId | | | idMap; null if missing | opt |
| TranType | docType | | | `docTypeFromTranType` (JWSL→sale, *BA*→branch_transfer, …) → default 'sale' | |
| prefix+no+id, JewelTransDate, GrossAmount/Amount, Remarks, isCancel | docNo, docDate, amounts, remarks, **isCancelled** | | | soft-cancel aware | '0' defaults |

## 7. Sale lines — `JewelTransInward` → `SaleLine`
| Gati field | Eclat field | id key | store attr | null/fail |
|---|---|---|---|---|
| JewelTransId+JewelId+SrNo | SaleLine.legacyId (composite) | ✔ | inherits sale | skip if parent Sale not imported |
| JewelId | stockItemId | | | idMap; null if piece missing |
| NetWt, amounts, DiscountAmt, MRP | netWeight, metalAmount, makingAmount, stoneAmount, discountAmount, lineTotal | | | '0' defaults |

## 8. Payments — **BLOCKED / CLIENT INPUT REQUIRED**
Only the **`Journal`** day-book is wired → `LedgerEntry` (double-entry incl. GST
postings; `TranType`→kind/side; EclatBranchId store attribution; skip if Id/Amount
null). **Real customer receipts with payment MODE (UPI/card/cash) are NOT
extracted** — `VoucherEntry` is unmapped and Module 12 (Payment Collection) has
**no Gati source wired**. **CLIENT INPUT REQUIRED:** confirm `VoucherEntry` (or
the correct table) is the authoritative receipts/mode source and its key columns
(voucher id, mode, amount, date, party, sale reference). Until then a
`VoucherEntry` extractor + `POST /sync/payments` route must NOT be guessed.

## 9. Orders — `Spm_MfgOrder` → `ManufacturingOrder`
| Gati field | Eclat field | id key | store attr | transform | null/fail |
|---|---|---|---|---|---|
| OrderId | ManufacturingOrder.legacyId | ✔ | **EclatBranchId** (BookMaster) | | required; skip if null |
| MadeFor_PartyNo/CustomerId | partyId | | | idMap; null if missing | opt |
| prefix+OrderNo/Id, OrderDate, Amount/GrossAmount, PoNo | orderNo, orderDate, amount, poNo | | | | |
| OrderStatus | status (EclatStage) | | | agent `stage_map.json` (per-install); **unknown → 'booked'** | see §Manufacturing |

## 10. Order items — `SPM_MfgOrderItem` → order item
| Gati field | Eclat field | id key | store attr | null/fail |
|---|---|---|---|---|
| OrderItemId | legacyId | ✔ | inherits order | skip if order not imported / null id |
| OrderId, SKUNo, SpecialRemarks, OrderQty, Completed, ExpDelDate, Inward_JewelId | orderId, styleSku, description, orderQty(≥1), status, expectedDelivery, producedStockItemId | | | idMap; null if piece missing |

## 11. Manufacturing (bags) — `SPM_BagMaster` (+`SPM_DepartmentMst`) → `ProductionBag`
| Gati field | Eclat field | id key | store attr | transform | null/fail |
|---|---|---|---|---|---|
| BagId | ProductionBag.legacyId | ✔ | inherits order | | required; skip if null |
| OrderId | orderId | | | idMap; null allowed | opt |
| BagNo, BagBarcode, DepartmentId→Name, BagStatus, weights, IsBagComplete, BagDate | bag fields | | | dept name via join | |
| DepartmentId → EclatStage | (advances order header) | | | agent `stage_map.json`; **furthest stage wins, never backward, cancelled terminal, unmapped dept reported** | |
**`stage_map.json` is per-install and BLOCKED until the client's real
`OrderStatus`/`DepartmentId` codes are confirmed** (see `stage_map.example.json`).
Without it, orders stay `booked`.

## 12. Photos — `StyleMst.ImageName` / `Inward.ImageName` → `Product`/`StockItem.imageUrl`
Agent (`sync_media.py`) reads the filename from the DB, finds the file under
`SJEP_IMAGE_ROOT`, uploads **bytes → R2** (resized), and POSTs only the URL to
`/sync/product-images` (`kind=product` → Product, `kind=stock` → StockItem).
Idempotent via `uploaded_media.json`; missing file → counted + skipped (non-fatal);
row not yet synced → update throws → caught → skip (retried next run).
**Stock/catalogue photos are Gati-only — no website upload path writes
`StockItem.imageUrl`.** **CLIENT INPUT REQUIRED for live retrieval:** photo folder
path (`SJEP_IMAGE_ROOT`), network read access, customer-safe subfolder selection,
R2 credentials.

## 13. Custom-order linkage — **BLOCKED / CLIENT PROCESS INPUT REQUIRED** (OP-25)
`CustomOrder` is Eclat-native (no `legacyId`, no relation to
`ManufacturingOrder`/`ProductionBag`). There is **no deterministic key** tying a
Gati production order/bag to an Eclat custom order. It must NOT be inferred from
customer name / item description / amount / date. **CLIENT INPUT REQUIRED:** either
(a) a Gati field carrying the Eclat CO reference, (b) a physical bag-barcode ↔ CO
link entered in Eclat, or (c) an explicit mapping table.

---

## Karat / purity — **BLOCKED / CLIENT INPUT REQUIRED**
Gati carries **no per-piece karat** in this pipeline (only a `ToneMst`
tone/rose marker; a `RateChart`/caratage join does not exist). As of 2026-08-13
the sync no longer asserts a default 22K: a plain gold piece maps to
**`gold_unspecified` with `karat = null`** (physical `StockItem`) — an honest
"gold, purity unknown" — while a genuine rose/pink tone maps to `rose_gold_18k`.
**CLIENT INPUT REQUIRED:** the authoritative per-piece purity source (a
`RateChart`/tone→caratage table, or a `Caratage`/`Purity` column). Until provided,
Gati gold reads as unspecified rather than a false karat.

## Consolidated client inputs required
1. Topology — one Gati DB vs per-store DB.
2. Per-piece **karat/purity** source.
3. **Payments** — confirm `VoucherEntry` is the receipts/mode table + key columns.
4. **Photos** — `SJEP_IMAGE_ROOT`, network access, customer-safe subfolders, R2 creds.
5. Branch attribution — confirm branch column per table + that `BookMaster` books are per-branch (run `discover.bat`).
6. **Manufacturing** — real `OrderStatus`/`DepartmentId` codes for `stage_map.json`.
7. **Custom-order** ↔ Gati linkage mechanism.
8. `SPM_Users` — if staff designation import is wanted.
