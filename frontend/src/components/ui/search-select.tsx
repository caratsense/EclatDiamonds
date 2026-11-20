"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface SearchOption {
  code: string;
  name: string;
  /** Other words it is known by, searched but never shown: "18K WG" for G18WG. */
  keywords?: string;
}

/** An option as the box shows it once chosen: "ALR LADIES RING". */
const optionLabel = (o: SearchOption) => `${o.code} ${o.name}`;

/** All that a search reads of an option, with a space before each of its words. */
const searchText = (o: SearchOption) => ` ${optionLabel(o)} ${o.keywords ?? ""}`.toLowerCase();

/**
 * The option a typed text names outright: by its code, or else by its name
 * (alone, or after the code as the box shows it). A name that two options
 * share names neither of them.
 */
export function resolveOption(options: SearchOption[], text: string): SearchOption | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  const byCode = options.find((o) => o.code.toLowerCase() === t);
  if (byCode) return byCode;
  const byName = options.filter((o) => o.name.toLowerCase() === t || optionLabel(o).toLowerCase() === t);
  return byName.length === 1 ? byName[0] : undefined;
}

/**
 * The options a typed text narrows the list to: those with it anywhere in
 * their code, name or keywords. Enter takes the first, so they come in this
 * order: the one the text names outright ("ANK" is the necklace, though the
 * anklet, AANK, has those letters too); then those where it begins the code or
 * a word ("ring" is a ring before it is an earring); then the rest.
 *
 * ponytail: a word begins after a space and nowhere else, which is how the
 * item master writes its names. Split on other marks too if a name such as
 * "EAR-RING" ever has to rank as a ring.
 */
export function matchOptions(options: SearchOption[], text: string): SearchOption[] {
  const t = text.trim().toLowerCase();
  if (!t) return options;
  const named = resolveOption(options, text);
  const rest = options.filter((o) => o !== named && searchText(o).includes(t));
  const begins = (o: SearchOption) => searchText(o).includes(` ${t}`);
  return [...(named ? [named] : []), ...rest.filter(begins), ...rest.filter((o) => !begins(o))];
}

/** The box at one moment. */
export interface BoxState {
  open: boolean;
  /** The highlighted row of the list: the one Enter takes. */
  active: number;
  /**
   * What is typed, kept with the value it gave. Once the value is set from
   * outside (a design loads its own) it is no longer that one, and what was
   * typed is dropped for it.
   */
  typed: { text: string; value: string } | null;
}

/** The box before it is used. */
export const CLOSED: BoxState = { open: false, active: 0, typed: null };

/** What can happen to the box: typing, a key, a click on it, a click on an option, leaving it. */
export type BoxEvent =
  | { type: "input"; text: string }
  | { type: "key"; key: string }
  | { type: "click" }
  | { type: "pick"; option: SearchOption }
  | { type: "blur" };

/** What the box shows at that moment: its text, its list, and whether it is marked invalid. */
export function boxView(state: BoxState, options: SearchOption[], value: string) {
  const text = state.typed?.value === value ? state.typed.text : null;
  const chosen = options.find((o) => o.code === value);
  const matches = matchOptions(options, text ?? "");
  const shown = text ?? (chosen ? optionLabel(chosen) : value);
  // While the list still offers something, typing is a search. Red is for what
  // is not an option at all, or was left without picking one.
  const invalid = !chosen && shown.trim() !== "" && !(state.open && matches.length > 0);
  return { text, chosen, matches, shown, invalid };
}

/**
 * The box after something happens to it, and the code its owner is to be
 * given, if any. Everything the box does is decided here, apart from what is
 * the browser's own (the focus, the selection), so that it can be tested
 * without a browser.
 */
export function boxStep(
  state: BoxState,
  event: BoxEvent,
  options: SearchOption[],
  value: string,
): { state: BoxState; change?: string } {
  const { chosen, matches } = boxView(state, options, value);
  // The list opens on the chosen option, so Enter straight away changes nothing.
  const opened = { ...state, open: true, active: Math.max(0, matches.findIndex((o) => o.code === value)) };
  // Typed in full, an option is chosen: once closed it shows the way a picked one does.
  const closed = { ...state, open: false, typed: chosen ? null : state.typed };
  // Picking the option already chosen is no change, and its owner is not told of one.
  const pick = (option: SearchOption) => ({
    state: { ...state, open: false, typed: null },
    ...(option.code === value ? {} : { change: option.code }),
  });

  switch (event.type) {
    case "input": {
      const code = resolveOption(options, event.text)?.code ?? "";
      return { state: { open: true, active: 0, typed: { text: event.text, value: code } }, change: code };
    }
    case "click":
      return { state: opened };
    case "pick":
      return pick(event.option);
    case "blur":
      return { state: closed };
    case "key": {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!state.open) return { state: opened };
        const move = event.key === "ArrowDown" ? 1 : -1;
        return { state: { ...state, active: Math.max(0, Math.min(state.active + move, matches.length - 1)) } };
      }
      if (event.key === "Enter" && state.open && matches[state.active]) return pick(matches[state.active]);
      if (event.key === "Escape") return { state: closed };
      return { state };
    }
  }
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
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [state, setState] = useState(CLOSED);
  const { open, active } = state;
  const { text, matches, shown, invalid } = boxView(state, options, value);

  function send(event: BoxEvent) {
    const next = boxStep(state, event, options, value);
    setState(next.state);
    if (next.change !== undefined) onChange(next.change);
  }

  // The arrow keys can move the highlight past the end of what the list shows.
  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  // A chosen option stands selected whole while the box is in use, so the next
  // key typed starts a new search instead of adding to its name. A click and
  // the Tab key select it as they arrive; this does it for one just picked.
  useEffect(() => {
    if (text === null && shown && document.activeElement === box.current) box.current?.select();
  }, [text, shown]);

  return (
    <div className="relative">
      <Input
        {...props}
        ref={box}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        aria-invalid={invalid}
        autoComplete="off"
        value={shown}
        className={cn(invalid && "border-destructive", className)}
        onChange={(e) => send({ type: "input", text: e.target.value })}
        onMouseUp={(e) => {
          // A click selects a chosen option whole, so typing replaces it rather
          // than adding to its name. The browser's own move is stopped: on text
          // already selected, it would put the caret back where the click was.
          if (text === null) {
            e.preventDefault();
            e.currentTarget.select();
          }
        }}
        onClick={() => send({ type: "click" })}
        onBlur={() => send({ type: "blur" })}
        onKeyDown={(e) => {
          // With Ctrl or Alt held it is one of the screen's shortcuts, not a key for the list.
          if (e.ctrlKey || e.altKey || e.metaKey) return;
          // A key the list uses is not the browser's as well: an arrow would move the caret.
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || (e.key === "Enter" && open && matches[active])) {
            e.preventDefault();
          }
          send({ type: "key", key: e.key });
        }}
      />
      {open ? (
        <div
          ref={list}
          id={listId}
          role="listbox"
          // A list long enough to scroll is a stop for the Tab key unless told
          // otherwise, and Tab would then leave the box for a list that closes
          // as the box is left, and go nowhere.
          tabIndex={-1}
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
                onClick={() => send({ type: "pick", option: o })}
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
