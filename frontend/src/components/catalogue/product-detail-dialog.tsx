"use client";

import Link from "next/link";
import { toast } from "sonner";
import { useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileText,
  Gem,
  Globe,
  Hash,
  History,
  Layers,
  Loader2,
  RefreshCw,
  Ruler,
  SearchX,
  Store,
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
  bomColumns,
  countryName,
  groupCodes,
  groupConflicts,
  historyRows,
  humanize,
  priceOptions,
  sortSizes,
  specLines,
  variantName,
} from "@/components/catalogue/product-detail-format";
import {
  isNotFound,
  useProductFull,
  type BomLine,
  type ProductFull,
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
 * it opens. It reads top to bottom the way a person at the counter asks:
 * what it costs and whether we have it, which options exist, what the website
 * says about it, what it is made of, and only then the technical record (the
 * website listing, codes and sync history), folded away by default.
 *
 * Cost columns (rates, amounts, margins) arrive only for roles allowed to see
 * them, so every table shows a column exactly when the API sent it.
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

  const canEdit = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const seesAmounts = canEdit;
  const styleNo = p.styleNumber || p.sku;
  // Source-data problems are a data-stewardship concern: shown once here for
  // managers and on Catalogue → Integration, never on the sales-facing grid or
  // to salespeople (client, 9 Oct).
  const checks = canEdit ? groupConflicts(data.conflicts) : [];

  return (
    <div className="space-y-4">
      {data.legacy ? (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          Showing the basic record. Options, the website listing and the full
          history appear once the server is updated.
        </p>
      ) : null}

      {checks.length ? <ToCheck checks={checks} /> : null}

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

      <AtAGlance data={data} />

      <Options data={data} />

      <AboutDesign data={data} flagged={checks.some((c) => c.kind === "spec_mismatch" || c.kind === "unit_mismatch")} />

      <Sizes sizes={data.sizes} guide={data.listing?.sizeGuide} />

      <MadeOf data={data} seesAmounts={seesAmounts} />

      <StockSection data={data} />

      {/* The technical record: folded away, opened by whoever needs it. */}
      <div className="space-y-2">
        <WebsiteListing data={data} />
        <Codes data={data} />
        <HistoryFold data={data} />
      </div>

      {refreshing ? (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Refreshing…
        </p>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------- sections

function ToCheck({ checks }: { checks: ReturnType<typeof groupConflicts> }) {
  return (
    <div
      role="alert"
      data-testid="detail-checks"
      className="space-y-2 rounded-lg border border-[color-mix(in_srgb,var(--warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-3"
    >
      <p className="flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="h-4 w-4 text-warning" />
        {checks.length === 1 ? "1 detail to check" : `${checks.length} details to check`}
      </p>
      <ul className="space-y-1.5 text-sm">
        {checks.map((c) => (
          <li key={`${c.kind}-${c.summary}`}>
            <span className="font-medium">{c.label}</span>
            {c.count > 1 ? <span className="text-muted-foreground"> (seen on {c.count} options)</span> : null}
            <span className="block text-xs text-muted-foreground">{c.summary}</span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        These come from the website or Gati exactly as they were sent — nothing here
        has been changed. Correct them at the source.{" "}
        <Link href="/catalogue/integration" className="font-medium text-foreground underline underline-offset-2">
          See all designs that need checking
        </Link>
      </p>
    </div>
  );
}

function AtAGlance({ data }: { data: ProductFull }) {
  const { data: config } = useConfigBootstrap();
  const fieldVisible = useFieldVisible(config);
  const showsMetal = fieldVisible("product", "metal");
  const showsKarat = fieldVisible("product", "purity");
  const showsWeight = fieldVisible("product", "grossWeight");
  const p = data;

  // A website design comes in several purities; say so rather than naming one.
  const karats = [...new Set((data.variants ?? []).map((v) => v.karat).filter((k): k is number => !!k))].sort((a, b) => a - b);
  const metalWord = (data.variants ?? []).find((v) => v.metalType)?.metalType ?? "Gold";
  const metalLabel = METAL_LABELS[p.metal] ?? p.metal;
  const metal =
    karats.length > 1 ? `${karats.map((k) => `${k}K`).join(", ")} ${metalWord.toLowerCase()}` : metalLabel;
  const purityInMetal = karats.length > 1 || (p.karat > 0 && String(metalLabel).includes(`${p.karat}K`));
  const stock = stockCount(data);

  return (
    <section className="space-y-3 rounded-lg border p-3" data-testid="detail-glance">
      <PriceBlock data={data} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <Spec label="Design code">
          <span className="break-all font-mono text-xs">{p.styleNumber || p.sku}</span>
        </Spec>
        {showsMetal ? (
          <Spec label={karats.length > 1 ? "Metal options" : "Metal"}>{metal}</Spec>
        ) : p.materialLabel ? (
          <Spec label="Material">{p.materialLabel}</Spec>
        ) : null}
        {showsKarat && p.karat > 0 && !purityInMetal ? (
          <Spec label="Purity">
            <span className="num">{formatPurity(p.karat)}</span>
          </Spec>
        ) : null}
        {showsWeight && p.caratWeight > 0 ? (
          <Spec label="Diamonds / stones">
            <span className="num">{formatCarats(p.caratWeight)}</span>
          </Spec>
        ) : null}
        {showsWeight && p.weightGrams > 0 ? (
          <Spec label="Gross weight">
            <span className="num">{formatGrams(p.weightGrams)}</span>
          </Spec>
        ) : null}
        <Spec label="Category">{p.categoryLabel || CATEGORY_LABELS[p.category]}</Spec>
        {p.unitOfMeasure ? <Spec label="Unit">{p.unitOfMeasure}</Spec> : null}
        {stock != null ? (
          <Spec label="Stock">
            {stock > 0 ? (
              <span className="text-emerald-700 dark:text-emerald-400">{stock} in stock</span>
            ) : (
              "Made to order"
            )}
          </Spec>
        ) : null}
        {p.source ? <Spec label="Comes from">{SOURCE_LABELS[p.source] ?? p.source}</Spec> : null}
      </dl>
      <CustomAttributeList entity="product" values={data.attributes} />
    </section>
  );
}

/** Pieces the viewer can see, from the per-store counts or the piece list; null when unknown. */
function stockCount(data: ProductFull): number | null {
  if (data.availabilityByStore) return data.availabilityByStore.reduce((n, r) => n + r.count, 0);
  if (data.stock) return data.stock.hereCount + data.stock.elsewhere.reduce((n, r) => n + r.count, 0);
  if (data.pieces) return data.pieces.length;
  return null;
}

function PriceBlock({ data }: { data: ProductFull }) {
  const p = data;
  const options = priceOptions(data);
  const pieceTags = (data.pieces ?? []).map((x) => x.tagPrice || x.mrp || 0).filter((v) => v > 0);
  const tag =
    (p.tagPrice ? range(p.tagPrice.min, p.tagPrice.max) : null) ??
    (pieceTags.length ? range(Math.min(...pieceTags), Math.max(...pieceTags)) : null);
  const fromWebsite = (data.prices ?? []).some((pr) => pr.source === "website");

  if (!options.length) {
    const online = p.onlinePrice ? range(p.onlinePrice.min, p.onlinePrice.max) : null;
    return (
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        {online ? <Figure label="Online price" value={online} /> : null}
        {tag ? <Figure label="Tag price" value={tag} /> : null}
        {!online && !tag && p.price > 0 ? <Figure label="Indicative price" value={formatINR(p.price)} /> : null}
        {!online && !tag && !(p.price > 0) ? <p className="text-sm text-muted-foreground">No price yet.</p> : null}
      </div>
    );
  }

  const amounts = options.map((o) => o.amount);
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  const shown = options.length > 8 ? options.slice(0, 6) : options;
  const rest = options.length > 8 ? options.slice(6) : [];

  return (
    <div className="space-y-2" data-testid="detail-price">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Price</p>
          <p className="text-lg font-semibold leading-tight">
            {low === high ? null : "From "}
            <span className="num">{formatINR(low)}</span>
          </p>
          {low !== high ? (
            <p className="text-xs text-muted-foreground">
              up to <span className="num">{formatINR(high)}</span>, depending on the option
            </p>
          ) : null}
        </div>
        {tag ? <Figure label="Tag price (pieces in stock)" value={tag} /> : null}
      </div>
      {options.length > 1 ? (
        <div>
          <ul className="divide-y rounded-md border text-sm">
            {shown.map((o) => (
              <PriceRow key={o.key} label={o.label} amount={o.amount} />
            ))}
          </ul>
          {rest.length ? (
            <details className="mt-1 text-sm">
              <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
                {rest.length} more prices
              </summary>
              <ul className="mt-1 divide-y rounded-md border">
                {rest.map((o) => (
                  <PriceRow key={o.key} label={o.label} amount={o.amount} />
                ))}
              </ul>
            </details>
          ) : null}
          {fromWebsite ? (
            <p className="mt-1 text-[11px] text-muted-foreground">Prices as listed on the website.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PriceRow({ label, amount }: { label: string; amount: number }) {
  return (
    <li className="flex items-baseline justify-between gap-3 px-3 py-1.5">
      <span>{label}</span>
      <span className="num shrink-0 font-medium">{formatINR(amount)}</span>
    </li>
  );
}

function range(min?: number | null, max?: number | null): string | null {
  if (min == null && max == null) return null;
  if (min == null || max == null || min === max) return formatINR((min ?? max)!);
  return `${formatINR(min)} – ${formatINR(max)}`;
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="num text-[13px] font-semibold">{value}</p>
    </div>
  );
}

/** The choices a customer makes (purity, metal, diamond), with weights and price. */
function Options({ data }: { data: ProductFull }) {
  const variants = data.variants ?? [];
  if (!variants.length) return null;
  const any = (pick: (v: (typeof variants)[number]) => unknown) => variants.some((v) => pick(v) != null && pick(v) !== "");
  // Each option's price is listed at the top, so this table carries the weights.
  const head = [
    { label: "Option", wrap: true },
    ...(any((v) => v.goldWeight) ? [{ label: "Metal", num: true }] : []),
    ...(any((v) => v.diamondWeight) ? [{ label: "Diamond", num: true }] : []),
    ...(any((v) => v.stoneWeight) ? [{ label: "Stones", num: true }] : []),
  ];
  return (
    <Section title={variants.length === 1 ? "Option" : `Options (${variants.length})`} icon={<Layers className="h-4 w-4" />}>
      <Table
        head={head}
        rows={variants.map((v) => ({
          key: v.id,
          cells: [
            variantName(v),
            ...(any((x) => x.goldWeight) ? [formatGrams(v.goldWeight)] : []),
            ...(any((x) => x.diamondWeight) ? [formatCarats(v.diamondWeight)] : []),
            ...(any((x) => x.stoneWeight) ? [formatCarats(v.stoneWeight)] : []),
          ],
        }))}
      />
      <Fold title="All option details" hint="codes, totals, margins" className="mt-2">
        <OptionTable data={data} />
      </Fold>
    </Section>
  );
}

/** Every column the source sent for the options — the full record, folded away. */
function OptionTable({ data }: { data: ProductFull }) {
  const variants = data.variants ?? [];
  const has = (k: keyof (typeof variants)[number]) => variants.some((v) => v[k] != null && v[k] !== "");
  const cols: { key: keyof (typeof variants)[number]; label: string; render: (v: (typeof variants)[number]) => ReactNode; num?: boolean }[] = [
    { key: "sku", label: "Code", render: (v) => <span className="font-mono text-xs">{v.sku}</span> },
    { key: "karat", label: "Purity", render: (v) => (v.karat ? `${v.karat}K` : "—"), num: true },
    { key: "metalType", label: "Metal", render: (v) => v.metalType },
    { key: "colour", label: "Colour", render: (v) => v.colour },
    { key: "diamondType", label: "Diamond", render: (v) => v.diamondType },
    { key: "goldWeight", label: "Metal wt", render: (v) => formatGrams(v.goldWeight), num: true },
    { key: "diamondWeight", label: "Diamond wt", render: (v) => formatCarats(v.diamondWeight), num: true },
    { key: "stoneWeight", label: "Stone wt", render: (v) => formatCarats(v.stoneWeight), num: true },
    { key: "totalWeight", label: "Total wt (as sent)", render: (v) => formatNumber(v.totalWeight ?? 0, 3), num: true },
    { key: "price", label: "Price", render: (v) => (v.price != null ? formatINR(v.price) : "—"), num: true },
    { key: "priceWithMargin", label: "With margin", render: (v) => (v.priceWithMargin != null ? formatINR(v.priceWithMargin) : "—"), num: true },
    { key: "marginPercentage", label: "Margin", render: (v) => (v.marginPercentage != null ? `${v.marginPercentage}%` : "—"), num: true },
    { key: "makingCharge", label: "Making", render: (v) => (v.makingCharge != null ? formatINR(v.makingCharge) : "—"), num: true },
    { key: "status", label: "Status", render: (v) => v.status },
  ];
  const shown = cols.filter((c) => has(c.key));
  return (
    <Table
      head={shown.map((c) => ({ label: c.label, num: c.num }))}
      rows={variants.map((v) => ({ key: v.id, cells: shown.map((c) => c.render(v) ?? "—") }))}
    />
  );
}

/** What the website (or Gati) says about the design, laid out as a list. */
function AboutDesign({ data, flagged }: { data: ProductFull; flagged: boolean }) {
  const spec = data.specifications;
  const lines = spec?.text ? specLines(spec.text) : [];
  const listingText = data.listing?.description;
  if (!lines.length && !listingText && !data.description) return null;
  const items = lines.filter((l) => l.kind === "item");
  const texts = lines.filter((l) => l.kind === "text");
  return (
    <Section title="About this design" icon={<FileText className="h-4 w-4" />}>
      <div className="space-y-2 text-sm">
        {texts.map((t, i) => (t.kind === "text" ? <p key={`t${i}`} className="text-muted-foreground">{t.text}</p> : null))}
        {items.length ? (
          <dl className="divide-y rounded-md border">
            {items.map((l, i) =>
              l.kind === "item" ? (
                <div key={`i${i}`} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 px-3 py-1.5">
                  {l.key ? <dt className="text-muted-foreground">{l.key}</dt> : null}
                  <dd className={l.key ? "font-medium sm:text-right" : "font-medium"}>{l.value}</dd>
                </div>
              ) : null,
            )}
          </dl>
        ) : null}
        {listingText ? <p className="whitespace-pre-line text-muted-foreground">{listingText}</p> : null}
        {data.description ? <p className="text-muted-foreground">{data.description}</p> : null}
      </div>
      {spec?.text ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Word for word from the {spec.source === "gati" ? "Gati record" : "website"}
          {spec.syncedAt ? ` (as of ${when(spec.syncedAt)})` : ""}.
          {flagged ? " Where it disagrees with the materials list, see “details to check” above." : ""}
        </p>
      ) : null}
    </Section>
  );
}

function Sizes({ sizes, guide }: { sizes?: ProductFull["sizes"]; guide?: string | null }) {
  const values = sortSizes((sizes ?? []).map((s) => (typeof s === "string" ? s : s.value)).filter(Boolean));
  if (!values.length && !guide) return null;
  return (
    <Section
      title={values.length ? `Sizes available (${values.length})` : "Sizes"}
      icon={<Ruler className="h-4 w-4" />}
      note={values.length > 1 ? `${values[0]} to ${values[values.length - 1]}` : undefined}
    >
      {values.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <li key={v} className="rounded-full border px-2.5 py-0.5 text-xs">
              {v}
            </li>
          ))}
        </ul>
      ) : null}
      {guide ? (
        <Fold title="Size guide" className="mt-2">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm">{guide}</pre>
        </Fold>
      ) : null}
    </Section>
  );
}

/** What the design is made of: the friendly breakdown, then the raw lists per option. */
function MadeOf({ data, seesAmounts }: { data: ProductFull; seesAmounts: boolean }) {
  const parts = data.composition?.lines ?? [];
  const bomVariants = (data.variants ?? []).filter((v) => Array.isArray(v.bom) && v.bom.length);
  if (!parts.length && !bomVariants.length) return null;
  const hasPieces = parts.some((l) => l.pieces);
  const hasRates = parts.some((l) => l.rate);
  const hasAmounts = parts.some((l) => l.amount);
  const total = parts.reduce((n, l) => n + (l.amount ?? 0), 0);
  const source = data.composition?.source === "gati" ? "Gati" : "the website";
  return (
    <Section title="What it's made of" icon={<Gem className="h-4 w-4" />} note={parts.length ? `from ${source}` : undefined}>
      {parts.length ? (
        <Table
          head={[
            { label: "Material", wrap: true },
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
              ? [{ key: "total", cells: [<span key="t" className="font-semibold">Total</span>, "", ...(hasPieces ? [""] : []), ...(hasRates ? [""] : []), <span key="a" className="font-semibold">{formatINR(total)}</span>] }]
              : []),
          ]}
        />
      ) : null}
      {bomVariants.length ? (
        <Fold
          title={bomVariants.length === 1 ? "Materials list" : `Materials list for each option (${bomVariants.length})`}
          hint="as the website sent it"
          className={parts.length ? "mt-2" : undefined}
        >
          <div className="space-y-2">
            {bomVariants.map((v, i) => (
              <details key={v.id} open={bomVariants.length === 1 || i === 0} className="rounded-md border px-3 py-2">
                <summary className="cursor-pointer select-none text-sm font-medium">
                  {variantName(v)} <span className="text-xs text-muted-foreground">· {v.bom!.length} lines</span>
                </summary>
                <div className="mt-2">
                  <BomTable lines={v.bom!} />
                </div>
              </details>
            ))}
            <p className="text-[11px] text-muted-foreground">
              Weights and units are shown exactly as the website sent them.
            </p>
          </div>
        </Fold>
      ) : null}
      {!seesAmounts ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Rates and amounts are shown to store managers and head office.
        </p>
      ) : null}
    </Section>
  );
}

const MONEY_KEY = /amount|rate|total|price|value|charge|cost/i;

/** Columns are the keys the response actually carries — cost keys are simply absent below manager. */
function BomTable({ lines }: { lines: BomLine[] }) {
  const cols = bomColumns(lines);
  return (
    <Table
      head={cols.map((c) => ({ label: c.label, num: lines.some((l) => typeof l[c.key] === "number") }))}
      rows={lines.map((l, i) => ({
        key: String(i),
        cells: cols.map((c) => cell(c.key, l[c.key])),
      }))}
    />
  );
}

function cell(key: string, v: unknown): ReactNode {
  if (v == null || v === "") return "—";
  if (typeof v === "number") return MONEY_KEY.test(key) ? formatINR(v, { fractionDigits: 2 }) : formatNumber(v, Number.isInteger(v) ? 0 : 3);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

/** Where the design can be had, and every piece with its tag. One place for both. */
function StockSection({ data }: { data: ProductFull }) {
  const stock = data.stock;
  const pieces = data.pieces ?? [];
  const rows =
    data.availabilityByStore ??
    (stock
      ? [
          ...(stock.hereCount ? [{ storeId: "here", storeName: "This store", count: stock.hereCount, here: true }] : []),
          ...stock.elsewhere,
        ]
      : []);
  const total = stockCount(data);
  // Nothing known (an older server): say nothing rather than "made to order".
  if (total == null) return null;
  return (
    <Section
      title="Stock"
      icon={<Store className="h-4 w-4" />}
      note={<Badge variant="secondary">{total === 1 ? "1 piece" : `${total} pieces`}</Badge>}
    >
      {total === 0 && pieces.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="detail-made-to-order">
          None in stock in the stores you can see — this design is made to order.
        </p>
      ) : (
        <div className="space-y-3">
          {rows.length ? (
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
          ) : null}
          {pieces.length ? <PieceTable pieces={pieces} /> : null}
        </div>
      )}
    </Section>
  );
}

type PieceKey = keyof StockPieceFull;
const PIECE_COLS: { key: PieceKey; label: string; kind?: "g" | "ct" | "inr" | "int" | "mono"; help: string }[] = [
  { key: "tagNo", label: "Tag", kind: "mono", help: "The piece's tag number in Gati." },
  { key: "storeName", label: "Store", help: "Where the piece is right now." },
  { key: "sizeLabel", label: "Size", help: "Ring or bangle size." },
  { key: "hsn", label: "HSN", kind: "mono", help: "GST HSN code." },
  { key: "huid", label: "HUID", kind: "mono", help: "The 6-character BIS hallmark ID on the piece." },
  { key: "hallmarkNo", label: "Hallmark", kind: "mono", help: "Hallmark number." },
  { key: "certificateNo", label: "Certificate", kind: "mono", help: "Diamond certificate (grading report) number." },
  { key: "grossWeight", label: "Gross", kind: "g", help: "Whole piece: metal + diamonds + stones." },
  { key: "netWeight", label: "Net", kind: "g", help: "Metal only: gross minus diamonds and stones." },
  { key: "pureWeight", label: "Pure", kind: "g", help: "Pure gold in the metal (net × purity)." },
  { key: "diamondWeightCt", label: "Diamond", kind: "ct", help: "Total diamond weight, in carats." },
  { key: "diamondPieces", label: "Dia pcs", kind: "int", help: "Number of diamonds." },
  { key: "stoneWeightCt", label: "Stone", kind: "ct", help: "Colour-stone weight, in carats." },
  { key: "stonePieces", label: "Stone pcs", kind: "int", help: "Number of colour stones." },
  { key: "quantity", label: "Qty", kind: "int", help: "Pieces under this tag." },
  { key: "tagPrice", label: "Tag price", kind: "inr", help: "Selling price on the tag." },
  { key: "mrp", label: "MRP", kind: "inr", help: "Maximum retail price." },
  { key: "metalAmount", label: "Metal amt", kind: "inr", help: "Value of the metal." },
  { key: "diamondAmount", label: "Diamond amt", kind: "inr", help: "Value of the diamonds." },
  { key: "stoneAmount", label: "Stone amt", kind: "inr", help: "Value of the colour stones." },
  { key: "makingAmount", label: "Making", kind: "inr", help: "Making (labour) charge." },
  { key: "cpfAmount", label: "CPF", kind: "inr", help: "CPF charge, as in Gati." },
  { key: "cost", label: "Cost", kind: "inr", help: "What the piece cost." },
];

function PieceTable({ pieces }: { pieces: StockPieceFull[] }) {
  // A column appears when any piece has a value — cost columns are absent from
  // the response below store manager, so they never appear for a salesperson.
  const shown = PIECE_COLS.filter((c) => pieces.some((p) => p[c.key] != null && p[c.key] !== "" && p[c.key] !== 0));
  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">Tap a column name to see what it means.</p>
      <Table
        head={shown.map((c) => ({ label: c.label, help: c.help, num: c.kind === "g" || c.kind === "ct" || c.kind === "inr" || c.kind === "int" }))}
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
    </div>
  );
}

function WebsiteListing({ data }: { data: ProductFull }) {
  const listing = data.listing;
  if (!listing) return null;
  const state = listing.isDeleted ? (
    <Badge variant="destructive">Deleted on the website</Badge>
  ) : listing.isActive === false ? (
    <Badge variant="warning">Hidden on the website</Badge>
  ) : (
    <Badge variant="success">Live on the website</Badge>
  );
  return (
    <Fold title="On the website" icon={<Globe className="h-4 w-4" />} hint={state} testId="detail-listing">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        {listing.marketingName ? <Spec label="Name on the website">{listing.marketingName}</Spec> : null}
        <ListSpec label="Website categories" values={listing.categories} />
        <ListSpec label="Website sub-categories" values={listing.subCategories} />
        <ListSpec label="Highlights" values={listing.features} />
        <ListSpec label="Tags" values={listing.tags} />
        <ListSpec label="Sold online in" values={listing.countries?.map(countryName)} />
        {listing.slug ? (
          <Spec label="Page address">
            <span className="break-all font-mono text-xs">{listing.slug}</span>
          </Spec>
        ) : null}
      </dl>
    </Fold>
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

function Codes({ data: p }: { data: ProductFull }) {
  const rows = groupCodes(
    {
      styleNumber: p.styleNumber || p.sku,
      sku: p.sku,
      gatiId: p.gatiId,
      websiteCode: p.websiteCode,
      hsn: p.hsn,
      ...(p.identifiers ?? {}),
    },
    (k) => ID_LABELS[k] ?? humanize(k),
  );
  if (!rows.length) return null;
  return (
    <Fold title="Codes" icon={<Hash className="h-4 w-4" />} hint={`${rows.length} ${rows.length === 1 ? "code" : "codes"}`}>
      <dl className="space-y-1.5 text-sm">
        {rows.map((r) => (
          <div key={r.value} className="flex flex-wrap items-baseline justify-between gap-x-4">
            <dt className="text-xs text-muted-foreground">{r.labels.join(" · ")}</dt>
            <dd className="break-all font-mono text-xs font-medium">{r.value}</dd>
          </div>
        ))}
      </dl>
    </Fold>
  );
}

function HistoryFold({ data }: { data: ProductFull }) {
  const rows = historyRows(data.provenance);
  if (!rows.length) return null;
  return (
    <Fold title="History" icon={<History className="h-4 w-4" />} hint={`last change ${when(rows[rows.length - 1].at)}`}>
      <ol className="space-y-1.5 text-sm">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap justify-between gap-x-4">
            <span className="text-muted-foreground">{r.label}</span>
            <span className="num font-medium">{when(r.at)}</span>
          </li>
        ))}
      </ol>
    </Fold>
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

/** A section that starts closed: the record is there, out of the way. */
function Fold({
  title,
  icon,
  hint,
  className,
  testId,
  children,
}: {
  title: string;
  icon?: ReactNode;
  hint?: ReactNode;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <details className={`group rounded-lg border ${className ?? ""}`} data-testid={testId}>
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2.5 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        <span>{title}</span>
        {hint ? <span className="ml-auto text-xs font-normal text-muted-foreground">{hint}</span> : null}
      </summary>
      <div className="border-t px-3 py-3">{children}</div>
    </details>
  );
}

function Table({
  head,
  rows,
}: {
  /** `help` makes the column tappable: its name and meaning, wherever the header scrolled to. */
  head: { label: string; num?: boolean; help?: string; wrap?: boolean }[];
  rows: { key: string; cells: ReactNode[] }[];
}) {
  const explain = (i: number) => {
    const h = head[i];
    if (h?.help) toast(h.label, { description: h.help });
  };
  return (
    <div className="-mx-3 overflow-x-auto px-3">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            {head.map((h) => (
              <th key={h.label} className={`whitespace-nowrap pb-1 pr-3 font-normal ${h.num ? "text-right" : ""}`}>
                {h.help ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      explain(head.indexOf(h));
                    }}
                    title={h.help}
                    className="cursor-help underline decoration-dotted underline-offset-4"
                  >
                    {h.label}
                  </button>
                ) : (
                  h.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t">
              {r.cells.map((c, i) => (
                <td
                  key={i}
                  onClick={head[i]?.help ? () => explain(i) : undefined}
                  title={head[i]?.help ? `${head[i].label}: ${head[i].help}` : undefined}
                  className={`${head[i]?.wrap ? "min-w-32" : "whitespace-nowrap"} py-1.5 pr-3 ${head[i]?.num ? "num text-right" : ""} ${head[i]?.help ? "cursor-help" : ""}`}
                >
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

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}
