-- Rebrand + secure the head-office login.
--
-- Move it off the caratsense.in seed address onto the company domain (matching
-- the generated staff handles, firstname.store@eclatdiamonds.in), and retire the
-- shared seed password `password123`. The value below is the bcrypt hash of the
-- new password — the plaintext is never committed. If the row was already
-- migrated (or renamed), the WHERE matches nothing and this is a safe no-op.

UPDATE "User"
SET email = 'head.office@eclatdiamonds.in',
    "passwordHash" = '$2a$10$Oh.wOxaDvcss2tnriiu3jeLRpII/Z1q.0oNnH4JhnKKaffbEEfN5O'
WHERE email = 'head.office@caratsense.in';
