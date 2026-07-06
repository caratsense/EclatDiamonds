# Legacy Schema — APRS-SJEP (Gatisofttech "SJE Plus")

> Source DB: `APRSSJEP_eclat` on `localhost\SQLEXPRESS` (a restored throwaway copy of `APRSSJEP.bak`).
> Read-only analysis. Generated 2026-06-16. Originals never modified.

## 0. Overview & key facts

- **Total user tables: 1,102.** This is a packaged jewelry-manufacturing ERP, so the vast majority of tables are *unused feature/integration tables* (web storefront, Tally/Shopify/CaratLane/Diaspark/Centra connectors, tools, export pricing, scheme, CRM questionnaires, etc.). **Roughly 920 tables have 0 rows.** Real operational data lives in ~150 tables.
- The business uses this primarily as a **manufacturing + inventory + billing** system. The single richest data domain is **Inward / Jewel stock** (individual jewellery pieces) and **Bag-based manufacturing (SPM_*)**.
- Data is recent: most transaction `EntryDate` values fall in **March–June 2026** (this looks like a fresh/seeded install, not years of history).
- **Naming model:** a piece of jewellery = an `Inward` row keyed by `JewelId`. Master design = `StyleMst` (`StyleId`). Party/customer/supplier/branch/salesman/account are ALL rows in **`PartyMst`** (`PartyNo`) distinguished by boolean flags (`IsCustomer`, `IsSupplier`, `IsSalesMan`, `IsFactory`, `IsLocation`, `IsAccount`, `IsSchemeMember`, …). Sales/purchase invoices = `JewelTrans` (`JewelTransId`), with `TranType` selecting the document kind. Manufacturing orders = `Spm_MfgOrder`. Accounting = `Journal` + `VoucherEntry` over a `Heads`/`SubHeads`/`PartyMst` ledger.

---

## 1. Table inventory (populated tables, by row count desc)

Only tables with rows are listed. (920+ empty tables omitted — they are dormant ERP features. Notable empty-but-structurally-central ones are listed in §1b.)

| Table | Rows |
|---|---:|
| Const_PortCode | 72,830 |
| BookMasterConfigurationValue | 19,482 |
| JewelTransInwardDetail | 14,507 |
| JewelTransInwardExploration | 13,800 |
| InwardCatch | 13,162 |
| InwardDetail | 11,685 |
| SPM_MaterialStock | 9,754 |
| InwardHistory | 7,175 |
| SPM_MfgOrderItemDetail | 4,973 |
| SPM_MaterialTransDetail | 4,168 |
| SPM_BagMaterialView | 3,738 |
| SPM_BagMaterial | 3,738 |
| SPM_BagTransaction | 3,716 |
| SPM_BagTransactionSummary | 3,716 |
| InwardExploration | 3,673 |
| StyleMstDetail | 3,633 |
| BagTransactionAutoConversionMetal | 3,392 |
| Const_StateMst | 3,309 |
| JewelTransInwardFormula | 3,275 |
| JewelTransInwardSummary | 3,275 |
| JewelTransInward | 3,275 |
| StyleMstCatch | 2,784 |
| InwardSummary | 2,690 |
| InwardFormula | 2,690 |
| Inward | 2,690 |
| JewelTransXtraCharges | 2,341 |
| InwardExplorationView | 2,196 |
| InwardXtraCharges | 1,956 |
| SPM_BagMaterialAutoConversion | 1,819 |
| SPM_MaterialTrans | 1,290 |
| RateMst | 1,227 |
| SPM_MfgOrderItem | 1,220 |
| SPM_MfgOrderItemFormula | 1,220 |
| SPM_MfgOrderItemSummary | 1,220 |
| AccountBalance | 1,128 |
| OrderProceedItem | 1,109 |
| SPM_BagMaster / Summary / Tree | 1,102 each |
| IMPORT_INWARDDETAIL | 959 |
| JewelTransMetalRate | 956 |
| SPM_RoleMasterMenu | 919 |
| SPM_GenerateData | 914 |
| SPM_DynamicItems | 908 |
| SPM_BagTransactionFormula | 848 |
| StyleMst / StyleMstFormula / StyleMstSummary | 753 each |
| JewelTransAddless | 696 |
| BookMasterConfiguration | 674 |
| BookMasterReport | 632 |
| PartyMst | 564 |
| AdSetupDetail | 564 |
| SizeMst | 529 |
| SPM_MfgOrderAddless | 486 |
| SPM_MfgOrderMetalRate | 484 |
| **Journal** | 475 |
| DayBookLoss | 456 |
| LoginSession | 304 |
| BookMaster | 254 |
| JewelTrans | 239 |
| RateChartRangeMstDetail | 243 |
| GSizeShapeMst | 241 |
| Const_CountryMst | 242 |
| IMPORT_INWARD | 220 |
| MaterialTransMetalRate | 180 |
| DueDetail | 169 |
| SPM_Items | 167 |
| Spm_MfgOrder | 121 |
| OrderProceed | 109 |
| AdSetup | 95 |
| RateChartRangeMst | 75 |
| MetalRateMst | 44 |
| SettlementDetail | 44 |
| SPM_UsersAccount | 50 |
| Settlement | 12 |
| **VoucherEntry** | 13 |
| OMS_Order | (table present; low) |
| SPM_Users | 15 |
| Company | 2 |
| RawMst | 23 | Heads | 29 | SubHeads | 31 | QualityMst | 14 | ToneMst | 12 | MainProduct | 9 |

(Const_PortCode, Const_StateMst, Const_CountryMst, BookMasterConfigurationValue are static reference/config data, not business transactions.)

### 1b. Structurally central tables that are currently EMPTY (0 rows)
These define capabilities the business has **not yet used** but Eclat may need to map:
`SchemeMaster / SchemeMemberMaster / SchemeMemberInstalment / Scheme_InstalmentReceived` (gold savings scheme — **defined, no data**), `GiftcodeMaster / PromocodeMaster` (vouchers/coupons — empty), `LabourAttendance / OffDayMaster / HolidayMaster` (HR/attendance — empty), all `CRM_*`, `OMS_Order*`, `TabletEntry*`, `Web_*`, `WhatsAppProvider/Setting`, `PDC*` (post-dated cheques), `CourierTransaction*`, `Tr_Tree*` and many integration connectors.

---

## 2. Important tables in detail

### Customer / Party master — `PartyMst` (564 rows) — PK `PartyNo` (varchar)
The universal account/contact table. Role flags select what each row *is*.
Key columns: `PartyNo` (PK), `FirmName`, `LegalName`, `PartyCode`, `FirmAdd1-3`, `FirmCity/State/Country/PinCode`, `FirmEmail`, `FirmTele`, `OwnerMobile`, `WhatsAppNo`, `AccGst`, `FirmPan`, `AadhaarNo`, `UdyamRegistrationNumber`, `IsGSTRegistered`, `IsMSMERegistered`, `CreditLimit`, `CurrencyNo`, `HeadNo`→Heads, `SubHeadNo`→SubHeads, `BranchNo`/`LocationId`/`ControlAccNo`/`SalesPersonNo` (all self-FK to PartyMst), `RateChartId`, `LabourChartId`, `TermNo`, plus role bits: `IsCustomer, IsSupplier, IsSalesMan, IsFactory, IsLocation, IsAccount, IsMainClient, IsSchemeMember, IsBlackList, IsServiceClient, IsTools`. Audit: `EntryDate`, `UpdateDate`, `EntryBy`, `UpdateBy`.

### Item / piece stock — `Inward` (2,690 rows) — PK `JewelId` (identity bigint)
One row per physical jewellery item in stock. The catalogue/inventory heart.
Key columns: `JewelId` (PK identity), `JewelCode`, `JewelAliasNo`, `InwardSKUNo`, `ProductCode`, `StyleId`→StyleMst, `GrpNo`→MainProduct, `SubItmNo`→SubProduct, `StockTypeNo`, `MakeTypeNo`, `MetalToneNo`→ToneMst, `ItemSizeId`, `BranchNo/CompanyId/LocationId/FirstLocationId`→PartyMst, `BagId`→SPM_BagMaster, `InwardDate`, `InwardType` (Z/B/R/W/I — see below), `InwardQty`, `ItemPieces`, `Status`, `MRP`, `TagPrice`, `EndClientPrice`, `RateChartId`, `HSNId`, `HallMarkId`, `Jewelry_CertificateNo`, `ImageName/ImageExt/STLImageName`, order linkage `PO_OrderId/PO_OrderItemId/Order_*`, `SaleId`/`PurchaseId`→JewelTrans, audit `EntryDate/UpdateDate/EntryBy/UpdateBy`.
`InwardType` distribution: **Z=842, B=759, R=580, W=499, I=10** (these are stock states/categories — e.g. work/raw/repair; exact decode TBD — see ambiguities).

### Item weight/amount rollup — `InwardSummary` (2,690 rows, 1:1 with Inward) — PK `JewelId`
The fields the .repx reports bind to: `GrossWt`, `NetWt`, `PureWt`, `MetalLossWt`, `MRP`, `COST`, `ActualMRP`, and a large set of `Tot*` columns: `TotDiaAmt/TotDiaWt/TotDiaPc`, `TotCZ*`, `TotMtlAmt`, `TotSettingAmt`, `TotHandlingAmt`, `TotCPFAmt`, `TotLossAmt`, `TotXchgAmt`, plus `*CostAmt` mirrors. **This is where GrossWt/NetWt/DiaWt/DiaAmt/StoneAmt/CPF live.**

### Item line components — `InwardDetail` (11,685 rows) — PK `JewelDetailID` (bigint), FK `JewelId`→Inward
Component breakdown of each piece (metal / diamond / stone / setting / handling rows). Columns: `ItemId`→SPM_Items, `SizeNo`, `NetWeight`, `Pieces`, `Rate`, `Amount`, `CPFRate/CPFAmt`, `HandRate/HandAmount`, `SetRate/SetAmount`, `LossWeight/LossAmt`, `IsBase`, `IsCenterStone`, `DescriptionId`, plus `*Cost*` mirrors. `InwardCatch` (13,162) and `InwardFormula` (2,690) are companions (catch = component pointer rows, formula = pricing formula). `InwardXtraCharges` (1,956) = extra charges per piece. `InwardExploration`/`InwardExplorationView` (3,673/2,196) = dynamic/custom attribute values per piece (EAV pattern via `ExplorationId`). `InwardHistory` (7,175, PK `Id` identity) = full movement/location/transaction log per JewelId (links JewelTransId, OrderId, ProceedId, LocationId, `TransactionDate`, `Jstatus`).

### Design / Style master — `StyleMst` (753 rows) — PK `StyleId` (identity bigint)
The product *design* template (vs `Inward` = physical instance). Columns mirror Inward: `StyleCode`, `StyleSKUNo`, `MfgCode`, `GrpNo`, `MetalToneNo`, `ModelWt`, `WaxWt`, `TagPrice`, `EndClientPrice`, image fields, `BestSeller`, production instructions (`CustomerProductionInstruction`, `DiamondInstruction`, `RhodiumInstruction`, …). Children: `StyleMstDetail` (3,633, components), `StyleMstSummary` (753, weights/amounts), `StyleMstFormula`, `StyleMstCatch`, `StyleMstXtraCharges`.

### Sales / purchase invoice header — `JewelTrans` (239 rows) — PK `JewelTransId` (identity bigint)
The billing document (sale, purchase, branch transfer, proforma…). `TranType` distinguishes them (counts observed):
`JWSL` sale=92, `JWBAP`=49, `JWBAI`=46, `BJWSL`=24, `BJWPH`=17, `JWPH` purchase=9, `JWPRM` proforma=2. (`SL`=sale, `PH`=purchase, `BAP/BAI`=branch transfer approval/issue, `B`-prefix = branch variant, `PRM`=proforma — decode partly inferred.)
Columns: `JewelTransNo`+`JewelTransPrefix` (document number), `JewelTransDate`, `PartyNo`→PartyMst, `SalesPersonNo`→PartyMst, `BookNo`→BookMaster, `OrderId`→Spm_MfgOrder, `Amount/GrossAmount/TotalAddlessAmount`, `IsGSTRegistered`, `PlaceOfSupply`, `BillingTypeId`, `RateChartId`, `LabourChartId`, `Remarks`, `isCancel`, `ParentJewelTransId` (self), audit `EntryDate/UpdateDate/EntryBy/UpdateBy`, `JewelTransUniqueId` (uniqueidentifier).
Lines & rollups (all keyed by JewelTransId, mostly also JewelId→Inward):
- `JewelTransInward` (3,275) — invoice line = a JewelId on a bill; carries discount/markup, MRP.
- `JewelTransInwardDetail` (14,507) — component-level pricing snapshot on the bill (NetWeight, Rate, CPF, Hand, Set, Loss).
- `JewelTransInwardSummary` (3,275) — per-line weight/amount totals (NetWt, PureWt, TotDiaAmt, TotMtlAmt, TotCPFAmt…).
- `JewelTransInwardFormula` (3,275), `JewelTransInwardExploration` (13,800 — EAV custom fields), `JewelTransXtraCharges` (2,341), `JewelTransAddless` (696 — add/less charges, promocode), `JewelTransMetalRate` (956 — metal rate snapshot per RawNo).

### Manufacturing order — `Spm_MfgOrder` (121 rows) — PK `OrderId` (identity bigint)
Customer/internal production order. Columns: `OrderNo`+`OrderPrefix`, `OrderDate`, `CustomerId`/`MadeFor_PartyNo`/`SalesPersonNo`→PartyMst, `BookNo`, `PoNo`/`PoDate`, `WorkOrderNo`, `OrderStatus` (int), `Amount/GrossAmount`, `RateChartId`, `LabourChartId`, audit `EntryDate/UpdateDate`. Lines: `SPM_MfgOrderItem` (1,220, PK `OrderItemId` identity) → `StyleId`, `MetalItemId`, `OrderQty`, `ExpDelDate`, `PrdDelDate`, `Completed`, `IsHold`, instructions, `Inward_JewelId` (the produced piece). Children `SPM_MfgOrderItemDetail` (4,973), `…Summary/Formula` (1,220 each), `SPM_MfgOrderAddless/MetalRate`.

### Order proceed (order→stock fulfilment) — `OrderProceed` (109) / `OrderProceedItem` (1,109)
`OrderProceed` PK `OrderProceedId` (identity), `OrderProceedNo`, `PartyNo`, `BookNo`, `OrderProceedDate`. `OrderProceedItem` PK `OrderProceedItemId` (identity) links `OrderId`→Spm_MfgOrder, `OrderItemId`→SPM_MfgOrderItem, `JewelId`→Inward, `Qty`, `OrderProceedStatus`. This is the order-to-delivery/status bridge.

### Manufacturing bag system — `SPM_BagMaster` (1,102) — PK `BagId` (identity bigint)
Shop-floor "bag/lot" through production (matches the .repx Bag-movement reports). Columns: `BagNo`, `BagBarcode`, `BagTypeId`, `BagDate`, `BagStatus`, `DepartmentId`→SPM_DepartmentMst, `CompanyId`→PartyMst, `OrderId`/`OrderItemId`, `MetalItemId`, `GrossWt/NetWt`, `ProductionRouteId`, `IsBagComplete`, `Finalize_JewelId`→Inward. Related high-volume: `SPM_BagMaterial` (3,738), `SPM_BagTransaction` (3,716) + `…Summary/Formula`, `BagTransactionAutoConversionMetal` (3,392). Material inventory: `SPM_MaterialStock` (9,754, PK `Id` identity — current stock ledger of metal/stone), `SPM_MaterialTrans` (1,290, PK `MaterialTransId` identity) + `SPM_MaterialTransDetail` (4,168). `SPM_Items` (167) = the metal/stone item master, `SPM_DynamicItems` (908).

### Accounting — `Journal` (475) / `VoucherEntry` (13) / ledger
- `Journal` — PK `Id` (identity) — double-entry rows: `DrAccountNo`/`CrAccountNo`→PartyMst, `Amount`, `Jdate`, `BookNo`, `TransNo`/`TransPrefix`, `TranType`, `SettlementId`, `EntryDate`. Core day-book. (`DayBookLoss` 456 = weight-loss day book.)
- `VoucherEntry` — PK `VoucherEntryId` (identity) — cash/bank/journal vouchers + receipts. Links `PartyNo`, `JewelTransId`, `OrderId`, `MaterialTransId`, `SchemeMemberId`, `ModeOfPayment`, `Amount`, `KasarAmount`, `Scheme_MetalWt/MetalRate`. `VoucherEntryDetail` = narration columns (Col1..Col10).
- `Heads` (29) / `SubHeads` (31) — chart-of-accounts groups (`HeadName`, `Side` Dr/Cr, `ParentHeadNo`). `PartyMst` rows with `IsAccount` are the ledgers under them.
- `AccountBalance` (1,128) — PK (`CompCode`,`PartyNo`) — opening/running balances (`AccDebit`, `AccCredit`, currency variants).
- `DueDetail` (169) — outstanding/receivable schedule per party (`DueDate`, `DueAmt`, `TransNo`, `TransactionId`).
- `Settlement` (12) / `SettlementDetail` (44) — payment settlement/knock-off against journal entries.

### Configuration / supporting masters
`BookMaster` (254, PK `BookNo`) = document books/series with their account & numbering rules (every transaction has a `BookNo`). `RateMst` (1,227), `RateDailyMst`, `MetalRateMst` (44), `RateChartRangeMst*` = pricing/rate charts. `LabourChartMst` (10) = labour/making-charge formulas (`CPFRate`, `LabourFormula`, `GoldLossFormula`). `SizeMst` (529), `RawMst` (23, raw-material/component types e.g. Metal/Diamond/Stone — drives which weight fields apply), `QualityMst` (14), `ToneMst` (12), `MainProduct` (9 product groups)/`SubProduct`, `Const_MetalGroup` (61), `Company` (2), `SPM_Users` (15) + `SPM_UsersAccount`/`SPM_RoleMaster*` (login & RBAC), `LoginSession` (304).

---

## 3. Foreign keys / relationships (the spine)

Everything radiates from **`PartyMst`** (party/account hub) and **`Inward`** (piece hub).

```
PartyMst (PartyNo) ◄── customer/supplier/salesperson/branch/location/account on virtually every transaction
  ├─ Heads/SubHeads (chart of accounts)
  └─ AccountBalance, DueDetail, Journal(Dr/Cr), VoucherEntry, Settlement

StyleMst (StyleId) ──< StyleMstDetail/Summary/Formula        (design templates)
        ▲
        │ StyleId
Inward (JewelId) ──< InwardDetail / InwardSummary / InwardCatch / InwardFormula
   │   │             InwardXtraCharges / InwardExploration / InwardHistory
   │   ├─ GrpNo→MainProduct, MetalToneNo→ToneMst, StockTypeNo→StockTypeMst
   │   ├─ BagId→SPM_BagMaster, PO_OrderId→Spm_MfgOrder, OrderProceedItemId→OrderProceedItem
   │   └─ SaleId/PurchaseId→JewelTrans

JewelTrans (JewelTransId)  [invoice header; PartyNo, BookNo, OrderId→Spm_MfgOrder]
   └─< JewelTransInward (JewelId→Inward) ──< JewelTransInwardDetail / Summary / Formula / Exploration
                                              JewelTransXtraCharges / JewelTransAddless / JewelTransMetalRate

Spm_MfgOrder (OrderId) ──< SPM_MfgOrderItem (OrderItemId) ──< SPM_MfgOrderItemDetail/Summary/Formula
   ├─ OrderProceed/OrderProceedItem  (order → stock fulfilment)
   └─ SPM_BagMaster (OrderId/OrderItemId) ──< SPM_BagMaterial / SPM_BagTransaction / SPM_MaterialStock

BookMaster (BookNo) ◄── JewelTrans, Spm_MfgOrder, VoucherEntry, Journal, OrderProceed, DueDetail  (document series)
```

Notable: `JewelTransInwardDetail` carries a **composite PK (JewelDetailID, JewelId, JewelTransId)** and FKs to `Inward`, `InwardDetail`, `JewelTrans`, and `JewelTransInward` — i.e. a bill line is a snapshot tied back to the live piece + its component. `PartyMst` is heavily self-referential (`BranchNo`, `LocationId`, `ControlAccNo`, `SalesPersonNo`, `Inline_ToBranchNo` all → `PartyMst.PartyNo`) — this is how store/branch hierarchy is modelled today.

---

## 4. Legacy → Eclat 17-module mapping

| Eclat module | Legacy coverage | Key legacy tables | Notes |
|---|---|---|---|
| 1. CRM / Leads | **Weak / net-new** | `PartyMst` (customers), `ContactList`, `CRM_*` (all empty) | Customer master exists; lead pipeline does not. Build leads in Eclat, reuse PartyMst as customer source. |
| 2. Quotation & Pricing | **Partial** | `Spm_MfgOrder`(+Items), `RateMst`, `RateDailyMst`, `MetalRateMst`, `RateChartRangeMst*`, `LabourChartMst`, `DiscountMarkupMst` | Strong **pricing engine** (rate charts + labour/CPF formulas + daily metal rate) is reusable. No distinct "quotation" doc — orders/proforma (`JWPRM`) act as quotes. |
| 3. Dashboards & Collaboration | **None** | — | Net-new in Eclat. |
| 4. Finance & Fund Planning | **Strong** | `Journal`, `VoucherEntry(+Detail)`, `Heads`, `SubHeads`, `AccountBalance`, `DueDetail`, `Settlement(+Detail)`, `Company`, `PartyMst.IsAccount` | Full double-entry ledger + receivables + settlements. Fund *planning* is net-new; ledger is reusable. |
| 5. Catalogue & Product (AI image search) | **Strong** | `StyleMst(+Detail/Summary/Formula)`, `Inward(+Detail/Summary)`, `MainProduct`, `SubProduct`, `QualityMst`, `ToneMst`, `SizeMst`, `RawMst`, `SPM_Items`, image fields (`ImageName`, `STLImageName`) | Design + item master is the richest asset. Image filenames present → feed AI image search. |
| 6. HRMS & Geo Attendance | **Net-new** | `SPM_Users`/`RoleMaster` (logins only), `LabourAttendance`/`OffDayMaster`/`HolidayMaster` (all empty) | Only app logins + empty labour-attendance tables. Build HRMS fresh. |
| 7. Check-ins & Footfall | **None** | `TabletEntry*` (empty) | Net-new (CCTV dropped per DECISIONS). |
| 8. Timelines & Status | **Partial** | `InwardHistory`, `OrderProceed(+Item)`, `Spm_MfgOrder.OrderStatus`, `SPM_BagMaster.BagStatus`, `SPM_BagTransaction`, `OMS_OrderStatusHistory`(empty) | Rich internal movement/status history exists (per-piece and per-bag). Reuse for status tracking; external visibility is the open question. |
| 9. Inventory / Stock / Merchandising | **Strong (core)** | `Inward*`, `SPM_MaterialStock`, `SPM_BagMaster/Material/Transaction`, `StockTypeMst`, `*StockReconsilation*` | The system's center of gravity. Directly reusable. |
| 10. Reporting & DSR | **Partial** | All transaction tables + `.repx` report defs + `BookMasterReport`, `UTIL_Report*` | Data is there; DevExpress reports are legacy reporting layer. DSR is net-new aggregation over `JewelTrans`/`VoucherEntry`/`Journal`. |
| 11. New-store setup | **Partial** | `PartyMst` (branch/location rows), `BookMaster`, `Company`, `BookTemplateMaster*`(empty) | Branch = a PartyMst row; book templates exist. Reusable scaffolding. |
| 12. Payment Collection | **Partial** | `VoucherEntry`, `DueDetail`, `Settlement(+Detail)`, `PDCMain/PDCDetail`(empty), `PaymentRequest*`(empty) | Receipts + dues + settlement present. Collection-tracking workflow net-new. |
| 13. Ticketing & Issue | **None** | — | Net-new. |
| 14. Returns & Exchange | **Partial** | `JewelTrans` (`TranType` returns), `Inward.SaleReturn_*`, `SaleReturnPolicyMst*`, `RepairItems`(empty) | Return is a JewelTrans variant + return-linkage columns on Inward. Reusable. |
| 15. Discount Management | **Partial** | `DiscountMarkupMst(+Detail)`, `DPMS_*`, `JewelTransAddless`, item `Discount*`/`MrpPlus*` columns | Discount/markup engine exists at line level. Reusable. |
| 16. Marketing | **None / net-new** | `PromocodeMaster`, `GiftcodeMaster`, `SchemeMaster` (all empty), `WEB_BANNER_MST` etc. (empty) | Tables defined, unused. Net-new. |
| 17. Loyalty & Gold Savings Scheme | **Defined, no data** | `SchemeMaster`, `SchemeMemberMaster`, `SchemeMemberInstalment`, `Scheme_InstalmentReceived`, `VoucherEntry.Scheme_*` columns | Full schema for gold-savings schemes exists but **0 rows**. Schema reusable as design reference; data must be built fresh. |

**Modules with NO meaningful legacy coverage (net-new builds):** 3 Dashboards, 6 HRMS/Attendance, 7 Check-ins/Footfall, 13 Ticketing, 16 Marketing. Module 17 (Loyalty) is schema-only/no data; Module 1 (CRM/Leads) has only the customer master.

---

## 5. Watermark columns for incremental sync

For `data_sync/EclatSync/sync_sjep.py` pulling new/changed rows every 15 min. All transaction tables have an **identity bigint PK** (monotonic — best for *new* rows) and `EntryDate`/`UpdateDate` datetimes (populated; for *changed* rows). Use **`UpdateDate` where present, else `EntryDate`**, plus the identity PK as a tie-breaker. Recommended pattern: `WHERE UpdateDate > @lastWatermark OR (UpdateDate IS NULL AND EntryDate > @lastWatermark)` and track `MAX(<identityPK>)`.

| Transaction table | Identity PK (new-row watermark) | Created col | Modified col | Document number |
|---|---|---|---|---|
| `JewelTrans` (sales/purchase) | `JewelTransId` | `EntryDate` | `UpdateDate` | `JewelTransPrefix`+`JewelTransNo`; `JewelTransDate` |
| `JewelTransInward` (lines) | (composite, no identity) | — | — | use parent `JewelTransId` |
| `JewelTransInwardDetail` | `JewelDetailID` (from InwardDetail) | — | — | join on `JewelTransId` |
| `Inward` (stock pieces) | `JewelId` | `EntryDate` | `UpdateDate` | `JewelCode` / `InwardSKUNo`; `InwardDate` |
| `InwardHistory` (movements) | `Id` | — | `TransactionDate` | — (append-only log; use `Id`) |
| `Spm_MfgOrder` (orders) | `OrderId` | `EntryDate` | `UpdateDate` | `OrderPrefix`+`OrderNo`; `OrderDate` |
| `SPM_MfgOrderItem` | `OrderItemId` | — | — | parent `OrderId` |
| `OrderProceed` | `OrderProceedId` | `EntryDate` | `UpdateDate` | `OrderProceedPrefix`+`OrderProceedNo` |
| `OrderProceedItem` | `OrderProceedItemId` | — | — | parent `OrderProceedId` |
| `VoucherEntry` (receipts/payments) | `VoucherEntryId` | `EntryDate` | `UpdateDate` | `TransPrefix`+`TransNo`; `TransactionDate` |
| `Journal` (ledger) | `Id` | `EntryDate` | — (no UpdateDate) | `TransPrefix`+`TransNo`; `Jdate` |
| `Settlement` | `SettlementId` | `EntryDate` | — | `SettlementPrefix`+`SettlementNo` |
| `SPM_BagMaster` | `BagId` | `EntryDate` | — | `BagNo` / `BagBarcode` |
| `SPM_MaterialTrans` | `MaterialTransId` | (verify) | — | `TransNo` |
| `SPM_MaterialStock` | `Id` | — | `TransDate` | `TransNo` |
| `DueDetail` | `DueId` | — | `TransactionDate` | `TransPrefix`+`TransNo` |

**Recommended primary watermark per table = identity PK** for append-heavy tables (`InwardHistory`, `Journal`, `SPM_MaterialStock`), and **`UpdateDate`/`EntryDate`** for tables that get edited in place (`JewelTrans`, `Inward`, `Spm_MfgOrder`, `VoucherEntry`). Cancellations are soft (`isCancel`/`isCancel` bit) — re-pull updated rows by `UpdateDate`, do not rely on deletes.

---

## 6. Ambiguities / things to confirm (not guessed)

1. **`JewelTrans.TranType` codes** — `JWSL/JWPH/JWBAP/JWBAI/JWPRM/BJWSL/BJWPH`. SL≈sale, PH≈purchase, PRM≈proforma, BA*≈branch transfer, B-prefix≈branch variant — **inferred, confirm against BookMaster/Const_BookType before trusting in DSR.**
2. **`Inward.InwardType`** Z/B/R/W/I (842/759/580/499/10) — likely stock state/category (W=work, R=repair/return?, B/Z=branch/stock?). Decode via `Const_InwardType` (14 rows) — **not yet confirmed.**
3. **Data is recent (Mar–Jun 2026 only).** Either a fresh install or only recent data was loaded. Confirm whether this backup contains full history before relying on it for trend/DSR baselines.
4. **Scheme (17), Marketing (16), CRM (1), HRMS (6) tables are present but empty** — they are design references, not data sources.
5. **`*View` tables** (`SPM_BagMaterialView`, `InwardExplorationView`, etc.) appear in `sys.tables` with rows — these are materialized/import staging tables, not SQL views; treat as derived, do not sync as sources.
6. **Composite/identity nuance:** `JewelTransInward`, `JewelTransInwardDetail` etc. inherit keys from Inward/InwardDetail and have no own identity — sync them keyed off their parent `JewelTransId`.
