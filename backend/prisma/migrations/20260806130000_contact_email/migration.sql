-- Personal/contact email.
--
-- Two people may legitimately share one inbox (a family address, a store's
-- shared email), so this column is NOT unique and is never used to sign in. The
-- unique LOGIN identity stays `User.email` — now a generated handle
-- (firstname.storeslug@eclatdiamonds.in) for self-signups. Nullable + additive,
-- so every existing row is untouched.

ALTER TABLE "User" ADD COLUMN "contactEmail" TEXT;
