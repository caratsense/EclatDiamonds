-- The service account the on-site sync agent logs in as.
--
-- Created by migration rather than through the API because POST /users
-- deliberately refuses to assign `head_office` — a guard worth keeping, since
-- every /sync/* route is restricted to that role precisely so store staff cannot
-- bulk-write. The agent needs exactly that role and nothing less.
--
-- It is a MACHINE account: it belongs to no branch, never signs in through the
-- browser, and its password lives only in eclat_config.bat on the client's
-- server. Rotate it with POST /auth/reset-password if that file is ever exposed.
--
-- Idempotent: ON CONFLICT DO NOTHING so re-running (or a replay on another
-- environment) neither fails nor silently resets the password of a live account.
INSERT INTO "User" (
  id, name, email, "passwordHash", "isActive", role, initials,
  "tourViews", "createdAt", "updatedAt"
) VALUES (
  'u-sync-agent',
  'Sync Agent (Gati)',
  'sync@caratsense.in',
  '$2a$10$G1PxRydsx3RzZVFjWXKQueBTDpDXHayaGIBdTorgQ8owfjclDP9XW',
  true,
  'head_office',
  'SA',
  -- Retire the welcome tour immediately: nothing human ever looks at this
  -- account, and an unopened guide would sit at 0/10 forever.
  10,
  now(), now()
)
ON CONFLICT (email) DO NOTHING;
