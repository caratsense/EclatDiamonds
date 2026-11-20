-- Destination-initiated transfers (the "pull"), left as an explicit future
-- decision on 10 Oct and now asked for: a customer at Bandra wants a piece that
-- is at Borivali, and Bandra could not even see it, let alone ask for it.
--
-- A pull is the SAME movement as a push — same pieces, same dispatch, receive
-- and acknowledge — so it is a direction on StockTransfer, not a second
-- transfer system. What it adds is one step in front of the existing ladder:
-- the branch holding the pieces accepts or declines before head office is
-- asked to approve anything.

ALTER TYPE "StockTransferStatus" ADD VALUE 'pending_source' AFTER 'draft';
ALTER TYPE "StockTransferStatus" ADD VALUE 'declined' AFTER 'acknowledged';

CREATE TYPE "StockTransferInitiator" AS ENUM ('source', 'destination');

-- Defaulted to 'source': every transfer recorded so far was raised by the
-- branch sending stock away, and stays exactly that.
ALTER TABLE "StockTransfer" ADD COLUMN "initiatedBy" "StockTransferInitiator" NOT NULL DEFAULT 'source',
ADD COLUMN "sourceDecidedById" TEXT,
ADD COLUMN "sourceDecidedAt" TIMESTAMP(3);
