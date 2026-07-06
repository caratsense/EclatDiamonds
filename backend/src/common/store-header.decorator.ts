import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * @StoreHeader() — the UI's current-store selector, read from `X-Store-Id`
 * (falls back to ?storeId). "all" or undefined means "everything in my scope".
 * Pass the result to StoreScopeService.storeFilter() to narrow broad roles.
 */
export const StoreHeader = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest();
    const fromHeader = req.headers['x-store-id'];
    const fromQuery = req.query?.storeId;
    return (fromHeader as string) || (fromQuery as string) || undefined;
  },
);
