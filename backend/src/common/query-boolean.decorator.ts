import { Transform } from 'class-transformer';

/**
 * A boolean that arrived in a query string.
 *
 * `@Type(() => Boolean)` cannot be used for this: a query parameter is always a
 * string, and `Boolean('false')` is `true`. A filter written as `?mine=false`
 * therefore reads as `mine: true` and the screen shows the opposite of what was
 * asked for.
 *
 * The raw value is taken from `obj[key]` rather than `value`, because the global
 * pipe runs with `enableImplicitConversion`, which has already applied that same
 * `Boolean(...)` coercion by the time a `@Transform` sees it — `value` is the
 * damage, `obj[key]` is the string the client actually sent.
 *
 * An absent parameter stays `undefined` rather than becoming `false`, so
 * `@IsOptional()` still means "not asked for" and a service can tell the
 * difference between that and an explicit `false`.
 */
export const QueryBoolean = () =>
  Transform(({ obj, key }) => {
    const raw = obj?.[key];
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    return raw; // let @IsBoolean() reject anything else rather than guessing
  });
