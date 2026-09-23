-- Classify the connector's suspense bucket separately from physical branches.
-- The column is additive and defaults false, so every existing real location
-- retains its current behaviour until explicitly classified below.
ALTER TABLE "Store"
  ADD COLUMN IF NOT EXISTS "isHolding" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Store_organisationId_isHolding_status_idx"
  ON "Store"("organisationId", "isHolding", "status");

-- Both historical holding-store ids are exact system-owned identities. Apply
-- this classification for every tenant; coordinates below remain Eclat-only.
UPDATE "Store"
SET
  "isHolding" = true,
  "status" = 'pending',
  "isActive" = false,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE ("id" = 'unassigned' OR "id" = 'unassigned:' || "organisationId")
  -- The bare legacy id predates tenant scoping, so confirm it really is the
  -- connector's bucket: a branch a human created with the code "Unassigned"
  -- would otherwise be converted into one.
  AND "isAggregate" = false
  AND "name" LIKE 'Unassigned%';

DO $store_location_repair$
DECLARE
  eclat_org_id TEXT;
  west_region_id TEXT;
  north_region_id TEXT;
  south_region_id TEXT;
BEGIN
  -- Resolve the tenant by its unique product slug. The production identifier is
  -- not assumed, so a restored database cannot silently miss every repair just
  -- because its Organisation.id differs from a developer seed.
  SELECT "id"
    INTO eclat_org_id
  FROM "Organisation"
  WHERE "slug" = 'eclat';

  IF eclat_org_id IS NULL THEN
    RETURN;
  END IF;

  -- Reuse the region already assigned to a known anchor branch before looking
  -- for a canonical code or creating anything. Production may have a human-made
  -- "Mumbai" region whose code is not WEST; creating a new WEST row beside it
  -- would split one area's branches across two rollups. The join also proves the
  -- anchor's region belongs to this tenant before it is reused.
  SELECT region."id" INTO west_region_id
  FROM "Store" AS anchor
  JOIN "Region" AS region ON region."id" = anchor."regionId"
  WHERE anchor."organisationId" = eclat_org_id
    AND region."organisationId" = eclat_org_id
    AND (
      anchor."code" = 'A001 MUBD'
      OR (anchor."id" = 'mumbai-bandra' AND anchor."code" = 'mumbai-bandra')
    )
  ORDER BY CASE WHEN anchor."code" = 'A001 MUBD' THEN 0 ELSE 1 END
  LIMIT 1;

  SELECT region."id" INTO north_region_id
  FROM "Store" AS anchor
  JOIN "Region" AS region ON region."id" = anchor."regionId"
  WHERE anchor."organisationId" = eclat_org_id
    AND region."organisationId" = eclat_org_id
    AND anchor."code" = 'A004 DLRO'
  LIMIT 1;

  SELECT region."id" INTO south_region_id
  FROM "Store" AS anchor
  JOIN "Region" AS region ON region."id" = anchor."regionId"
  WHERE anchor."organisationId" = eclat_org_id
    AND region."organisationId" = eclat_org_id
    AND anchor."code" = 'A008 HYBH'
  LIMIT 1;

  IF west_region_id IS NULL THEN
    SELECT "id" INTO west_region_id
    FROM "Region"
    WHERE "organisationId" = eclat_org_id AND "code" = 'WEST'
    LIMIT 1;
  END IF;

  IF north_region_id IS NULL THEN
    SELECT "id" INTO north_region_id
    FROM "Region"
    WHERE "organisationId" = eclat_org_id AND "code" = 'NORTH'
    LIMIT 1;
  END IF;

  IF south_region_id IS NULL THEN
    SELECT "id" INTO south_region_id
    FROM "Region"
    WHERE "organisationId" = eclat_org_id AND "code" = 'SOUTH'
    LIMIT 1;
  END IF;

  -- Only a region with neither an anchor assignment nor a canonical row is
  -- created. Deterministic ids and ON CONFLICT keep a replay/race idempotent.
  IF west_region_id IS NULL THEN
    INSERT INTO "Region" (
      "id", "organisationId", "name", "code", "createdAt", "updatedAt"
    ) VALUES (
      'region_' || SUBSTRING(MD5(eclat_org_id || ':WEST') FROM 1 FOR 24),
      eclat_org_id, 'West India', 'WEST', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    ) ON CONFLICT DO NOTHING;

    SELECT "id" INTO west_region_id
    FROM "Region"
    WHERE "organisationId" = eclat_org_id AND "code" = 'WEST'
    LIMIT 1;
  END IF;

  IF north_region_id IS NULL THEN
    INSERT INTO "Region" (
      "id", "organisationId", "name", "code", "createdAt", "updatedAt"
    ) VALUES (
      'region_' || SUBSTRING(MD5(eclat_org_id || ':NORTH') FROM 1 FOR 24),
      eclat_org_id, 'North India', 'NORTH', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    ) ON CONFLICT DO NOTHING;

    SELECT "id" INTO north_region_id
    FROM "Region"
    WHERE "organisationId" = eclat_org_id AND "code" = 'NORTH'
    LIMIT 1;
  END IF;

  IF south_region_id IS NULL THEN
    INSERT INTO "Region" (
      "id", "organisationId", "name", "code", "createdAt", "updatedAt"
    ) VALUES (
      'region_' || SUBSTRING(MD5(eclat_org_id || ':SOUTH') FROM 1 FOR 24),
      eclat_org_id, 'South India', 'SOUTH', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    ) ON CONFLICT DO NOTHING;

    SELECT "id" INTO south_region_id
    FROM "Region"
    WHERE "organisationId" = eclat_org_id AND "code" = 'SOUTH'
    LIMIT 1;
  END IF;

  -- Coordinates were checked on 22 Sep 2026 against direct Google Maps listings,
  -- except A010, which uses the pin embedded by Eclat's own website for its West
  -- Block location. Every row is tenant + exact branch-code scoped; there is no
  -- global name-only repair. Existing non-null region choices and fence radii
  -- survive. Pune and Nashik should still receive an onsite GPS calibration
  -- before enforcing a narrower attendance fence.
  UPDATE "Store" AS store
  SET
    "name" = COALESCE(repair.fixed_name, store."name"),
    "city" = COALESCE(repair.fixed_city, store."city"),
    "latitude" = repair.latitude,
    "longitude" = repair.longitude,
    "geofenceRadiusM" = COALESCE(store."geofenceRadiusM", 150),
    "regionId" = COALESCE(
      store."regionId",
      CASE repair.region_code
        WHEN 'WEST' THEN west_region_id
        WHEN 'NORTH' THEN north_region_id
        WHEN 'SOUTH' THEN south_region_id
      END
    ),
    "updatedAt" = CURRENT_TIMESTAMP
  FROM (
    VALUES
      ('A001 MUBD', 19.0651400::DECIMAL, 72.8307538::DECIMAL, 'WEST',  NULL::TEXT,             NULL::TEXT),
      ('A002 MUBO', 19.2310811::DECIMAL, 72.8523881::DECIMAL, 'WEST',  NULL::TEXT,             NULL::TEXT),
      ('A003 MUKG', 18.9284830::DECIMAL, 72.8326694::DECIMAL, 'WEST',  NULL::TEXT,             NULL::TEXT),
      ('A004 DLRO', 28.7024233::DECIMAL, 77.1167838::DECIMAL, 'NORTH', NULL::TEXT,             NULL::TEXT),
      ('A005 DLPV', 28.6697672::DECIMAL, 77.1061421::DECIMAL, 'NORTH', NULL::TEXT,             'New Delhi'::TEXT),
      ('A006 UDAN', 24.5865291::DECIMAL, 73.7090486::DECIMAL, 'WEST',  NULL::TEXT,             NULL::TEXT),
      ('A007 MUBR', 19.0560729::DECIMAL, 72.8339070::DECIMAL, 'WEST',  NULL::TEXT,             NULL::TEXT),
      ('A008 HYBH', 17.4248833::DECIMAL, 78.4308130::DECIMAL, 'SOUTH', NULL::TEXT,             'Hyderabad'::TEXT),
      ('A009 NSSN', 20.0023414::DECIMAL, 73.7731669::DECIMAL, 'WEST',  NULL::TEXT,             NULL::TEXT),
      ('A010 PUAM', 18.5185391::DECIMAL, 73.9325169::DECIMAL, 'WEST',  'PUNE AMANORA MALL'::TEXT, 'Pune'::TEXT)
  ) AS repair(code, latitude, longitude, region_code, fixed_name, fixed_city)
  WHERE store."organisationId" = eclat_org_id
    AND store."code" = repair.code;

  -- The development seed has not met Gati yet and therefore still uses its
  -- stable local id/code. Repair A001 there too, without widening the production
  -- match. Its old coordinates were Broadway's, which caused the branch mix-up.
  UPDATE "Store"
  SET
    "latitude" = 19.0651400,
    "longitude" = 72.8307538,
    "geofenceRadiusM" = COALESCE("geofenceRadiusM", 150),
    "regionId" = COALESCE("regionId", west_region_id),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "organisationId" = eclat_org_id
    AND "id" = 'mumbai-bandra'
    AND "code" = 'mumbai-bandra';

  -- Head Office is an attendance location, not a trading branch and not a
  -- region roll-up member. The attendanceOnly column was added without a
  -- historical backfill, so classify this exact Eclat row here as well as
  -- repairing its geofence. Tenant + exact normalised name prevent another
  -- organisation or a similarly named branch from being touched.
  UPDATE "Store"
  SET
    "attendanceOnly" = true,
    "latitude" = 19.1713342,
    "longitude" = 72.8572712,
    "geofenceRadiusM" = COALESCE("geofenceRadiusM", 150),
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "organisationId" = eclat_org_id
    AND UPPER(BTRIM("name")) = 'HEAD OFFICE';

  -- The five real branches that were pending in the reviewed production
  -- snapshot become active only after geo and region now exist. A manager is
  -- useful but is not an activation invariant in the current product.
  UPDATE "Store"
  SET
    "status" = 'active',
    "isActive" = true,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "organisationId" = eclat_org_id
    AND "code" IN ('A005 DLPV', 'A007 MUBR', 'A008 HYBH', 'A009 NSSN', 'A010 PUAM')
    AND "status" = 'pending'
    AND "latitude" IS NOT NULL
    AND "longitude" IS NOT NULL
    AND "regionId" IS NOT NULL;

  -- Surat Main is intentionally absent from every UPDATE above: its current
  -- identity, geofence, region and status are preserved byte-for-byte.
END
$store_location_repair$;
