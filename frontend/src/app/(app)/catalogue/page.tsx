"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ImagePlus, Search, SlidersHorizontal, X } from "lucide-react";
import { toast } from "sonner";

import { ImageSearch } from "@/components/catalogue/image-search";
import { ProductCard } from "@/components/catalogue/product-card";
import { CustomAttributeFields } from "@/components/common/custom-attributes";
import {
  useConfigBootstrap,
  useFieldVisible,
} from "@/lib/queries/tenant-config";
import { ProductDetailDialog } from "@/components/catalogue/product-detail-dialog";
import { SectionHeader } from "@/components/section/section-header";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PaginationBar } from "@/components/ui/pagination-bar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getNavItem } from "@/lib/navigation";
import {
  CATEGORY_LABELS,
  METAL_LABELS,
  SOURCE_LABELS,
  type Availability,
  type Metal,
  type Product,
  type ProductCategory,
  type ProductSource,
} from "@/lib/mock/catalogue";
import {
  httpStatus,
  useAddProductImages,
  useCreateProduct,
  useProducts,
  type ImageCoverage,
} from "@/lib/queries/products";
import { prepareQueryImage } from "@/lib/queries/jewelry-similarity";
import { advancedFilterCount, catalogueListParams } from "@/lib/catalogue-filters";
import { useDebouncedValue } from "@/lib/queries/search";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { apiErrorMessage, isRealName, positiveNumberInput } from "@/lib/utils";

const nav = getNavItem("catalogue")!;

const KARATS = [24, 22, 18, 14, 12, 10, 9];
const COVERAGE_LABELS: Record<ImageCoverage, string> = {
  none: "No photo",
  no_cad: "No CAD",
  unindexed: "Not searchable yet",
  indexed: "Searchable by photo",
};
/** Every URL key that holds a filter: "Clear all" shows while any is set, readable or not. */
const FILTER_KEYS = ["q", "category", "availability", "store", "subCategory", "size", "karat", "colour", "metal", "priceMin", "priceMax", "source", "coverage"];
const PAGE_SIZE_DEFAULT = 100;

export default function CataloguePage() {
  // Filters live in the URL so a filtered catalogue survives a refresh and can
  // be shared. useSearchParams needs a Suspense boundary or the production
  // build refuses to prerender the page.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
      <CatalogueView />
    </Suspense>
  );
}

function CatalogueView() {
  const { currentStore, stores, role } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  // The tenant's noun for a product — "Item" in a factory, "Article" in a
  // textile business, "Product" everywhere the industry has no opinion.
  const { data: pageConfig } = useConfigBootstrap();
  const productNoun = pageConfig?.lexicon?.product ?? "Product";
  const productNounPlural = pageConfig?.lexicon?.product_plural ?? "Products";
  // The jewellery filters mean nothing to a pack that hides the metal field.
  const showsMetalFilters = useFieldVisible(pageConfig)("product", "metal");
  const [active, setActive] = useState<Product | null>(null);
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const get = (k: string) => sp.get(k) ?? "";
  /** Write filters to the URL (no history entry per click); a filter change resets the page. */
  const setParams = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!("page" in patch)) next.delete("page");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const q = get("q");
  const category = get("category") as ProductCategory | "";
  const metal = get("metal") as Metal | "";
  const avail = get("availability") as Availability | "";
  // No store in the URL = the session's store, as before; "all" is explicit.
  const store = get("store") || (currentStore.isAggregate ? "all" : currentStore.id);
  const karat = get("karat");
  const source = get("source") as ProductSource | "";
  const coverage = get("coverage") as ImageCoverage | "";
  // A stale or hand-typed URL ("page=2.5", "pageSize=1000") falls back, never 400s.
  const page = Math.max(1, Math.floor(Number(get("page"))) || 1);
  const sizeAsked = Math.floor(Number(get("pageSize")));
  const pageSize = sizeAsked >= 1 && sizeAsked <= 500 ? sizeAsked : PAGE_SIZE_DEFAULT;
  const params = catalogueListParams(get, { store, showsMetalFilters, page, pageSize });
  const advancedCount = advancedFilterCount(params);
  const [showAdvanced, setShowAdvanced] = useState(advancedCount > 0);

  const { data, isLoading, isError, error, refetch, isPlaceholderData } = useProducts(params);
  // The previous results stay on screen while new ones load: say so.
  const updating = isPlaceholderData;
  const products = data?.items ?? [];
  const total = data?.total ?? 0;

  function openProduct(p: Product) {
    setActive(p);
    setOpen(true);
  }

  // An exact code opens its design straight away — once per search, so closing
  // the dialog does not reopen it while the same text is still in the box.
  const [autoOpened, setAutoOpened] = useState("");
  if (q && autoOpened !== q) {
    const needle = q.toLowerCase();
    const hit = products.find((p) =>
      [p.styleNumber, p.name, p.sku, p.websiteCode].some((v) => v?.toLowerCase() === needle),
    );
    if (hit) {
      setAutoOpened(q);
      setActive(hit);
      setOpen(true);
    }
  }

  const selectStores = stores.filter((s) => !s.isAggregate);
  // POST /products requires store_manager+; hide the CTA for salespeople.
  const canAddProduct = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const anyFilter = FILTER_KEYS.some((k) => get(k));
  // Besides the search text, is anything else narrowing the list?
  const narrowed = advancedCount > 0 || !!params.category || !!params.availability;
  const rejected = isError && (httpStatus(error) ?? 500) < 500;

  return (
    <>
      <SectionHeader
        title={nav.title}
        purpose={nav.purpose}
        primaryAction={canAddProduct ? nav.primaryAction : undefined}
        onPrimaryAction={() => setAddOpen(true)}
      />

      <div className="mb-6 space-y-2">
        <ImageSearch />
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative min-w-[240px] flex-[2_1_240px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <UrlText
            value={q}
            onCommit={(v) => setParams({ q: v })}
            placeholder="Style no, SKU or name — e.g. SK-010225-A"
            aria-label="Search designs by style number, SKU or name"
            className="h-11 pl-9 pr-9"
          />
          {q ? (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => setParams({ q: "" })}
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        {showsMetalFilters ? (
          <UrlSelect
            label="Category"
            value={category}
            onChange={(v) => setParams({ category: v })}
            options={Object.entries(CATEGORY_LABELS)}
            allLabel="All categories"
          />
        ) : null}
        <UrlSelect
          label="Store"
          value={store}
          onChange={(v) => setParams({ store: v || "all" })}
          options={selectStores.map((s) => [s.id, s.name])}
          allLabel="All stores"
          allValue="all"
          className="w-[170px]"
        />
        <UrlSelect
          label="Availability"
          value={avail}
          onChange={(v) => setParams({ availability: v })}
          options={[
            ["in_stock", "In-Stock"],
            ["lead_time", "Lead-Time"],
          ]}
          allLabel="All availability"
        />
        <Button
          type="button"
          variant="outline"
          className="h-11"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((s) => !s)}
        >
          <SlidersHorizontal className="h-4 w-4" />
          More filters{advancedCount ? ` (${advancedCount})` : ""}
        </Button>
        {anyFilter ? (
          <Button type="button" variant="ghost" className="h-11" onClick={() => router.replace(pathname, { scroll: false })}>
            <X className="h-4 w-4" /> Clear all
          </Button>
        ) : null}
      </div>

      {showAdvanced ? (
        <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg border bg-muted/20 p-3 sm:grid-cols-3 lg:grid-cols-5">
          <Field label="Sub-category">
            <UrlText value={get("subCategory")} onCommit={(v) => setParams({ subCategory: v })} placeholder="e.g. Solitaire, Engagement" />
          </Field>
          <Field label="Size">
            <UrlText value={get("size")} onCommit={(v) => setParams({ size: v })} placeholder="e.g. 12 or IND 12" />
          </Field>
          {showsMetalFilters ? (
            <>
              <Field label="Karat">
                <UrlSelect
                  label="Karat"
                  value={karat}
                  onChange={(v) => setParams({ karat: v })}
                  options={KARATS.map((k) => [String(k), `${k}K`])}
                  allLabel="Any karat"
                  className="w-full"
                />
              </Field>
              <Field label="Colour">
                <UrlText value={get("colour")} onCommit={(v) => setParams({ colour: v })} placeholder="e.g. rose" />
              </Field>
              <Field label="Metal">
                <UrlSelect
                  label="Metal"
                  value={metal}
                  onChange={(v) => setParams({ metal: v })}
                  options={Object.entries(METAL_LABELS).filter(([id]) => id !== "unspecified")}
                  allLabel="All metals"
                  className="w-full"
                />
              </Field>
            </>
          ) : null}
          <Field label="Price from (₹)">
            <UrlText value={get("priceMin")} onCommit={(v) => setParams({ priceMin: v })} sanitize={positiveNumberInput} inputMode="decimal" />
          </Field>
          <Field label="Price to (₹)">
            <UrlText value={get("priceMax")} onCommit={(v) => setParams({ priceMax: v })} sanitize={positiveNumberInput} inputMode="decimal" />
          </Field>
          <Field label="Source">
            <UrlSelect
              label="Source"
              value={source}
              onChange={(v) => setParams({ source: v })}
              options={Object.entries(SOURCE_LABELS)}
              allLabel="Any source"
              className="w-full"
            />
          </Field>
          <Field label="Photos">
            <UrlSelect
              label="Photo coverage"
              value={coverage}
              onChange={(v) => setParams({ coverage: v })}
              options={Object.entries(COVERAGE_LABELS)}
              allLabel="Any"
              className="w-full"
            />
          </Field>
        </div>
      ) : null}

      <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
        <span className="num">{total}</span>{" "}
        {total === 1 ? productNoun.toLowerCase() : productNounPlural.toLowerCase()}
        {updating ? " · updating…" : null}
      </p>

      {isError ? (
        <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
          <p className="text-sm font-medium">Couldn&apos;t load the catalogue.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {rejected
              ? apiErrorMessage(error, "One of the filters was not accepted.")
              : "The connection may have dropped. Check your network and try again."}
          </p>
          {rejected ? (
            <Button variant="outline" size="sm" className="mt-3" onClick={() => router.replace(pathname, { scroll: false })}>
              Clear filters
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
              Retry
            </Button>
          )}
        </div>
      ) : (
        <>
          <div
            className={`grid grid-cols-2 gap-3 transition-opacity sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 ${updating ? "opacity-60" : ""}`}
            aria-busy={updating}
          >
            {isLoading
              ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-72 rounded-xl" />)
              : products.map((p) => <ProductCard key={p.id} product={p} onOpen={openProduct} scoped={store !== "all"} />)}
          </div>

          {!isLoading && !updating && products.length === 0 ? (
            <p className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
              {q && narrowed
                ? `Nothing matches “${q}” with these filters. Clear a filter, or check the code.`
                : q
                  ? `Nothing matches “${q}”. Check the code, or search by part of it.`
                  : `No ${productNounPlural.toLowerCase()} match these filters. Adjust them or add one.`}
            </p>
          ) : null}

          {!isLoading && total > 0 ? (
            <PaginationBar
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={(n) => setParams({ page: n > 1 ? String(n) : "" })}
              onPageSizeChange={(size) =>
                setParams({ pageSize: size === PAGE_SIZE_DEFAULT ? "" : String(size) })
              }
            />
          ) : null}
        </>
      )}

      <ProductDetailDialog
        productId={active?.id ?? null}
        seed={active ?? undefined}
        open={open}
        onOpenChange={setOpen}
      />

      <AddProductDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

/**
 * A text filter that types locally and writes to the URL once typing pauses.
 * Commits only when the debounce has caught up with the box, so "Clear all"
 * cannot be undone by a stale value arriving 300ms later.
 */
function UrlText({
  value,
  onCommit,
  sanitize,
  className = "h-11",
  ...props
}: {
  value: string;
  onCommit: (v: string) => void;
  /** Cleans each keystroke, e.g. a price box that cannot hold "-" or letters. */
  sanitize?: (raw: string) => string;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange">) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value !== text.trim()) setText(value);
  }
  const debounced = useDebouncedValue(text.trim(), 300);
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  });
  useEffect(() => {
    if (debounced === text.trim() && debounced !== value) commit.current(debounced);
  }, [debounced, text, value]);
  return (
    <Input
      value={text}
      onChange={(e) => setText(sanitize ? sanitize(e.target.value) : e.target.value)}
      className={className}
      {...props}
    />
  );
}

/** Select bound to one URL param; "" (or `allValue`) means no filter. */
function UrlSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
  allValue = "__all__",
  className = "w-[150px]",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  allLabel: string;
  allValue?: string;
  className?: string;
}) {
  return (
    <Select value={value || allValue} onValueChange={(v) => onChange(v === "__all__" ? "" : v)}>
      <SelectTrigger aria-label={label} className={`h-11 ${className}`}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={allValue}>{allLabel}</SelectItem>
        {options.map(([id, text]) => (
          <SelectItem key={id} value={id}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AddProductDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const createProduct = useCreateProduct();
  const addImages = useAddProductImages();
  const photoRef = useRef<HTMLInputElement>(null);
  /*
   * What this tenant's industry says a product HAS.
   *
   * `showsMetal` stands in for "this is a jewellery-shaped catalogue". When the
   * pack hides the metal field, the gold-specific inputs below are not rendered,
   * not validated, and — the part that actually mattered — not submitted with
   * invented values. A clinic's paracetamol was being stored as a 22K gold
   * necklace because the form's defaults were sent whether or not anyone saw
   * them.
   */
  const { data: config } = useConfigBootstrap();
  const fieldVisible = useFieldVisible(config);
  // The pack's policy keys are the DATA names (`purity`, `grossWeight`); the
  // form's controls are the older UI names (karat, weight). Mapped here, once.
  const showsMetal = fieldVisible("product", "metal");
  const showsKarat = fieldVisible("product", "purity");
  const showsWeight = fieldVisible("product", "grossWeight");
  const categoryTerms = config?.taxonomies?.product_category?.terms ?? [];
  const productNoun = config?.lexicon?.product ?? "Product";
  const productNounPlural = config?.lexicon?.product_plural ?? "Products";

  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<ProductCategory>("necklace");
  const [metal, setMetal] = useState<Metal>("gold_22k");
  /** The tenant's own category word, when the enum has no member for it. */
  const [categoryLabel, setCategoryLabel] = useState("");
  /** What this trade counts in — strips, boxes, metres. */
  const [unitOfMeasure, setUnitOfMeasure] = useState("");
  const [karat, setKarat] = useState("");
  const [weight, setWeight] = useState("");
  const [price, setPrice] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [attributes, setAttributes] = useState<Record<string, unknown>>({});
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  // Inline validation errors, keyed by field. Cleared per-field on change.
  const [errors, setErrors] = useState<Record<string, string>>({});

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  function pickPhoto(file: File | null) {
    setPhotoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return file ? URL.createObjectURL(file) : null;
    });
    setPhoto(file);
  }

  function reset() {
    setSku("");
    setName("");
    setCategory(showsMetal ? "necklace" : "other");
    setMetal(showsMetal ? "gold_22k" : "unspecified");
    setCategoryLabel("");
    setUnitOfMeasure("");
    setKarat("");
    setWeight("");
    setPrice("");
    setErrors({});
    // Custom attribute values used to survive a reset and leak into the next
    // product added in the same session.
    setAttributes({});
    pickPhoto(null);
    if (photoRef.current) photoRef.current.value = "";
  }


  function save() {
    if (!targetStoreId) {
      toast.error("Select a store to add this product to.");
      return;
    }
    const next: Record<string, string> = {};
    if (!sku.trim()) next.sku = "SKU is required.";
    if (!name.trim()) next.name = "Product name is required.";
    else if (!isRealName(name))
      next.name = "Enter a real name — letters, not just a number.";
    // Only validate what is on screen: a hidden field must never be able to
    // block a submit the user cannot see the reason for.
    if (showsKarat && karat.trim() && Number(karat) < 0) next.karat = "Cannot be negative.";
    if (showsWeight && weight.trim() && Number(weight) < 0) next.weight = "Cannot be negative.";
    if (price.trim() && Number(price) < 0) next.price = "Cannot be negative.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fix the highlighted fields.");
      return;
    }
    createProduct.mutate(
      {
        sku: sku.trim(),
        name: name.trim(),
        /*
         * DERIVED, never a leftover of state.
         *
         * The dialog mounts holding the jewellery defaults, and an industry
         * without metals never shows the controls that would change them — so
         * submitting the state directly is precisely how a box of tablets came
         * to be stored as a 22K gold necklace. Deciding here, from the same flag
         * that hides the inputs, means the two can never disagree.
         */
        category: showsMetal ? category : "other",
        metal: showsMetal ? metal : "unspecified",
        // The tenant's own word for the category, stored alongside the neutral
        // enum member rather than instead of it.
        categoryLabel: !showsMetal && categoryLabel.trim() ? categoryLabel.trim() : undefined,
        unitOfMeasure: !showsMetal && unitOfMeasure.trim() ? unitOfMeasure.trim() : undefined,
        // A hidden measurement is not sent at all — not defaulted, not zeroed.
        karat: showsKarat && karat.trim() ? Number(karat) : undefined,
        weightGrams: showsWeight && weight.trim() ? Number(weight) : undefined,
        price: price.trim() ? Number(price) : undefined,
        storeId: targetStoreId,
        // Only sent when the tenant actually filled something in, so an
        // organisation with no custom fields posts exactly what it did before.
        attributes: Object.keys(attributes).length ? attributes : undefined,
      },
      {
        onSuccess: (created) => {
          toast.success("Product added");
          reset();
          onOpenChange(false);
          // Photo picked up-front → added the way the gallery adds one: shrunk
          // to a ≤1600 px JPEG, on the route with the 12 MB limit and the long
          // timeout. Sent raw to the single-photo route, a 9 MB phone photo was
          // refused after "Product added", leaving the design without it.
          if (photo && created?.id) {
            const id = created.id;
            void prepareQueryImage(photo).then((file) =>
              addImages.mutate(
                { id, files: [file] },
                {
                  onError: (err) =>
                    toast.error(apiErrorMessage(err, "Product added, but the photo upload failed.")),
                },
              ),
            );
          }
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not add product.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add {productNoun.toLowerCase()}</DialogTitle>
          <DialogDescription>
            New {productNounPlural.toLowerCase()} are added to {storeLabel}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

          {/* Photo up-front — add it now or alongside the details, not only after saving. */}
          <div className="grid gap-1.5">
            <Label>Photo</Label>
            <button
              type="button"
              onClick={() => photoRef.current?.click()}
              className="flex aspect-[16/9] items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/40 transition-colors hover:border-primary/50"
            >
              {photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoUrl} alt="Selected product" className="h-full w-full object-cover" />
              ) : (
                <span className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
                  <ImagePlus className="h-6 w-6" />
                  Add a photo (optional)
                </span>
              )}
            </button>
            <input
              ref={photoRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => pickPhoto(e.target.files?.[0] ?? null)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="sku">
              SKU <span className="text-destructive">*</span>
            </Label>
            <Input
              id="sku"
              // A jeweller's SKU pattern means nothing to a pharmacist. Eclat
              // keeps its exact example; everyone else gets a neutral one.
              placeholder={showsMetal ? "e.g. NK-TEMPLE-22" : "e.g. SKU-0001"}
              value={sku}
              aria-invalid={!!errors.sku}
              onChange={(e) => {
                setSku(e.target.value);
                clearError("sku");
              }}
            />
            {errors.sku ? (
              <p className="mt-1 text-xs text-destructive">{errors.sku}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="name"
              placeholder={
                showsMetal
                  ? "e.g. Lakshmi Temple Necklace Set"
                  : `e.g. your ${productNoun.toLowerCase()} name`
              }
              value={name}
              aria-invalid={!!errors.name}
              onChange={(e) => {
                setName(e.target.value);
                clearError("name");
              }}
            />
            {errors.name ? (
              <p className="mt-1 text-xs text-destructive">{errors.name}</p>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Category</Label>
              {showsMetal ? (
                <Select
                  value={category}
                  onValueChange={(v) => setCategory(v as ProductCategory)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CATEGORY_LABELS).map(([id, label]) => (
                      <SelectItem key={id} value={id}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : categoryTerms.length ? (
                /* The tenant's OWN categories, from their configured vocabulary.
                   The typed column stays `other`; the chosen word is stored
                   beside it, so the list a pharmacy sees is the list a pharmacy
                   made. */
                <Select value={categoryLabel} onValueChange={setCategoryLabel}>
                  <SelectTrigger>
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryTerms.map((term) => (
                      <SelectItem key={term.id} value={term.label}>
                        {term.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={categoryLabel}
                  placeholder="e.g. Tablets"
                  onChange={(e) => setCategoryLabel(e.target.value)}
                />
              )}
            </div>
            {showsMetal ? (
              <div className="grid gap-1.5">
                <Label>Metal</Label>
                <Select value={metal} onValueChange={(v) => setMetal(v as Metal)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Metal" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(METAL_LABELS)
                      // `unspecified` is the neutral value other industries
                      // store; it is not a metal a jeweller ever picks.
                      .filter(([id]) => id !== "unspecified")
                      .map(([id, label]) => (
                        <SelectItem key={id} value={id}>
                          {label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="uom">Sold in</Label>
                <Input
                  id="uom"
                  placeholder="e.g. strip, box, metre"
                  value={unitOfMeasure}
                  onChange={(e) => setUnitOfMeasure(e.target.value)}
                />
              </div>
            )}
          </div>
          <div className={showsKarat || showsWeight ? "grid grid-cols-3 gap-3" : "grid gap-3"}>
            {showsKarat ? (
            <div className="grid gap-1.5">
              <Label htmlFor="karat">Karat</Label>
              <Input
                id="karat"
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="22"
                value={karat}
                aria-invalid={!!errors.karat}
                onChange={(e) => {
                  setKarat(positiveNumberInput(e.target.value));
                  clearError("karat");
                }}
              />
              {errors.karat ? (
                <p className="mt-1 text-xs text-destructive">{errors.karat}</p>
              ) : null}
            </div>
            ) : null}
            {showsWeight ? (
            <div className="grid gap-1.5">
              <Label htmlFor="weight">Gross wt (g)</Label>
              <Input
                id="weight"
                type="number"
                inputMode="decimal"
                min={0}
                placeholder="62.4"
                value={weight}
                aria-invalid={!!errors.weight}
                onChange={(e) => {
                  setWeight(positiveNumberInput(e.target.value));
                  clearError("weight");
                }}
              />
              {errors.weight ? (
                <p className="mt-1 text-xs text-destructive">{errors.weight}</p>
              ) : null}
            </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="price">Price (₹)</Label>
              <Input
                id="price"
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="498000"
                value={price}
                aria-invalid={!!errors.price}
                onChange={(e) => {
                  setPrice(positiveNumberInput(e.target.value));
                  clearError("price");
                }}
              />
              {errors.price ? (
                <p className="mt-1 text-xs text-destructive">{errors.price}</p>
              ) : null}
            </div>
          </div>

          {/* Whatever this business has defined for itself, rendered from
              configuration. Nothing appears for a tenant that defined none. */}
          <CustomAttributeFields
            entity="product"
            values={attributes}
            onChange={setAttributes}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createProduct.isPending}>
            {createProduct.isPending ? "Saving…" : `Save ${productNoun.toLowerCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
