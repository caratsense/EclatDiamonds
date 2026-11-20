import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `maxHeight` turns the table into its own scroll region, with the header
 * pinned.
 *
 * Without it a long table simply makes the page long: the walk-in log's 200
 * rows produced a 17,755px page, which pushed that screen's own KPIs 9,404px
 * below the fold and scrolled the column headings away on the first flick, so
 * every row after the first screenful was unlabelled. Capping the table keeps
 * the headings, the surrounding card and the page's other content in view.
 *
 * Opt-in rather than a default, because a short table should size to its
 * content — a five-row table in a fixed 60vh box is just as wrong in the other
 * direction. Pass any CSS length: `maxHeight="60vh"`.
 */
function Table({
  className,
  maxHeight,
  ...props
}: React.ComponentProps<"table"> & { maxHeight?: string }) {
  return (
    <div
      className={cn("relative w-full overflow-auto", maxHeight && "overscroll-contain")}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table
        className={cn(
          "w-full caption-bottom text-sm",
          // The pinned header needs an OPAQUE fill: TableHeader's own tint is
          // `bg-muted/40`, and at 40% the rows would scroll visibly through it.
          maxHeight && "[&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-card",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      className={cn("bg-muted/40 [&_tr]:border-b", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "border-b border-border transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-10 px-3 text-left align-middle text-xs font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      className={cn(
        "px-3 py-2.5 align-middle [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
