import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * @StoreHeader() — the UI's current-store selector, read from `X-Store-Id`
 * (falls back to ?storeId). Undefined means "everything in my scope".
 * Pass the result to StoreScopeService.storeFilter() to narrow broad roles.
 *
 * "All Stores" is a real Store row whose id is the literal `all`, and the
 * switcher sends it like any other. It is resolved to undefined HERE rather
 * than at each call site: `storeFilter` knows the string, but
 * `assertStoreAllowed` does not and never can — `all` is an aggregate, so it
 * is in nobody's scope, and a handler that gated on it would answer "Store not
 * in your scope" to head office looking at its own company.
 */
export const StoreHeader = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest();
    const fromHeader = req.headers['x-store-id'];
    const fromQuery = req.query?.storeId;
    const chosen = (fromHeader as string) || (fromQuery as string) || undefined;
    return chosen === 'all' ? undefined : chosen;
  },
);
