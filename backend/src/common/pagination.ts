import { BadRequestException } from '@nestjs/common';

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

/** Parsed, validated pagination request (only present when the client opted in). */
export interface PageRequest {
  /** 1-based page number. */
  page: number;
  pageSize: number;
}

/** Paginated envelope returned when the client sends `page` and/or `pageSize`. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Parse optional `page` / `pageSize` query params (heavy list endpoints).
 *
 * Contract (backward compatible):
 * - Neither param provided → returns `undefined`; the endpoint responds with the
 *   plain array exactly as before (existing frontend depends on that shape).
 * - Either param provided → returns a validated {@link PageRequest}; the endpoint
 *   responds with the `{ items, total, page, pageSize }` envelope.
 *
 * Validated here (not via a @Query() DTO) because the global ValidationPipe runs
 * with `forbidNonWhitelisted`, and a query DTO would start rejecting stray query
 * params these endpoints have always silently ignored.
 */
export function parsePagination(
  page?: string,
  pageSize?: string,
): PageRequest | undefined {
  if (page === undefined && pageSize === undefined) return undefined;

  const p = page === undefined ? 1 : Number(page);
  if (!Number.isInteger(p) || p < 1) {
    throw new BadRequestException('page must be an integer >= 1');
  }

  const size = pageSize === undefined ? DEFAULT_PAGE_SIZE : Number(pageSize);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw new BadRequestException(
      `pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`,
    );
  }

  return { page: p, pageSize: size };
}
