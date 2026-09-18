"use client";

import { useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Gem,
  History,
  Loader2,
  RefreshCw,
  SearchX,
  Store,
  Tag,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CustomAttributeList } from "@/components/common/custom-attributes";
import { useConfigBootstrap, useFieldVisible } from "@/lib/queries/tenant-config";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCarats, formatGrams, formatINR, formatNumber, formatPurity } from "@/lib/format";
import {
  CATEGORY_LABELS,
  METAL_LABELS,
  SOURCE_LABELS,
  productDisplayName,
  type Product,
} from "@/lib/mock/catalogue";
import { ImageLightbox } from "@/components/catalogue/image-lightbox";
import { ProductGallery, imageCaption } from "@/components/catalogue/product-gallery";
import {
  isNotFound,
  useProductFull,
  type BomLine,
  type ProductFull,
  type ProductPriceView,
  type StockPieceFull,
} from "@/lib/queries/products";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

export interface DetailNav {
  index: number;
  count: number;
  onStep: (delta: 1 | -1) => void;
}

interface ProductDetailDialogProps {
  /** The design to show; null keeps the dialog empty. */
  productId: string | null;
  /** What the opener already knows — shown at once while /full loads. */
  seed?: Partial<Product>;
  /** Open on this photo (the one a visual search matched). */
  initialImageId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Step through a result list without closing (e.g. visual-search hits). */
  nav?: DetailNav;
}

/**
 * Everything about one design, loaded lazily from GET /products/:id/full when
 * it opens. Sections render only for what the response carries — cost columns
 * (rates, amounts, margins) arrive only for roles allowed to see them, so the
 * UI shows a column exactly when the API sent it.
 */
export function ProductDetailDialog({
  productId,
  seed,
  initialImageId,
  open,
  onOpenChange,
  nav,
}: ProductDetailDialogProps) {
  const full = useProductFull(open ? productId : null);
  // Whatever opened the dialog gets focus back on close, WITHOUT scrolling:
  // the results underneath must be exactly where the salesperson left them.
  const opener = useRef<HTMLElement | null>(null);
  const title = full.data
    ? productDisplayName(full.data)
    : seed
      ? productDisplayName({ name: seed.name ?? "", displayName: seed.displayName })
      : "Design";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92dvh] grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto p-4 sm:max-w-3xl sm:p-6"
        data-testid="product-detail"
        onOpenAutoFocus={() => {
          opener.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          opener.current?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="leading-snug">{title}</DialogTitle>
          <DialogDescription>
            {full.data ? describe(full.data) : (seed?.styleNumber ?? seed?.sku ?? "Loading details…")}
          </DialogDescription>
        </DialogHeader>

        {nav ? (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2 py-1">
            <Button variant="ghost" size="sm" className="h-10" onClick={() => nav.onStep(-1)}>
              <ChevronLeft className="h-4 w-4" /> Previous
            </Button>
            <span className="num text-xs text-muted-foreground" aria-live="polite">
              Match {nav.index + 1} of {nav.count}
            </span>
            <Button variant="ghost" size="sm" className="h-10" onClick={() => nav.onStep(1)}>
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        ) : null}

        {!productId ? null : full.isLoading ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="aspect-[16/9] w-full rounded-lg" />
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : full.isError ? (
          isNotFound(full.error) ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center" data-testid="detail-not-found">
              <SearchX className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-semibold">This design isn&apos;t available</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                It has been removed from the catalogue, or it belongs to a store you
                can&apos;t see.
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm font-semibold">Couldn&apos;t load this design</p>
              <Button variant="outline" size="sm" onClick={() => full.refetch()}>
                <RefreshCw className="h-4 w-4" /> Try again
              </Button>
            </div>
          )
        ) : full.data ? (
          // Keyed so a different design starts on its own photo, not the last one's.
          <DetailBody key={productId} data={full.data} initialImageId={initialImageId} refreshing={full.isFetching} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function describe(p: ProductFull): string {
  const code = p.styleNumber || p.sku;
  return [
    code,
    p.categoryLabel || CATEGORY_LABELS[p.category],
    p.source ? SOURCE_LABELS[p.source] : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function DetailBody({
  data,
  initialImageId,
  refreshing,
}: {
  data: ProductFull;
  initialImageId?: string | null;
  refreshing: boolean;
}) {
  const { role } = useSession();
  const { data: config } = useConfigBootstrap();
  const fieldVisible = useFieldVisible(config);
  const showsMetal = fieldVisible("product", "metal");
  const showsKarat = fieldVisible("product", "purity");
  const showsWeight = fieldVisible("product", "grossWeight");

  const p = data;
  const name = productDisplayName(p);
  const images = data.images?.length
    ? data.images
    : p.imageUrl
      ? [{ id: "cover", url: p.imageUrl, isPrimary: true, sortOrder: 0 }]
      : [];
  const [picked, setPicked] = useState<string | null>(null);
  const selectedId =
    picked ??
    images.find((i) => i.id === initialImageId)?.id ??
    images.find((i) => i.isPrimary)?.id ??
    images[0]?.id ??
    null;
  const [viewing, setViewing] = useState<number | null>(null);

  const pieces = data.pieces ?? [];
  const conflicts = (data.conflicts ?? []).filter((c) => !c.status || c.status === "open");
  const listing = data.listing;
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const seesAmounts = canEdit;
  const styleNo = p.styleNumber || p.sku;

  return (
    <div className="space-y-4">
      {data.legacy ? (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          Showing the basic record. Variants, website listing and full provenance
          appear once the server is updated.
        </p>
      ) : null}

      {conflicts.length ? (
        <div
          role="alert"
          className="space-y-1 rounded-lg border border-[color-mix(in_srgb,var(--warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-3"
        >
          <p className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-warning" />
            {conflicts.length === 1 ? "1 thing to check" : `${conflicts.length} things to check`}
          </p>
          <ul className="list-disc space-y-0.5 pl-6 text-xs">
            {conflicts.map((c) => (
              <li key={c.id}>
                {c.summary} <span className="text-muted-foreground">({humanize(c.kind)})</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            Values are shown as the source sent them — nothing has been corrected.
          </p>
        </div>
      ) : null}

      <ProductGallery
        productId={p.id}
        productName={name}
        images={images}
        selectedId={selectedId}
        onSelect={setPicked}
        matchedImageId={initialImageId}
        canEdit={canEdit && !data.legacy}
        canPin={role === "head_office" && !data.legacy}
        onOpenFull={setViewing}
      />
      <ImageLightbox
        images={images.map((i) => ({ url: i.url, label: imageCaption(i) || undefined }))}
        index={viewing}
        onIndexChange={setViewing}
        onClose={() => setViewing(null)}
        title={name === styleNo ? styleNo : `${name} · ${styleNo}`}
      />

      <PriceSummary data={data} />

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        {showsMetal ? (
          <Spec label="Metal">{METAL_LABELS[p.metal] ?? p.metal}</Spec>
        ) : p.materialLabel ? (
          <Spec label="Material">{p.materialLabel}</Spec>
        ) : null}
        {showsKarat && p.karat > 0 ? (
          <Spec label="Purity">
            <span className="num">{formatPurity(p.karat)}</span>
          </Spec>
        ) : null}
        {showsWeight && p.weightGrams > 0 ? (
          <Spec label="Gross weight">
            <span className="num">{formatGrams(p.weightGrams)}</span>
          </Spec>
        ) : null}
        {showsWeight && p.caratWeight > 0 ? (
          <Spec label="Stones">
            <span className="num">{formatCarats(p.caratWeight)}</span>
          </Spec>
        ) : null}
        <Spec label="Category">{p.categoryLabel || CATEGORY_LABELS[p.category]}</Spec>
        {p.unitOfMeasure ? <Spec label="Sold in">{p.unitOfMeasure}</Spec> : null}
      </dl>

      <Identifiers data={data} />

      <Availability data={data} />

      {listing ? (
        <Section title="Website listing" icon={<Gem className="h-4 w-4" />}>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
            {listing.marketingName ? <Spec label="Marketing name">{listing.marketingName}</Spec> : null}
            <Spec label="State">
              {listing.isDeleted ? (
                <Badge variant="destructive">Deleted on the website</Badge>
              ) : listing.isActive === false ? (
                <Badge variant="warning">Inactive on the website</Badge>
              ) : (
                <Badge variant="success">Live on the website</Badge>
              )}
            </Spec>
            <ListSpec label="Categories" values={listing.categories} />
            <ListSpec label="Sub-categories" values={listing.subCategories} />
            <ListSpec label="Features" values={listing.features} />
            <ListSpec label="Tags" values={listing.tags} />
            <ListSpec label="Countries" values={listing.countries} />
            {listing.slug ? (
              <Spec label="Slug">
                <span className="break-all font-mono text-xs">{listing.slug}</span>
              </Spec>
            ) : null}
          </dl>
          {listing.description ? (
            <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{listing.description}</p>
          ) : null}
        </Section>
      ) : null}

      <Sizes sizes={data.sizes} />

      <Variants data={data} />

      <Bom data={data} seesAmounts={seesAmounts} />

      {data.specifications?.text ? (
        <Section title="Specifications" icon={<Tag className="h-4 w-4" />}>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm">{data.specifications.text}</pre>
          <p className="mt-2 text-[11px] text-muted-foreground">
            As published on the {data.specifications.source === "gati" ? "Gati record" : "website"}
            {data.specifications.syncedAt ? `, as of ${when(data.specifications.syncedAt)}` : ""}. Shown
            verbatim; anything that disagrees with the bill of material is listed above.
          </p>
        </Section>
      ) : null}
      {listing?.sizeGuide ? (
        <Section title="Size guide">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm">{listing.sizeGuide}</pre>
        </Section>
      ) : null}

      <Composition product={p} seesAmounts={seesAmounts} />

      <Pieces pieces={pieces} />

      <CustomAttributeList entity="product" values={p.attributes} />

      {p.description ? <p className="text-sm text-muted-foreground">{p.description}</p> : null}

      <Provenance data={data} />

      {refreshing ? (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Refreshing…
        </p>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------- sections

/** What the kinds of ProductPrice mean, when the server sends no label. */
const PRICE_KIND_LABELS: Record<string, string> = {
  indicative: "Indicative online price",
  min_variant: "Lowest variant price (website)",
  natural_diamond: "Natural diamond price (website)",
  variant: "Variant price (website)",
  variant_with_margin: "Variant price with margin (website)",
  gati_tag: "Tag price (Gati)",
  gati_tag_min: "Lowest tag price (Gati)",
  gati_tag_max: "Highest tag price (Gati)",
};

function priceLabel(pr: ProductPriceView): string {
  return pr.label || PRICE_KIND_LABELS[pr.kind] || humanize(pr.kind);
}

function range(min?: number | null, max?: number | null): string | null {
  if (min == null && max == null) return null;
  if (min == null || max == null || min === max) return formatINR((min ?? max)!);
  return `${formatINR(min)} – ${formatINR(max)}`;
}

function PriceSummary({ data }: { data: ProductFull }) {
  const p = data;
  const pieces = data.pieces ?? [];
  const pieceTags = pieces.map((x) => x.tagPrice || x.mrp || 0).filter((v) => v > 0);
  const online = p.onlinePrice ? range(p.onlinePrice.min, p.onlinePrice.max) : null;
  const tag =
    (p.tagPrice ? range(p.tagPrice.min, p.tagPrice.max) : null) ??
    (pieceTags.length ? range(Math.min(...pieceTags), Math.max(...pieceTags)) : null);
  const variants = new Map((data.variants ?? []).map((v) => [v.id, v]));
  const prices = (data.prices ?? []).filter((pr) => pr.amount != null);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        {online ? <Figure label="Online price" value={online} /> : null}
        {tag ? <Figure label="Tag price" value={tag} /> : null}
        {!online && !tag && p.price > 0 ? <Figure label="Indicative price" value={formatINR(p.price)} /> : null}
      </div>
      {prices.length ? (
        <details className="rounded-lg border px-3 py-2 text-sm">
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
            All {prices.length} prices, labelled
          </summary>
          <ul className="mt-2 divide-y">
            {prices.map((pr, i) => {
              const v = pr.variantId ? variants.get(pr.variantId) : undefined;
              const which = pr.variantLabel || (v ? variantName(v) : null);
              return (
                <li key={pr.id ?? `${pr.kind}-${pr.variantId}-${i}`} className="flex items-baseline justify-between gap-3 py-1.5">
                  <span>
                    {priceLabel(pr)}
                    {which ? <span className="text-muted-foreground"> · {which}</span> : null}
                  </span>
                  <span className="num shrink-0 font-medium">{formatINR(pr.amount)}</span>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="num text-lg font-semibold">{value}</p>
    </div>
  );
}

const ID_LABELS: Record<string, string> = {
  styleNumber: "Style no",
  sku: "SKU",
  gatiId: "Gati ID",
  websiteCode: "Website code",
  externalId: "Website ID",
  websiteProductCode: "Website product code",
  legacyId: "Legacy ID",
  hsn: "HSN",
};

function Identifiers({ data: p }: { data: ProductFull }) {
  const ids: Record<string, unknown> = {
    styleNumber: p.styleNumber || p.sku,
    sku: p.sku,
    gatiId: p.gatiId,
    websiteCode: p.websiteCode,
    hsn: p.hsn,
    ...(p.identifiers ?? {}),
  };
  const rows = Object.entries(ids).filter(([, v]) => v != null && v !== "");
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-muted/40 p-3 text-sm sm:grid-cols-3">
      {rows.map(([k, v]) => (
        <Spec key={k} label={ID_LABELS[k] ?? humanize(k)}>
          <span className="break-all font-mono text-xs">{String(v)}</span>
        </Spec>
      ))}
      {p.source ? <Spec label="Source">{SOURCE_LABELS[p.source] ?? p.source}</Spec> : null}
    </dl>
  );
}

function Availability({ data }: { data: ProductFull }) {
  const stock = data.stock;
  const rows =
    data.availabilityByStore ??
    (stock
      ? [
          ...(stock.hereCount ? [{ storeId: "here", storeName: "This store", count: stock.hereCount }] : []),
          ...stock.elsewhere,
        ]
      : null);
  if (!rows) return null;
  return (
    <Section title="Available at" icon={<Store className="h-4 w-4" />}>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Not in stock at any store you can see — made to order.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2 text-sm">
          {rows.map((r) => (
            <li
              key={r.storeId}
              className={
                "here" in r && r.here
                  ? "rounded-md bg-emerald-500/10 px-2 py-1 font-medium text-emerald-700 dark:text-emerald-400"
                  : "rounded-md bg-muted px-2 py-1"
              }
            >
              {"here" in r && r.here ? "This store" : r.storeName} · <span className="num">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Sizes({ sizes }: { sizes?: ProductFull["sizes"] }) {
  const values = (sizes ?? []).map((s) => (typeof s === "string" ? s : s.value)).filter(Boolean);
  if (!values.length) return null;
  return (
    <Section title={`Sizes (${values.length})`}>
      <ul className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <li key={v} className="rounded-full border px-2.5 py-0.5 text-xs">
            {v}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function variantName(v: { label?: string | null; metalType?: string | null; karat?: number | null; colour?: string | null; diamondType?: string | null; sku?: string | null; sourceKey?: string }): string {
  if (v.label) return v.label;
  const parts = [v.karat ? `${v.karat}K` : null, v.colour, v.metalType, v.diamondType].filter(Boolean);
  return parts.length ? parts.join(" ") : (v.sku ?? v.sourceKey ?? "Variant");
}

function Variants({ data }: { data: ProductFull }) {
  const variants = data.variants ?? [];
  if (!variants.length) return null;
  const has = (k: keyof (typeof variants)[number]) => variants.some((v) => v[k] != null && v[k] !== "");
  const cols: { key: keyof (typeof variants)[number]; label: string; render: (v: (typeof variants)[number]) => ReactNode; num?: boolean }[] = [
    { key: "sku", label: "SKU", render: (v) => <span className="font-mono text-xs">{v.sku}</span> },
    { key: "karat", label: "Purity", render: (v) => (v.karat ? `${v.karat}K` : "—"), num: true },
    { key: "metalType", label: "Metal", render: (v) => v.metalType },
    { key: "colour", label: "Colour", render: (v) => v.colour },
    { key: "diamondType", label: "Diamond", render: (v) => v.diamondType },
    { key: "goldWeight", label: "Gold wt", render: (v) => formatGrams(v.goldWeight), num: true },
    { key: "diamondWeight", label: "Diamond wt", render: (v) => formatCarats(v.diamondWeight), num: true },
    { key: "stoneWeight", label: "Stone wt", render: (v) => formatCarats(v.stoneWeight), num: true },
    { key: "totalWeight", label: "Total wt", render: (v) => formatGrams(v.totalWeight), num: true },
    { key: "price", label: "Price", render: (v) => (v.price != null ? formatINR(v.price) : "—"), num: true },
    { key: "priceWithMargin", label: "With margin", render: (v) => (v.priceWithMargin != null ? formatINR(v.priceWithMargin) : "—"), num: true },
    { key: "marginPercentage", label: "Margin", render: (v) => (v.marginPercentage != null ? `${v.marginPercentage}%` : "—"), num: true },
    { key: "makingCharge", label: "Making", render: (v) => (v.makingCharge != null ? formatINR(v.makingCharge) : "—"), num: true },
    { key: "status", label: "Status", render: (v) => v.status },
  ];
  const shown = cols.filter((c) => has(c.key));
  return (
    <Section title={`Variants (${variants.length})`}>
      <Table
        head={shown.map((c) => ({ label: c.label, num: c.num }))}
        rows={variants.map((v) => ({ key: v.id, cells: shown.map((c) => c.render(v) ?? "—") }))}
      />
    </Section>
  );
}

/** Keys never worth a column: ids of the source's own rows. */
const BOM_SKIP = /^_?id$|^__v$/i;
const MONEY_KEY = /amount|rate|total|price|value|charge|cost/i;

function Bom({ data, seesAmounts }: { data: ProductFull; seesAmounts: boolean }) {
  const variants = (data.variants ?? []).filter((v) => Array.isArray(v.bom) && v.bom.length);
  if (!variants.length) return null;
  return (
    <Section title="Bill of material">
      <div className="space-y-2">
        {variants.map((v, i) => (
          <details key={v.id} open={i === 0} className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer select-none text-sm font-medium">
              {variantName(v)} <span className="text-xs text-muted-foreground">· {v.bom!.length} lines</span>
            </summary>
            <div className="mt-2">
              <BomTable lines={v.bom!} />
            </div>
          </details>
        ))}
      </div>
      {!seesAmounts ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Rates and amounts are shown to store managers and head office.
        </p>
      ) : null}
    </Section>
  );
}

/** Columns are the keys the response actually carries — cost keys are simply absent below manager. */
function BomTable({ lines }: { lines: BomLine[] }) {
  const keys: string[] = [];
  for (const l of lines) for (const k of Object.keys(l)) if (!BOM_SKIP.test(k) && !keys.includes(k)) keys.push(k);
  return (
    <Table
      head={keys.map((k) => ({ label: humanize(k), num: lines.some((l) => typeof l[k] === "number") }))}
      rows={lines.map((l, i) => ({
        key: String(i),
        cells: keys.map((k) => cell(k, l[k])),
      }))}
    />
  );
}

function cell(key: string, v: unknown): ReactNode {
  if (v == null || v === "") return "—";
  if (typeof v === "number") return MONEY_KEY.test(key) ? formatINR(v, { fractionDigits: 2 }) : formatNumber(v, Number.isInteger(v) ? 0 : 3);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return <span className="font-mono text-[11px]">{JSON.stringify(v)}</span>;
  return String(v);
}

function Composition({ product, seesAmounts }: { product: ProductFull; seesAmounts: boolean }) {
  const parts = product.composition?.lines ?? [];
  if (!parts.length) return null;
  const hasPieces = parts.some((l) => l.pieces);
  const hasRates = parts.some((l) => l.rate);
  const hasAmounts = parts.some((l) => l.amount);
  const total = parts.reduce((n, l) => n + (l.amount ?? 0), 0);
  return (
    <Section title="Items used" note={`from ${product.composition?.source === "gati" ? "Gati" : "the website"}`}>
      <Table
        head={[
          { label: "Item" },
          { label: "Weight", num: true },
          ...(hasPieces ? [{ label: "Pieces", num: true }] : []),
          ...(hasRates ? [{ label: "Rate", num: true }] : []),
          ...(hasAmounts ? [{ label: "Amount", num: true }] : []),
        ]}
        rows={[
          ...parts.map((l, i) => ({
            key: `${l.item}-${i}`,
            cells: [
              l.item,
              l.weight ? (l.unit === "ct" ? formatCarats(l.weight) : l.unit === "g" ? formatGrams(l.weight) : l.weight) : "—",
              ...(hasPieces ? [l.pieces ?? "—"] : []),
              ...(hasRates ? [l.rate ? formatINR(l.rate) : "—"] : []),
              ...(hasAmounts ? [l.amount ? formatINR(l.amount) : "—"] : []),
            ],
          })),
          ...(hasAmounts
            ? [{ key: "total", cells: ["Total", "", ...(hasPieces ? [""] : []), ...(hasRates ? [""] : []), formatINR(total)] }]
            : []),
        ]}
      />
      {!seesAmounts ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Rates and amounts are shown to store managers and head office.
        </p>
      ) : null}
    </Section>
  );
}

type PieceKey = keyof StockPieceFull;
const PIECE_COLS: { key: PieceKey; label: string; kind?: "g" | "ct" | "inr" | "int" | "mono" }[] = [
  { key: "tagNo", label: "Tag", kind: "mono" },
  { key: "storeName", label: "Store" },
  { key: "sizeLabel", label: "Size" },
  { key: "hsn", label: "HSN", kind: "mono" },
  { key: "huid", label: "HUID", kind: "mono" },
  { key: "hallmarkNo", label: "Hallmark", kind: "mono" },
  { key: "certificateNo", label: "Certificate", kind: "mono" },
  { key: "grossWeight", label: "Gross", kind: "g" },
  { key: "netWeight", label: "Net", kind: "g" },
  { key: "pureWeight", label: "Pure", kind: "g" },
  { key: "diamondWeightCt", label: "Diamond", kind: "ct" },
  { key: "diamondPieces", label: "Dia pcs", kind: "int" },
  { key: "stoneWeightCt", label: "Stone", kind: "ct" },
  { key: "stonePieces", label: "Stone pcs", kind: "int" },
  { key: "quantity", label: "Qty", kind: "int" },
  { key: "tagPrice", label: "Tag price", kind: "inr" },
  { key: "mrp", label: "MRP", kind: "inr" },
  { key: "metalAmount", label: "Metal amt", kind: "inr" },
  { key: "diamondAmount", label: "Diamond amt", kind: "inr" },
  { key: "stoneAmount", label: "Stone amt", kind: "inr" },
  { key: "makingAmount", label: "Making", kind: "inr" },
  { key: "cpfAmount", label: "CPF", kind: "inr" },
  { key: "cost", label: "Cost", kind: "inr" },
];

function Pieces({ pieces }: { pieces: StockPieceFull[] }) {
  // A column appears when any piece has a value — cost columns are absent from
  // the response below store manager, so they never appear for a salesperson.
  const shown = PIECE_COLS.filter((c) => pieces.some((p) => p[c.key] != null && p[c.key] !== "" && p[c.key] !== 0));
  return (
    <Section title="Pieces on hand" note={<Badge variant="secondary">{pieces.length}</Badge>}>
      {pieces.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          No pieces in stock in your scope — this design is made to order.
        </p>
      ) : (
        <Table
          head={shown.map((c) => ({ label: c.label, num: c.kind === "g" || c.kind === "ct" || c.kind === "inr" || c.kind === "int" }))}
          rows={pieces.map((p) => ({
            key: p.id,
            cells: shown.map((c) => {
              const v = p[c.key];
              if (v == null || v === "") return "—";
              switch (c.kind) {
                case "g":
                  return formatGrams(Number(v));
                case "ct":
                  return formatCarats(Number(v));
                case "inr":
                  return formatINR(Number(v));
                case "mono":
                  return <span className="font-mono text-xs">{String(v)}</span>;
                default:
                  return String(v);
              }
            }),
          }))}
        />
      )}
    </Section>
  );
}

const PROVENANCE_LABELS: Record<string, string> = {
  gatiSyncedAt: "Gati last synced",
  gatiUpdatedAt: "Changed in Gati",
  websiteSyncedAt: "Website last synced",
  websiteSourceCreatedAt: "Created on the website",
  websiteSourceUpdatedAt: "Changed on the website",
  websiteLastSeenAt: "Last seen on the website",
  createdAt: "Created here",
  updatedAt: "Last updated here",
};

function Provenance({ data }: { data: ProductFull }) {
  // Timestamps only; the ids that ride along (import batch…) mean nothing here.
  const rows = Object.entries(data.provenance ?? {}).filter(([k, v]) => k.endsWith("At") && typeof v === "string" && v);
  if (!rows.length) return null;
  return (
    <Section title="Where this came from" icon={<History className="h-4 w-4" />}>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <Spec key={k} label={PROVENANCE_LABELS[k] ?? humanize(k)}>
            {when(String(v))}
          </Spec>
        ))}
      </dl>
    </Section>
  );
}

// ---------------------------------------------------------------- helpers

function Section({
  title,
  icon,
  note,
  children,
}: {
  title: string;
  icon?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        <h4 className="text-sm font-semibold">{title}</h4>
        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Table({
  head,
  rows,
}: {
  head: { label: string; num?: boolean }[];
  rows: { key: string; cells: ReactNode[] }[];
}) {
  return (
    <div className="-mx-3 overflow-x-auto px-3">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            {head.map((h) => (
              <th key={h.label} className={`whitespace-nowrap pb-1 pr-3 font-normal ${h.num ? "text-right" : ""}`}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t">
              {r.cells.map((c, i) => (
                <td key={i} className={`whitespace-nowrap py-1.5 pr-3 ${head[i]?.num ? "num text-right" : ""}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Spec({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

function ListSpec({ label, values }: { label: string; values?: string[] }) {
  if (!values?.length) return null;
  return <Spec label={label}>{values.join(", ")}</Spec>;
}

/** camelCase / snake_case → "Sentence case". */
function humanize(key: string): string {
  const s = key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}
