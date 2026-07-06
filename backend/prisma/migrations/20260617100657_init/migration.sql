-- CreateEnum
CREATE TYPE "Role" AS ENUM ('salesperson', 'store_manager', 'area_manager', 'head_office');

-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('customer', 'supplier', 'staff', 'salesperson', 'branch', 'account');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('inquiry', 'quotation', 'order_placed');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('walk_in', 'phone', 'whatsapp', 'website', 'instagram', 'referral');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('draft', 'shared', 'accepted', 'expired');

-- CreateEnum
CREATE TYPE "MetalKind" AS ENUM ('gold_24k', 'gold_22k', 'gold_18k', 'rose_gold_18k', 'platinum', 'silver');

-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('necklace', 'ring', 'earrings', 'bangle', 'bracelet', 'pendant', 'chain', 'other');

-- CreateEnum
CREATE TYPE "Availability" AS ENUM ('in_stock', 'lead_time');

-- CreateEnum
CREATE TYPE "StockStatus" AS ENUM ('in_stock', 'aging', 'dead_stock', 'reserved', 'sold', 'melted', 'transferred');

-- CreateEnum
CREATE TYPE "SaleDocType" AS ENUM ('sale', 'purchase', 'branch_transfer', 'proforma', 'sale_return', 'purchase_return');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('booked', 'designing', 'casting', 'stone_setting', 'polishing', 'qc', 'ready', 'delivered', 'cancelled');

-- CreateEnum
CREATE TYPE "TimelineRole" AS ENUM ('salesperson', 'back_office', 'runner', 'factory');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('cash', 'card', 'upi', 'net_banking', 'online', 'cheque', 'gold_exchange');

-- CreateEnum
CREATE TYPE "LedgerSide" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "LedgerKind" AS ENUM ('AR', 'AP', 'expense', 'income', 'asset', 'liability');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('present', 'late', 'on_leave', 'absent');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('casual', 'sick', 'earned', 'festival');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "SchemeStatus" AS ENUM ('active', 'matured', 'defaulted', 'closed');

-- CreateEnum
CREATE TYPE "InstallmentStatus" AS ENUM ('due', 'paid', 'missed', 'waived');

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('it', 'hr', 'maintenance', 'logistics');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('low', 'medium', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('open', 'routed', 'in_progress', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "ReturnType" AS ENUM ('return', 'exchange', 'repair', 'old_gold');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'rejected', 'settled');

-- CreateEnum
CREATE TYPE "SettlementType" AS ENUM ('credit_note', 'refund', 'exchange');

-- CreateEnum
CREATE TYPE "DiscountStatus" AS ENUM ('pending', 'approved', 'rejected', 'escalated');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('planning', 'in_review', 'live', 'completed', 'paused');

-- CreateEnum
CREATE TYPE "CampaignType" AS ENUM ('bridal', 'festive', 'catalog', 'always_on', 'digital');

-- CreateEnum
CREATE TYPE "CheckinPurpose" AS ENUM ('bridal', 'investment', 'repair', 'quote_followup', 'browsing', 'scheme', 'other');

-- CreateEnum
CREATE TYPE "CheckinOutcome" AS ENUM ('in_store', 'sale_closed', 'quote_given', 'follow_up', 'left');

-- CreateEnum
CREATE TYPE "NewStoreDept" AS ENUM ('it', 'inventory', 'interiors', 'hr', 'marketing');

-- CreateEnum
CREATE TYPE "ChecklistStatus" AS ENUM ('todo', 'in_progress', 'blocked', 'done');

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "code" TEXT,
    "regionId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isAggregate" BOOLEAN NOT NULL DEFAULT false,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "geofenceRadiusM" INTEGER DEFAULT 150,
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "initials" TEXT,
    "phone" TEXT,
    "passwordHash" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "role" "Role" NOT NULL DEFAULT 'salesperson',
    "partyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserStore" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "role" "Role",
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountLimit" (
    "id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "storeId" TEXT,
    "maxPercent" DECIMAL(5,2) NOT NULL,
    "maxAmount" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Party" (
    "id" TEXT NOT NULL,
    "storeId" TEXT,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "code" TEXT,
    "types" "PartyType"[],
    "phone" TEXT,
    "whatsapp" TEXT,
    "email" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT DEFAULT 'India',
    "pincode" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "aadhaar" TEXT,
    "birthday" DATE,
    "anniversary" DATE,
    "creditLimit" DECIMAL(14,2),
    "isBlacklisted" BOOLEAN NOT NULL DEFAULT false,
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "partyId" TEXT,
    "ownerId" TEXT,
    "customerName" TEXT NOT NULL,
    "phone" TEXT,
    "value" DECIMAL(14,2),
    "source" "LeadSource" NOT NULL,
    "stage" "LeadStage" NOT NULL DEFAULT 'inquiry',
    "interest" TEXT,
    "lastActivity" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadNote" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OccasionReminder" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "occasion" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "notified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OccasionReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetalRate" (
    "id" TEXT NOT NULL,
    "metal" "MetalKind" NOT NULL,
    "ratePerGram" DECIMAL(12,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "storeId" TEXT,
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetalRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "partyId" TEXT,
    "leadId" TEXT,
    "assignedRepId" TEXT,
    "customerName" TEXT NOT NULL,
    "phone" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'draft',
    "validUntil" TIMESTAMP(3),
    "metalValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "makingCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "stoneCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "gstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteRedeemableStore" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,

    CONSTRAINT "QuoteRedeemableStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLine" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "karat" INTEGER NOT NULL,
    "weightGrams" DECIMAL(12,3) NOT NULL,
    "goldRatePerGram" DECIMAL(12,2) NOT NULL,
    "makingCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "stoneCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "caratWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "storeId" TEXT,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ProductCategory" NOT NULL DEFAULT 'other',
    "metal" "MetalKind" NOT NULL,
    "karat" INTEGER NOT NULL DEFAULT 0,
    "weightGrams" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "caratWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "price" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "availability" "Availability" NOT NULL DEFAULT 'in_stock',
    "leadTimeDays" INTEGER,
    "description" TEXT,
    "bestSeller" BOOLEAN NOT NULL DEFAULT false,
    "imageUrl" TEXT,
    "stlUrl" TEXT,
    "embedding" DOUBLE PRECISION[],
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockItem" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT,
    "sku" TEXT,
    "name" TEXT,
    "category" "ProductCategory" NOT NULL DEFAULT 'other',
    "metal" "MetalKind",
    "karat" INTEGER,
    "status" "StockStatus" NOT NULL DEFAULT 'in_stock',
    "ageDays" INTEGER,
    "grossWeight" DECIMAL(12,3),
    "netWeight" DECIMAL(12,3),
    "pureWeight" DECIMAL(12,3),
    "metalLossWeight" DECIMAL(12,3),
    "diamondWeightCt" DECIMAL(10,3),
    "diamondPieces" INTEGER,
    "stoneWeightCt" DECIMAL(10,3),
    "metalAmount" DECIMAL(14,2),
    "diamondAmount" DECIMAL(14,2),
    "stoneAmount" DECIMAL(14,2),
    "makingAmount" DECIMAL(14,2),
    "cpfAmount" DECIMAL(14,2),
    "cost" DECIMAL(14,2),
    "mrp" DECIMAL(14,2),
    "tagPrice" DECIMAL(14,2),
    "hallmarkNo" TEXT,
    "certificateNo" TEXT,
    "imageUrl" TEXT,
    "inwardDate" TIMESTAMP(3),
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "fromStoreId" TEXT,
    "toStoreId" TEXT,
    "status" TEXT,
    "note" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "partyId" TEXT,
    "salesPersonId" TEXT,
    "docNo" TEXT NOT NULL,
    "docType" "SaleDocType" NOT NULL DEFAULT 'sale',
    "docDate" TIMESTAMP(3) NOT NULL,
    "grossAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "remarks" TEXT,
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleLine" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "stockItemId" TEXT,
    "productId" TEXT,
    "description" TEXT,
    "netWeight" DECIMAL(12,3),
    "metalRate" DECIMAL(12,2),
    "metalAmount" DECIMAL(14,2),
    "makingAmount" DECIMAL(14,2),
    "stoneAmount" DECIMAL(14,2),
    "discountAmount" DECIMAL(14,2),
    "lineTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "SaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManufacturingOrder" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "partyId" TEXT,
    "orderNo" TEXT NOT NULL,
    "orderDate" TIMESTAMP(3) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'booked',
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "poNo" TEXT,
    "expectedDelivery" TIMESTAMP(3),
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManufacturingOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManufacturingOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "styleSku" TEXT,
    "description" TEXT,
    "orderQty" INTEGER NOT NULL DEFAULT 1,
    "status" "OrderStatus" NOT NULL DEFAULT 'booked',
    "expectedDelivery" TIMESTAMP(3),
    "producedStockItemId" TEXT,
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "ManufacturingOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionBag" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "bagNo" TEXT NOT NULL,
    "barcode" TEXT,
    "department" TEXT,
    "status" TEXT,
    "grossWeight" DECIMAL(12,3),
    "netWeight" DECIMAL(12,3),
    "isComplete" BOOLEAN NOT NULL DEFAULT false,
    "bagDate" TIMESTAMP(3),
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionBag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrder" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "partyId" TEXT,
    "customerName" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "value" DECIMAL(14,2),
    "stage" "OrderStatus" NOT NULL DEFAULT 'booked',
    "ownerRole" "TimelineRole" NOT NULL DEFAULT 'salesperson',
    "ownerName" TEXT,
    "bookedOn" TIMESTAMP(3) NOT NULL,
    "eta" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "stage" "OrderStatus" NOT NULL,
    "note" TEXT,
    "byRole" "TimelineRole",
    "byName" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomOrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "storeId" TEXT,
    "partyId" TEXT,
    "kind" "LedgerKind" NOT NULL,
    "side" "LedgerSide" NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "reference" TEXT,
    "narration" TEXT,
    "status" TEXT DEFAULT 'open',
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "partyId" TEXT,
    "saleId" TEXT,
    "schemeMemberId" TEXT,
    "reference" TEXT,
    "mode" "PaymentMode" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceRecord" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "staffName" TEXT,
    "date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'present',
    "checkInAt" TIMESTAMP(3),
    "checkOutAt" TIMESTAMP(3),
    "checkInLat" DECIMAL(10,7),
    "checkInLng" DECIMAL(10,7),
    "geoVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "staffName" TEXT,
    "type" "LeaveType" NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'pending',
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storeId" TEXT,
    "period" TEXT NOT NULL,
    "salesValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckIn" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "partyId" TEXT,
    "customerName" TEXT NOT NULL,
    "phone" TEXT,
    "purpose" "CheckinPurpose" NOT NULL DEFAULT 'other',
    "outcome" "CheckinOutcome" NOT NULL DEFAULT 'in_store',
    "repId" TEXT,
    "repName" TEXT,
    "timeIn" TIMESTAMP(3) NOT NULL,
    "timeOut" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemePlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tenureMonths" INTEGER NOT NULL,
    "bonusMonths" INTEGER NOT NULL DEFAULT 0,
    "bonusLabel" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchemePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemeMember" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "partyId" TEXT,
    "planId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "phone" TEXT,
    "installment" DECIMAL(14,2) NOT NULL,
    "tenureMonths" INTEGER NOT NULL,
    "bonusMonths" INTEGER NOT NULL DEFAULT 0,
    "status" "SchemeStatus" NOT NULL DEFAULT 'active',
    "enrolledAt" TIMESTAMP(3) NOT NULL,
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchemeMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemeInstallment" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "goldWeightG" DECIMAL(12,3),
    "goldRate" DECIMAL(12,2),
    "status" "InstallmentStatus" NOT NULL DEFAULT 'due',
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "SchemeInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "storeId" TEXT,
    "subject" TEXT NOT NULL,
    "category" "TicketCategory" NOT NULL,
    "priority" "TicketPriority" NOT NULL DEFAULT 'medium',
    "status" "TicketStatus" NOT NULL DEFAULT 'open',
    "assigneeId" TEXT,
    "assigneeName" TEXT,
    "reporterName" TEXT,
    "patternTag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnRecord" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "partyId" TEXT,
    "saleId" TEXT,
    "customerName" TEXT NOT NULL,
    "phone" TEXT,
    "type" "ReturnType" NOT NULL,
    "item" TEXT,
    "value" DECIMAL(14,2),
    "weightGrams" DECIMAL(12,3),
    "settlement" "SettlementType" NOT NULL DEFAULT 'credit_note',
    "status" "ReturnStatus" NOT NULL DEFAULT 'draft',
    "reason" TEXT,
    "raisedBy" TEXT,
    "legacyId" TEXT,
    "legacyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnPhoto" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountRequest" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "item" TEXT,
    "percent" DECIMAL(5,2),
    "amount" DECIMAL(14,2),
    "marginImpact" DECIMAL(14,2),
    "status" "DiscountStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "requestedById" TEXT,
    "requestedRole" "Role",
    "approvedById" TEXT,
    "approvedRole" "Role",
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CampaignType" NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'planning',
    "startDate" DATE,
    "endDate" DATE,
    "budget" DECIMAL(14,2),
    "spend" DECIMAL(14,2),
    "ownerName" TEXT,
    "agency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignStore" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,

    CONSTRAINT "CampaignStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingAsset" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "status" TEXT DEFAULT 'pending',
    "dueDate" DATE,

    CONSTRAINT "MarketingAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewStoreProject" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "launchDate" DATE,
    "leadName" TEXT,
    "storeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewStoreProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewStoreChecklistItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "department" "NewStoreDept" NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ChecklistStatus" NOT NULL DEFAULT 'todo',
    "dueDate" DATE,

    CONSTRAINT "NewStoreChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewStoreMilestone" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "marker" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "date" DATE NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'upcoming',

    CONSTRAINT "NewStoreMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewStoreVendor" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "task" TEXT,
    "status" TEXT DEFAULT 'pending',
    "dueDate" DATE,

    CONSTRAINT "NewStoreVendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "storeId" TEXT,
    "lastLegacyId" TEXT,
    "lastUpdatedAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "rowsSynced" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Region_code_key" ON "Region"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Store_code_key" ON "Store"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Store_legacyId_key" ON "Store"("legacyId");

-- CreateIndex
CREATE INDEX "Store_regionId_idx" ON "Store"("regionId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_partyId_key" ON "User"("partyId");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "UserStore_storeId_idx" ON "UserStore"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "UserStore_userId_storeId_key" ON "UserStore"("userId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountLimit_role_storeId_key" ON "DiscountLimit"("role", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "Party_legacyId_key" ON "Party"("legacyId");

-- CreateIndex
CREATE INDEX "Party_storeId_createdAt_idx" ON "Party"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "Party_phone_idx" ON "Party"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_ref_key" ON "Lead"("ref");

-- CreateIndex
CREATE INDEX "Lead_storeId_createdAt_idx" ON "Lead"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_stage_idx" ON "Lead"("stage");

-- CreateIndex
CREATE INDEX "Lead_ownerId_idx" ON "Lead"("ownerId");

-- CreateIndex
CREATE INDEX "LeadNote_leadId_idx" ON "LeadNote"("leadId");

-- CreateIndex
CREATE INDEX "OccasionReminder_leadId_idx" ON "OccasionReminder"("leadId");

-- CreateIndex
CREATE INDEX "OccasionReminder_date_idx" ON "OccasionReminder"("date");

-- CreateIndex
CREATE UNIQUE INDEX "MetalRate_legacyId_key" ON "MetalRate"("legacyId");

-- CreateIndex
CREATE INDEX "MetalRate_metal_effectiveFrom_idx" ON "MetalRate"("metal", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_ref_key" ON "Quote"("ref");

-- CreateIndex
CREATE INDEX "Quote_storeId_createdAt_idx" ON "Quote"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "Quote_status_idx" ON "Quote"("status");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteRedeemableStore_quoteId_storeId_key" ON "QuoteRedeemableStore"("quoteId", "storeId");

-- CreateIndex
CREATE INDEX "QuoteLine_quoteId_idx" ON "QuoteLine"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "Product_legacyId_key" ON "Product"("legacyId");

-- CreateIndex
CREATE INDEX "Product_storeId_createdAt_idx" ON "Product"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "Product_category_idx" ON "Product"("category");

-- CreateIndex
CREATE INDEX "Product_sku_idx" ON "Product"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "StockItem_legacyId_key" ON "StockItem"("legacyId");

-- CreateIndex
CREATE INDEX "StockItem_storeId_createdAt_idx" ON "StockItem"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "StockItem_status_idx" ON "StockItem"("status");

-- CreateIndex
CREATE INDEX "StockItem_productId_idx" ON "StockItem"("productId");

-- CreateIndex
CREATE INDEX "StockItem_sku_idx" ON "StockItem"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_legacyId_key" ON "StockMovement"("legacyId");

-- CreateIndex
CREATE INDEX "StockMovement_stockItemId_occurredAt_idx" ON "StockMovement"("stockItemId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_legacyId_key" ON "Sale"("legacyId");

-- CreateIndex
CREATE INDEX "Sale_storeId_docDate_idx" ON "Sale"("storeId", "docDate");

-- CreateIndex
CREATE INDEX "Sale_docType_idx" ON "Sale"("docType");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_storeId_docNo_docType_key" ON "Sale"("storeId", "docNo", "docType");

-- CreateIndex
CREATE UNIQUE INDEX "SaleLine_legacyId_key" ON "SaleLine"("legacyId");

-- CreateIndex
CREATE INDEX "SaleLine_saleId_idx" ON "SaleLine"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "ManufacturingOrder_legacyId_key" ON "ManufacturingOrder"("legacyId");

-- CreateIndex
CREATE INDEX "ManufacturingOrder_storeId_orderDate_idx" ON "ManufacturingOrder"("storeId", "orderDate");

-- CreateIndex
CREATE INDEX "ManufacturingOrder_status_idx" ON "ManufacturingOrder"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ManufacturingOrderItem_legacyId_key" ON "ManufacturingOrderItem"("legacyId");

-- CreateIndex
CREATE INDEX "ManufacturingOrderItem_orderId_idx" ON "ManufacturingOrderItem"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionBag_legacyId_key" ON "ProductionBag"("legacyId");

-- CreateIndex
CREATE INDEX "ProductionBag_orderId_idx" ON "ProductionBag"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomOrder_ref_key" ON "CustomOrder"("ref");

-- CreateIndex
CREATE INDEX "CustomOrder_storeId_createdAt_idx" ON "CustomOrder"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomOrder_stage_idx" ON "CustomOrder"("stage");

-- CreateIndex
CREATE INDEX "CustomOrderEvent_orderId_occurredAt_idx" ON "CustomOrderEvent"("orderId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_legacyId_key" ON "LedgerEntry"("legacyId");

-- CreateIndex
CREATE INDEX "LedgerEntry_storeId_entryDate_idx" ON "LedgerEntry"("storeId", "entryDate");

-- CreateIndex
CREATE INDEX "LedgerEntry_partyId_idx" ON "LedgerEntry"("partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_legacyId_key" ON "Payment"("legacyId");

-- CreateIndex
CREATE INDEX "Payment_storeId_paidAt_idx" ON "Payment"("storeId", "paidAt");

-- CreateIndex
CREATE INDEX "Payment_mode_idx" ON "Payment"("mode");

-- CreateIndex
CREATE INDEX "AttendanceRecord_storeId_date_idx" ON "AttendanceRecord"("storeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceRecord_storeId_staffId_date_key" ON "AttendanceRecord"("storeId", "staffId", "date");

-- CreateIndex
CREATE INDEX "LeaveRequest_storeId_fromDate_idx" ON "LeaveRequest"("storeId", "fromDate");

-- CreateIndex
CREATE UNIQUE INDEX "Commission_userId_period_key" ON "Commission"("userId", "period");

-- CreateIndex
CREATE INDEX "CheckIn_storeId_timeIn_idx" ON "CheckIn"("storeId", "timeIn");

-- CreateIndex
CREATE UNIQUE INDEX "SchemeMember_ref_key" ON "SchemeMember"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "SchemeMember_legacyId_key" ON "SchemeMember"("legacyId");

-- CreateIndex
CREATE INDEX "SchemeMember_storeId_createdAt_idx" ON "SchemeMember"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "SchemeMember_status_idx" ON "SchemeMember"("status");

-- CreateIndex
CREATE INDEX "SchemeInstallment_dueDate_idx" ON "SchemeInstallment"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "SchemeInstallment_memberId_sequence_key" ON "SchemeInstallment"("memberId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_ref_key" ON "Ticket"("ref");

-- CreateIndex
CREATE INDEX "Ticket_storeId_createdAt_idx" ON "Ticket"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "Ticket_status_idx" ON "Ticket"("status");

-- CreateIndex
CREATE INDEX "Ticket_patternTag_idx" ON "Ticket"("patternTag");

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_idx" ON "TicketMessage"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRecord_ref_key" ON "ReturnRecord"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRecord_legacyId_key" ON "ReturnRecord"("legacyId");

-- CreateIndex
CREATE INDEX "ReturnRecord_storeId_createdAt_idx" ON "ReturnRecord"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "ReturnRecord_status_idx" ON "ReturnRecord"("status");

-- CreateIndex
CREATE INDEX "ReturnPhoto_returnId_idx" ON "ReturnPhoto"("returnId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountRequest_ref_key" ON "DiscountRequest"("ref");

-- CreateIndex
CREATE INDEX "DiscountRequest_storeId_createdAt_idx" ON "DiscountRequest"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "DiscountRequest_status_idx" ON "DiscountRequest"("status");

-- CreateIndex
CREATE INDEX "MarketingCampaign_status_idx" ON "MarketingCampaign"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignStore_campaignId_storeId_key" ON "CampaignStore"("campaignId", "storeId");

-- CreateIndex
CREATE INDEX "MarketingAsset_campaignId_idx" ON "MarketingAsset"("campaignId");

-- CreateIndex
CREATE INDEX "NewStoreChecklistItem_projectId_department_idx" ON "NewStoreChecklistItem"("projectId", "department");

-- CreateIndex
CREATE INDEX "NewStoreMilestone_projectId_idx" ON "NewStoreMilestone"("projectId");

-- CreateIndex
CREATE INDEX "NewStoreVendor_projectId_idx" ON "NewStoreVendor"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_sourceTable_storeId_key" ON "SyncState"("sourceTable", "storeId");

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserStore" ADD CONSTRAINT "UserStore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserStore" ADD CONSTRAINT "UserStore_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadNote" ADD CONSTRAINT "LeadNote_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadNote" ADD CONSTRAINT "LeadNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OccasionReminder" ADD CONSTRAINT "OccasionReminder_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_assignedRepId_fkey" FOREIGN KEY ("assignedRepId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteRedeemableStore" ADD CONSTRAINT "QuoteRedeemableStore_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "StockItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "StockItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturingOrder" ADD CONSTRAINT "ManufacturingOrder_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturingOrder" ADD CONSTRAINT "ManufacturingOrder_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturingOrderItem" ADD CONSTRAINT "ManufacturingOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ManufacturingOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionBag" ADD CONSTRAINT "ProductionBag_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ManufacturingOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrderEvent" ADD CONSTRAINT "CustomOrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CustomOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_schemeMemberId_fkey" FOREIGN KEY ("schemeMemberId") REFERENCES "SchemeMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeMember" ADD CONSTRAINT "SchemeMember_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeMember" ADD CONSTRAINT "SchemeMember_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeMember" ADD CONSTRAINT "SchemeMember_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SchemePlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeInstallment" ADD CONSTRAINT "SchemeInstallment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "SchemeMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRecord" ADD CONSTRAINT "ReturnRecord_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRecord" ADD CONSTRAINT "ReturnRecord_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRecord" ADD CONSTRAINT "ReturnRecord_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnPhoto" ADD CONSTRAINT "ReturnPhoto_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "ReturnRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountRequest" ADD CONSTRAINT "DiscountRequest_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountRequest" ADD CONSTRAINT "DiscountRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountRequest" ADD CONSTRAINT "DiscountRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignStore" ADD CONSTRAINT "CampaignStore_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignStore" ADD CONSTRAINT "CampaignStore_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAsset" ADD CONSTRAINT "MarketingAsset_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewStoreChecklistItem" ADD CONSTRAINT "NewStoreChecklistItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NewStoreProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewStoreMilestone" ADD CONSTRAINT "NewStoreMilestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NewStoreProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewStoreVendor" ADD CONSTRAINT "NewStoreVendor_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NewStoreProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
