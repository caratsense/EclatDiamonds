-- The morning staff digest leaves through the omnichannel outbox.
--
-- It used to call the WhatsApp provider directly: no outbox row, no durable
-- retry, no dead letter, no delivery receipt. Queuing it as an ordinary
-- outbound Message fixes all of that, and needs two additive columns.
--
-- Conversation.audience separates a staff notice thread from the customer
-- inbox. Every existing row is a customer thread, which is the default.
ALTER TABLE "Conversation" ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'customer';

-- The outbox message a digest run queued. Delivery status is read from that
-- message rather than copied onto the run, so the two can never disagree.
ALTER TABLE "StaffDigestRun" ADD COLUMN "whatsappMessageId" TEXT;
