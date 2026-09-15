"use client";

import { useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
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
  type Availability,
  type Metal,
  type Product,
  type ProductCategory,
} from "@/lib/mock/catalogue";
import {
  useCreateProduct,
  useProducts,
  useUploadProductImage,
} from "@/lib/queries/products";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { apiErrorMessage, isRealName } from "@/lib/utils";

const nav = getNavItem("catalogue")!;

type CategoryFilter = ProductCategory | "all";
type MetalFilter = Metal | "all";
type AvailFilter = Availability | "all";
type StoreFilter = string; // store id or "all"

export default function CataloguePage() {
  const { currentStore, stores, role } = useSession();
  // The tenant's noun for a product — "Item" in a factory, "Article" in a
  // textile business, "Product" everywhere the industry has no opinion.
  const { data: pageConfig } = useConfigBootstrap();
  const productNoun = pageConfig?.lexicon?.product ?? "Product";
  const productNounPlural = pageConfig?.lexicon?.product_plural ?? "Products";
  // The jewellery category and metal filters mean nothing to a pack that hides
  // the metal field: a clinic's or mill's products are all "other" and unmetalled.
  const showsMetalFilters = useFieldVisible(pageConfig)("product", "metal");
  const [active, setActive] = useState<Product | null>(null);
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const [category, setCategory] = useState<CategoryFilter>("all");
  const [metal, setMetal] = useState<MetalFilter>("all");
  const [avail, setAvail] = useState<AvailFilter>("all");
  // Default store filter follows the active session store (unless aggregate).
  const [store, setStore] = useState<StoreFilter>(
    currentStore.isAggregate ? "all" : currentStore.id,
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);

  // Product index comes live + store-scoped from the API. Filters run
  // server-side so `total` reflects the filtered count; a filter change
  // always resets to page 1 (see the onValueChange handlers below).
  const { data, isLoading, isError, refetch } = useProducts({
    page,
    pageSize,
    category: category === "all" ? undefined : category,
    metal: metal === "all" ? undefined : metal,
    availability: avail === "all" ? undefined : avail,
    storeId: store === "all" ? undefined : store,
  });
  const products = data?.items ?? [];
  const total = data?.total ?? 0;

  // Facet snapshot — the metals / availabilities actually stocked in scope, so
  // the dropdowns only offer real choices (no empty "platinum" or "lead-time"
  // when the business carries none). Unfiltered by metal/availability on
  // purpose; category is kept so the facets track the browsed category.
  // ponytail: 200-row scan; a store with >200 designs could miss a rare facet.
  const { data: facetData } = useProducts({
    page: 1,
    pageSize: 200,
    category: category === "all" ? undefined : category,
    storeId: store === "all" ? undefined : store,
  });
  const facetRows = facetData?.items;
  const presentMetals = facetRows
    ? new Set(facetRows.map((p) => p.metal))
    : null;
  const presentAvail = facetRows
    ? new Set(facetRows.map((p) => p.availability))
    : null;
  // Fall back to all options until the snapshot loads, and always keep the
  // currently-selected value so an active filter never hides itself.
  const metalOptions = (Object.entries(METAL_LABELS) as [Metal, string][]).filter(
    ([id]) => !presentMetals || presentMetals.has(id) || metal === id,
  );

  function openProduct(p: Product) {
    setActive(p);
    setOpen(true);
  }

  const selectStores = stores.filter((s) => !s.isAggregate);

  // POST /products requires store_manager+; hide the CTA for salespeople.
  const canAddProduct = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  return (
    <>
      <SectionHeader
        title={nav.title}
        purpose={nav.purpose}
        primaryAction={canAddProduct ? nav.primaryAction : undefined}
        onPrimaryAction={() => setAddOpen(true)}
      />

      <div className="mb-6">
        <ImageSearch />
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-2">
        {showsMetalFilters ? (
          <>
            <Select
              value={category}
              onValueChange={(v) => {
                setCategory(v as CategoryFilter);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {Object.entries(CATEGORY_LABELS).map(([id, label]) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={metal}
              onValueChange={(v) => {
                setMetal(v as MetalFilter);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Metal" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All metals</SelectItem>
                {metalOptions.map(([id, label]) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        ) : null}

        <Select
          value={store}
          onValueChange={(v) => {
            setStore(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[170px]">
            <SelectValue placeholder="Store" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All stores</SelectItem>
            {selectStores.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={avail}
          onValueChange={(v) => {
            setAvail(v as AvailFilter);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Availability" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All availability</SelectItem>
            {!presentAvail || presentAvail.has("in_stock") || avail === "in_stock" ? (
              <SelectItem value="in_stock">In-Stock</SelectItem>
            ) : null}
            {!presentAvail || presentAvail.has("lead_time") || avail === "lead_time" ? (
              <SelectItem value="lead_time">Lead-Time</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      </div>

      <p className="mb-3 text-sm text-muted-foreground">
        <span className="num">{total}</span>{" "}
        {/* "piece" is a jeweller's noun. Everyone else counts products — or
            whatever their industry calls them, via the tenant lexicon. */}
        {total === 1 ? productNoun.toLowerCase() : productNounPlural.toLowerCase()}
      </p>

      {isError ? (
        <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
          <p className="text-sm font-medium">Couldn&apos;t load the catalogue.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The connection may have dropped. Check your network and try again.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {isLoading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-64 rounded-xl" />
                ))
              : products.map((p) => (
                  <ProductCard key={p.id} product={p} onOpen={openProduct} />
                ))}
          </div>

          {!isLoading && products.length === 0 ? (
            <p className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
              No {productNounPlural.toLowerCase()} match these filters. Adjust them or add one.
            </p>
          ) : null}

          {!isLoading && total > 0 ? (
            <PaginationBar
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          ) : null}
        </>
      )}

      <ProductDetailDialog product={active} open={open} onOpenChange={setOpen} />

      <AddProductDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
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
  const uploadImage = useUploadProductImage();
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
          // Photo picked up-front → upload it against the new product's id.
          if (photo && created?.id) {
            uploadImage.mutate(
              { id: created.id, file: photo },
              {
                onError: (err) =>
                  toast.error(apiErrorMessage(err, "Product added, but the photo upload failed.")),
              },
            );
          }
          toast.success("Product added");
          reset();
          onOpenChange(false);
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
                  setKarat(e.target.value);
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
                  setWeight(e.target.value);
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
                  setPrice(e.target.value);
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
