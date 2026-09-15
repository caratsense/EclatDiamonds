/**
 * `@Transform(csv)` for a list in a query string: `?tagIds=a,b` and repeated
 * `?tagIds=a&tagIds=b` both arrive as `['a', 'b']`. Blank becomes undefined so an
 * empty filter means "no filter", never "match nothing".
 */
export const csv = ({ value }: { value: unknown }): string[] | undefined => {
  if (value == null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
};
