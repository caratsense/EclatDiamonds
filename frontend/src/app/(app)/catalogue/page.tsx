"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ImageSearch } from "@/components/catalogue/image-search";
import { ProductCard } from "@/components/catalogue/product-card";
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
import { useCreateProduct, useProducts } from "@/lib/queries/products";
import { useSession } from "@/store/use-session";

const nav = getNavItem("catalogue")!;

type CategoryFilter = ProductCategory | "all";
type MetalFilter = Metal | "all";
type AvailFilter = Availability | "all";
type StoreFilter = string; // store id or "all"

export default function CataloguePage() {
  const { currentStore, stores } = useSession();
  // Product index comes live + store-scoped from the API.
  const { data: allProducts = [], isLoading, isError, refetch } = useProducts();
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

  const products = useMemo(() => {
    return allProducts.filter((p) => {
      if (category !== "all" && p.category !== category) return false;
      if (metal !== "all" && p.metal !== metal) return false;
      if (avail !== "all" && p.availability !== avail) return false;
      if (store !== "all" && p.storeId !== store) return false;
      return true;
    });
  }, [allProducts, category, metal, avail, store]);

  function openProduct(p: Product) {
    setActive(p);
    setOpen(true);
  }

  const selectStores = stores.filter((s) => !s.isAggregate);

  return (
    <>
      <SectionHeader
        title={nav.title}
        purpose={nav.purpose}
        primaryAction={nav.primaryAction}
        onPrimaryAction={() => setAddOpen(true)}
      />

      <div className="mb-6">
        <ImageSearch onOpenProduct={openProduct} />
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-2">
        <Select
          value={category}
          onValueChange={(v) => setCategory(v as CategoryFilter)}
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

        <Select value={metal} onValueChange={(v) => setMetal(v as MetalFilter)}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Metal" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All metals</SelectItem>
            {Object.entries(METAL_LABELS).map(([id, label]) => (
              <SelectItem key={id} value={id}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={store} onValueChange={setStore}>
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

        <Select value={avail} onValueChange={(v) => setAvail(v as AvailFilter)}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Availability" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All availability</SelectItem>
            <SelectItem value="in_stock">In-Stock</SelectItem>
            <SelectItem value="lead_time">Lead-Time</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <p className="mb-3 text-sm text-muted-foreground">
        <span className="num">{products.length}</span>{" "}
        {products.length === 1 ? "piece" : "pieces"}
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
              No pieces match these filters. Adjust them or add a product.
            </p>
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
  const { currentStore } = useSession();
  const createProduct = useCreateProduct();
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<ProductCategory>("necklace");
  const [metal, setMetal] = useState<Metal>("gold_22k");
  const [karat, setKarat] = useState("");
  const [weight, setWeight] = useState("");
  const [price, setPrice] = useState("");

  // Aggregate ("all") scope has no concrete store to write to — fall back
  // to the first real store id; broad roles normally pick a store first.
  const targetStoreId = currentStore.isAggregate ? "surat-main" : currentStore.id;

  function reset() {
    setSku("");
    setName("");
    setCategory("necklace");
    setMetal("gold_22k");
    setKarat("");
    setWeight("");
    setPrice("");
  }

  function save() {
    if (!sku.trim()) {
      toast.error("SKU is required.");
      return;
    }
    if (!name.trim()) {
      toast.error("Product name is required.");
      return;
    }
    createProduct.mutate(
      {
        sku: sku.trim(),
        name: name.trim(),
        category,
        metal,
        karat: karat.trim() ? Number(karat) : undefined,
        weightGrams: weight.trim() ? Number(weight) : undefined,
        price: price.trim() ? Number(price) : undefined,
        storeId: targetStoreId,
      },
      {
        onSuccess: () => {
          toast.success("Product added");
          reset();
          onOpenChange(false);
        },
        onError: () => toast.error("Could not add product."),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add product</DialogTitle>
          <DialogDescription>
            New products are added to{" "}
            {currentStore.isAggregate ? "Surat — Main" : currentStore.name}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="sku">SKU</Label>
            <Input
              id="sku"
              placeholder="e.g. NK-TEMPLE-22"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              placeholder="e.g. Lakshmi Temple Necklace Set"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Category</Label>
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
            </div>
            <div className="grid gap-1.5">
              <Label>Metal</Label>
              <Select value={metal} onValueChange={(v) => setMetal(v as Metal)}>
                <SelectTrigger>
                  <SelectValue placeholder="Metal" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(METAL_LABELS).map(([id, label]) => (
                    <SelectItem key={id} value={id}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="karat">Karat</Label>
              <Input
                id="karat"
                type="number"
                inputMode="numeric"
                placeholder="22"
                value={karat}
                onChange={(e) => setKarat(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="weight">Gross wt (g)</Label>
              <Input
                id="weight"
                type="number"
                inputMode="decimal"
                placeholder="62.4"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="price">Price (₹)</Label>
              <Input
                id="price"
                type="number"
                inputMode="numeric"
                placeholder="498000"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createProduct.isPending}>
            {createProduct.isPending ? "Saving…" : "Save product"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
