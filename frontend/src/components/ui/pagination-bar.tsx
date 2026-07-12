"use client";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;

interface PaginationBarProps {
  /** Current page (1-based). */
  page: number;
  pageSize: number;
  /** Total row count across all pages (post-filter, from the API envelope). */
  total: number;
  onPageChange: (page: number) => void;
  /** Changing the page size should also reset the caller's page to 1. */
  onPageSizeChange: (pageSize: number) => void;
  className?: string;
}

/**
 * Compact, shared pagination bar for server-paginated lists (catalogue grid,
 * stock ledger). Shows the visible range, Previous/Next and a page-size
 * select. Purely presentational — page state lives in the calling page.
 */
export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  className,
}: PaginationBarProps) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 py-3",
        className,
      )}
    >
      <p className="text-sm text-muted-foreground">
        Showing <span className="num">{from}</span>–
        <span className="num">{to}</span> of <span className="num">{total}</span>
      </p>

      <div className="flex items-center gap-2">
        <Select
          value={String(pageSize)}
          onValueChange={(v) => onPageSizeChange(Number(v))}
        >
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size} per page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= lastPage}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
