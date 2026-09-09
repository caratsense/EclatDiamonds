"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useConfigBootstrap,
  type AttributeDefinition,
} from "@/lib/queries/tenant-config";

/**
 * Tenant-defined fields, rendered from configuration.
 *
 * This is what keeps the product form industry-neutral without a second
 * codebase: a jeweller's built-in metal/karat/weight inputs stay exactly where
 * they are, and a pharmacy's dosage form — or anything else an admin defines —
 * appears alongside them from `AttributeDefinition` alone. Nothing here knows
 * what any particular attribute means.
 *
 * A tenant that has defined none renders nothing at all, so an existing Eclat
 * store sees no change.
 */

/** The definitions configured for one entity ("product", "party", "lead", …). */
export function useAttributeDefinitions(entity: string): AttributeDefinition[] {
  const { data } = useConfigBootstrap();
  return (data?.attributes?.[entity] ?? [])
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Editable inputs. `values` is the JSON bag stored on the record. */
export function CustomAttributeFields({
  entity,
  values,
  onChange,
}: {
  entity: string;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const defs = useAttributeDefinitions(entity);
  const { data: config } = useConfigBootstrap();
  if (defs.length === 0) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {defs.map((def) => {
        const id = `attr-${def.key}`;
        // A term list beats a free-text box wherever the tenant defined one:
        // it is the difference between "22K", "22 kt" and "22" being one value
        // or three in every report afterwards.
        const terms = def.taxonomyKind
          ? config?.taxonomies?.[def.taxonomyKind]?.terms ?? []
          : [];
        const options = terms.length
          ? terms.map((t) => ({ value: t.code, label: t.label }))
          : (def.options ?? []).map((o) => ({ value: o, label: o }));
        const current = values[def.key];

        return (
          <div key={def.id} className="grid gap-1.5">
            <Label htmlFor={id}>
              {def.label}
              {def.required ? <span className="text-destructive"> *</span> : null}
              {def.unit ? (
                <span className="text-muted-foreground"> ({def.unit})</span>
              ) : null}
            </Label>
            {options.length > 0 ? (
              <Select
                value={typeof current === "string" ? current : ""}
                onValueChange={(v) => onChange({ ...values, [def.key]: v })}
              >
                <SelectTrigger id={id}>
                  <SelectValue placeholder={`Select ${def.label.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={id}
                type={def.dataType === "number" ? "number" : def.dataType === "date" ? "date" : "text"}
                value={current == null ? "" : String(current)}
                onChange={(e) => {
                  const raw = e.target.value;
                  onChange({
                    ...values,
                    // An emptied field is removed rather than stored as "",
                    // so "not filled in" and "deliberately blank" do not become
                    // the same thing in the data.
                    ...(raw === ""
                      ? { [def.key]: undefined }
                      : {
                          [def.key]:
                            def.dataType === "number" && raw !== "" ? Number(raw) : raw,
                        }),
                  });
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Read-only rendering for a detail view. Shows only attributes that have a value. */
export function CustomAttributeList({
  entity,
  values,
}: {
  entity: string;
  values: Record<string, unknown> | null | undefined;
}) {
  const defs = useAttributeDefinitions(entity);
  const { data: config } = useConfigBootstrap();
  if (!values || defs.length === 0) return null;

  const filled = defs.filter(
    (d) => values[d.key] !== undefined && values[d.key] !== null && values[d.key] !== "",
  );
  if (filled.length === 0) return null;

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {filled.map((def) => {
        const raw = values[def.key];
        const terms = def.taxonomyKind
          ? config?.taxonomies?.[def.taxonomyKind]?.terms ?? []
          : [];
        // Falls back to the stored value when no term matches — a value whose
        // term was later renamed or removed must still render as itself.
        const display =
          terms.find((t) => t.code === raw)?.label ?? String(raw);
        return (
          <div key={def.id} className="contents">
            <dt className="text-muted-foreground">{def.label}</dt>
            <dd className="font-medium">
              {display}
              {def.unit ? ` ${def.unit}` : ""}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
