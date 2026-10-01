"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface SearchOption {
  code: string;
  name: string;
}

/** An option as the box shows it once chosen: "ALR LADIES RING". */
const optionLabel = (o: SearchOption) => `${o.code} ${o.name}`;

/** The option a typed text names outright: by its code, its name, or both as shown. */
export function resolveOption(options: SearchOption[], text: string): SearchOption | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  return (
    options.find((o) => o.code.toLowerCase() === t) ??
    options.find((o) => o.name.toLowerCase() === t || optionLabel(o).toLowerCase() === t)
  );
}

/**
 * The options a typed text narrows the list to: those with it anywhere in
 * their code or name. The one it names outright comes first, so Enter takes
 * it: "ANK" is the necklace, though the anklet (AANK) has those letters too.
 */
export function matchOptions(options: SearchOption[], text: string): SearchOption[] {
  const t = text.trim().toLowerCase();
  if (!t) return options;
  const named = resolveOption(options, text);
  const rest = options.filter((o) => o !== named && optionLabel(o).toLowerCase().includes(t));
  return named ? [named, ...rest] : rest;
}

interface SearchSelectProps extends Omit<React.ComponentProps<"input">, "value" | "onChange"> {
  options: SearchOption[];
  /** The chosen option's code; "" when none is. */
  value: string;
  /** Gets a code once an option is picked or typed in full, and "" while what is typed is not one. */
  onChange: (code: string) => void;
}

/**
 * A box that searches a list as you type, like the ERP's: the list narrows to
 * the codes and names that have what was typed, and one is taken by a click,
 * by the arrow keys and Enter, or by typing its code in full. The chosen
 * option shows as "CODE NAME". Anything else typed stays in the box, marked
 * invalid, and counts as nothing chosen.
 */
export function SearchSelect({ options, value, onChange, className, ...props }: SearchSelectProps) {
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // What is typed, kept with the value it gave. Once the value is set from
  // outside (a design loads its own) it is no longer that one, and what was
  // typed is dropped for it.
  const [typed, setTyped] = useState<{ text: string; value: string } | null>(null);
  const text = typed?.value === value ? typed.text : null;
  const chosen = options.find((o) => o.code === value);
  const matches = matchOptions(options, text ?? "");
  const shown = text ?? (chosen ? optionLabel(chosen) : value);
  // While the list still offers something, typing is a search. Red is for what
  // is not an option at all, or was left without picking one.
  const invalid = !chosen && shown.trim() !== "" && !(open && matches.length > 0);

  // The arrow keys can move the highlight past the end of what the list shows.
  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function openList() {
    setOpen(true);
    // Start on the chosen option, so Enter straight away changes nothing.
    setActive(Math.max(0, matches.findIndex((o) => o.code === value)));
  }
  function close() {
    setOpen(false);
    // Typed in full, an option is chosen: show it the way a picked one shows.
    if (chosen) setTyped(null);
  }
  function pick(option: SearchOption) {
    if (option.code !== value) onChange(option.code);
    setTyped(null);
    setOpen(false);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // With Ctrl or Alt held it is one of the screen's shortcuts, not a key for the list.
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      if (!open) openList();
      else setActive((i) => Math.max(0, Math.min(i + step, matches.length - 1)));
    } else if (e.key === "Enter" && open && matches[active]) {
      e.preventDefault();
      pick(matches[active]);
    } else if (e.key === "Escape") {
      close();
    }
  }

  return (
    <div className="relative">
      <Input
        {...props}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        aria-invalid={invalid}
        autoComplete="off"
        value={shown}
        className={cn(invalid && "border-destructive", className)}
        onChange={(e) => {
          const code = resolveOption(options, e.target.value)?.code ?? "";
          setTyped({ text: e.target.value, value: code });
          setOpen(true);
          setActive(0);
          onChange(code);
        }}
        onMouseUp={(e) => {
          // A click selects a chosen option whole, so typing replaces it rather
          // than adding to its name. The browser's own move is stopped: on text
          // already selected, it would put the caret back where the click was.
          if (text === null) {
            e.preventDefault();
            e.currentTarget.select();
          }
        }}
        onClick={openList}
        onBlur={close}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <div
          ref={list}
          id={listId}
          role="listbox"
          // A click here is a mousedown first, and that would take the focus
          // from the box and close the list before the click lands.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {matches.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Nothing matches that.</p>
          ) : (
            matches.map((o, i) => (
              <div
                key={o.code}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onClick={() => pick(o)}
                className={cn("rounded px-2 py-1.5 text-sm hover:bg-muted", i === active && "bg-muted")}
              >
                <span className="font-mono text-xs text-muted-foreground">{o.code}</span> {o.name}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
