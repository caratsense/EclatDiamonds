// ============================================================================
// Seed Rich Raw Catalogue Data Across All Categories with Real Photos & ML Embeddings
// ============================================================================
import { PrismaClient } from "@prisma/client";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";

const prisma = new PrismaClient();
/*
 * Local only. This script writes across every organisation in the database, so
 * the same command pointed at a live one would push demo catalogue rows into
 * real tenants. The connection has to be on this machine.
 */
const dbHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
})();
if (!['localhost', '127.0.0.1', '::1'].includes(dbHost)) {
  console.error(
    `Refusing to run against ${dbHost || 'an unreadable DATABASE_URL'}: this script is local-only.`,
  );
  process.exit(2);
}
const UPLOAD_DIR = join(process.cwd(), "uploads", "products");
const ML_URL = process.env.ML_INFERENCE_URL || "http://127.0.0.1:8000";

// High quality curated jewellery photos from Unsplash for realistic visual appearance
const CATEGORY_IMAGES = {
  necklace: [
    "https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1611591475878-31e9c20a4005?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1602751584552-8ba73aad10e1?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1506630448388-4e683c67ddb0?w=600&auto=format&fit=crop&q=80",
  ],
  ring: [
    "https://images.unsplash.com/photo-1605100804763-247f67b3557e?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1603561591411-07134e71a2a9?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1603561596112-0a132b757442?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1598560917505-59a3ad559071?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1589674781759-c21c37956a44?w=600&auto=format&fit=crop&q=80",
  ],
  earrings: [
    "https://images.unsplash.com/photo-1635767798638-3e25273a8236?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1630019852942-f89202989a59?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1617038260897-41a1f14a8ca0?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1579783902614-a3fb3927b675?w=600&auto=format&fit=crop&q=80",
  ],
  bangle: [
    "https://images.unsplash.com/photo-1611591475878-31e9c20a4005?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1602751584552-8ba73aad10e1?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1605100804763-247f67b3557e?w=600&auto=format&fit=crop&q=80",
  ],
  bracelet: [
    "https://images.unsplash.com/photo-1611591475878-31e9c20a4005?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1573408301185-9146fe634ad0?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1602751584552-8ba73aad10e1?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=600&auto=format&fit=crop&q=80",
  ],
  pendant: [
    "https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1605100804763-247f67b3557e?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1603561591411-07134e71a2a9?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1611591475878-31e9c20a4005?w=600&auto=format&fit=crop&q=80",
  ],
  chain: [
    "https://images.unsplash.com/photo-1506630448388-4e683c67ddb0?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1602751584552-8ba73aad10e1?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1611591475878-31e9c20a4005?w=600&auto=format&fit=crop&q=80",
  ],
  other: [
    "https://images.unsplash.com/photo-1602751584552-8ba73aad10e1?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1605100804763-247f67b3557e?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1611591475878-31e9c20a4005?w=600&auto=format&fit=crop&q=80",
  ],
};

const PRODUCTS_DATA = [
  // ── Necklace (5 items)
  {
    sku: "NECK-001",
    name: "Lakshmi Temple Haar",
    category: "necklace",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 58.4,
    caratWeight: 0,
    price: 485000,
    availability: "in_stock",
    bestSeller: true,
    description: "Handcrafted temple haar featuring Goddess Lakshmi motif in antique 22K finish with cluster rubies.",
  },
  {
    sku: "NECK-002",
    name: "Royal Kundan Polki Choker",
    category: "necklace",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 72.5,
    caratWeight: 8.5,
    price: 620000,
    availability: "in_stock",
    bestSeller: true,
    description: "Bridal choker set with uncut syndicate polki diamonds and emerald bead drops.",
  },
  {
    sku: "NECK-003",
    name: "Cascading Diamond Collar",
    category: "necklace",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 35.2,
    caratWeight: 4.5,
    price: 540000,
    availability: "in_stock",
    bestSeller: false,
    description: "Contemporary 18K white gold collar set with VVS-EF brilliant-cut round diamonds.",
  },
  {
    sku: "NECK-004",
    name: "Minimalist Floral Gold Choker",
    category: "necklace",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 24.8,
    caratWeight: 0,
    price: 215000,
    availability: "in_stock",
    bestSeller: false,
    description: "Lightweight 22K yellow gold floral choker, ideal for festive celebrations and gifting.",
  },
  {
    sku: "NECK-005",
    name: "South Indian Mango Mala",
    category: "necklace",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 42.6,
    caratWeight: 0,
    price: 365000,
    availability: "in_stock",
    bestSeller: false,
    description: "Heritage Manga Malai featuring traditional paisley motifs in high-polish 22K yellow gold.",
  },

  // ── Ring (5 items)
  {
    sku: "RING-001",
    name: "Aurora Solitaire Diamond Ring",
    category: "ring",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 4.5,
    caratWeight: 1.25,
    price: 325000,
    availability: "in_stock",
    bestSeller: true,
    description: "Certified 1.25ct IGI round brilliant solitaire set in an 18K white gold six-prong cathedral ring.",
  },
  {
    sku: "RING-002",
    name: "Princess Cut Halo Diamond Ring",
    category: "ring",
    metal: "platinum",
    karat: 0,
    weightGrams: 6.2,
    caratWeight: 0.95,
    price: 275000,
    availability: "in_stock",
    bestSeller: false,
    description: "Platinum 950 engagement ring with a princess-cut center stone encircled by a micro-pavé halo.",
  },
  {
    sku: "RING-003",
    name: "Vintage Emerald Cocktail Ring",
    category: "ring",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 7.8,
    caratWeight: 4.2,
    price: 195000,
    availability: "in_stock",
    bestSeller: false,
    description: "Natural Colombian emerald center with baguette diamond side accents in 18K yellow gold.",
  },
  {
    sku: "RING-004",
    name: "Infinity Pavé Eternity Band",
    category: "ring",
    metal: "rose_gold_18k",
    karat: 18,
    weightGrams: 3.8,
    caratWeight: 1.1,
    price: 145000,
    availability: "in_stock",
    bestSeller: true,
    description: "Continuous full eternity band in 18K rose gold set with sparkling brilliant cut diamonds.",
  },
  {
    sku: "RING-005",
    name: "Navratna Astrological Ring",
    category: "ring",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 8.5,
    caratWeight: 2.1,
    price: 88000,
    availability: "in_stock",
    bestSeller: false,
    description: "Traditional nine-gemstone Navratna ring crafted in auspicious 22K hallmarked gold.",
  },

  // ── Earrings (5 items)
  {
    sku: "EAR-001",
    name: "Chandbali Royal Jhumka Earrings",
    category: "earrings",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 28.6,
    caratWeight: 0,
    price: 245000,
    availability: "in_stock",
    bestSeller: true,
    description: "Exquisite layered crescent chandbali jhumkas with hanging gold bead fringes and filigree details.",
  },
  {
    sku: "EAR-002",
    name: "Solitaire Diamond Studs (1.5 ct)",
    category: "earrings",
    metal: "platinum",
    karat: 0,
    weightGrams: 3.4,
    caratWeight: 1.5,
    price: 290000,
    availability: "in_stock",
    bestSeller: true,
    description: "Timeless 1.5ct total weight diamond studs set in pure Platinum 950 screw-back mountings.",
  },
  {
    sku: "EAR-003",
    name: "South Sea Pearl & Diamond Drops",
    category: "earrings",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 12.4,
    caratWeight: 1.2,
    price: 175000,
    availability: "in_stock",
    bestSeller: false,
    description: "Lustrous white Australian South Sea pearls suspended from diamond-encrusted 18K gold hooks.",
  },
  {
    sku: "EAR-004",
    name: "Peacock Sui Dhaga Long Earrings",
    category: "earrings",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 14.2,
    caratWeight: 0,
    price: 122000,
    availability: "in_stock",
    bestSeller: false,
    description: "Graceful threader earrings with enamelled peacock studs and textured gold link drops.",
  },
  {
    sku: "EAR-005",
    name: "Classic Diamond Huggies",
    category: "earrings",
    metal: "rose_gold_18k",
    karat: 18,
    weightGrams: 6.8,
    caratWeight: 0.65,
    price: 85000,
    availability: "in_stock",
    bestSeller: false,
    description: "Comfortable everyday 18K rose gold huggie hoop earrings paved with micro diamonds.",
  },

  // ── Bangle (5 items)
  {
    sku: "BAN-001",
    name: "Heritage Gokhru Temple Kadas (Pair)",
    category: "bangle",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 65.0,
    caratWeight: 0,
    price: 560000,
    availability: "in_stock",
    bestSeller: true,
    description: "Pair of heavy traditional Gujarati Gokhru spike bangles in antique finished 22K yellow gold.",
  },
  {
    sku: "BAN-002",
    name: "Calcutta Filigree Openable Kada",
    category: "bangle",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 38.5,
    caratWeight: 0,
    price: 330000,
    availability: "in_stock",
    bestSeller: false,
    description: "Intricate handcrafted wire filigree single kada with concealed screw clasp mechanism.",
  },
  {
    sku: "BAN-003",
    name: "Four-Row Diamond Tennis Bangle",
    category: "bangle",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 28.0,
    caratWeight: 2.8,
    price: 380000,
    availability: "in_stock",
    bestSeller: true,
    description: "Four rows of channel-set diamonds set in gleaming 18K white gold with security safety catch.",
  },
  {
    sku: "BAN-004",
    name: "Rose Gold Floral Cutwork Bangles",
    category: "bangle",
    metal: "rose_gold_18k",
    karat: 18,
    weightGrams: 32.0,
    caratWeight: 0.8,
    price: 275000,
    availability: "in_stock",
    bestSeller: false,
    description: "Pair of laser-cut floral filigree bangles highlighted with scattered natural diamonds.",
  },
  {
    sku: "BAN-005",
    name: "Antique Lion-Head Singham Kada",
    category: "bangle",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 52.0,
    caratWeight: 0,
    price: 450000,
    availability: "in_stock",
    bestSeller: false,
    description: "Iconic men's statement kada featuring twin lion head finials with ruby gemstone eyes.",
  },

  // ── Bracelet (5 items)
  {
    sku: "BRAC-001",
    name: "Classic Diamond Tennis Bracelet",
    category: "bracelet",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 15.6,
    caratWeight: 3.5,
    price: 420000,
    availability: "in_stock",
    bestSeller: true,
    description: "Single-line tennis bracelet set with 52 matching round brilliant diamonds (3.5ct total) in 18K white gold.",
  },
  {
    sku: "BRAC-002",
    name: "Italian Mesh Gold Charm Bracelet",
    category: "bracelet",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 18.5,
    caratWeight: 0,
    price: 165000,
    availability: "in_stock",
    bestSeller: false,
    description: "Flexible woven gold mesh strap bracelet with interchangeable Italian dangling charms.",
  },
  {
    sku: "BRAC-003",
    name: "Heavy Cuban Link Curb Bracelet",
    category: "bracelet",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 48.0,
    caratWeight: 0,
    price: 415000,
    availability: "in_stock",
    bestSeller: true,
    description: "Substantial 10mm men's Cuban link curb chain bracelet with diamond-cut bevelled edges.",
  },
  {
    sku: "BRAC-004",
    name: "Sleek Platinum Bezel Bar Bracelet",
    category: "bracelet",
    metal: "platinum",
    karat: 0,
    weightGrams: 16.2,
    caratWeight: 0.75,
    price: 140000,
    availability: "in_stock",
    bestSeller: false,
    description: "Modern minimalist platinum link chain bracelet featuring seven bezel-set diamonds.",
  },
  {
    sku: "BRAC-005",
    name: "Diamond Evil Eye Station Bracelet",
    category: "bracelet",
    metal: "rose_gold_18k",
    karat: 18,
    weightGrams: 8.4,
    caratWeight: 0.4,
    price: 78000,
    availability: "in_stock",
    bestSeller: false,
    description: "Protective evil eye talisman set with blue sapphires and white diamonds on an 18K rose gold chain.",
  },

  // ── Pendant (5 items)
  {
    sku: "PEND-001",
    name: "Solitaire Teardrop Diamond Pendant",
    category: "pendant",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 3.2,
    caratWeight: 1.1,
    price: 265000,
    availability: "in_stock",
    bestSeller: true,
    description: "Pear-shaped 1.10ct solitaire diamond pendant set in an elegant 18K white gold V-bale.",
  },
  {
    sku: "PEND-002",
    name: "Lord Ganesha Embossed Gold Pendant",
    category: "pendant",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 12.8,
    caratWeight: 0,
    price: 112000,
    availability: "in_stock",
    bestSeller: true,
    description: "Auspicious 22K yellow gold pendant depicting Lord Ganesha in divine blessing posture.",
  },
  {
    sku: "PEND-003",
    name: "Zambian Emerald Halo Locket",
    category: "pendant",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 6.5,
    caratWeight: 3.2,
    price: 185000,
    availability: "in_stock",
    bestSeller: false,
    description: "Oval cushion Zambian natural emerald (3.2ct) framed by a sparkling diamond micro-halo.",
  },
  {
    sku: "PEND-004",
    name: "Diamond Om Spiritual Locket",
    category: "pendant",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 9.4,
    caratWeight: 0.45,
    price: 89000,
    availability: "in_stock",
    bestSeller: false,
    description: "Sacred Om symbol pendant in 22K gold accented with pave diamonds along the curves.",
  },
  {
    sku: "PEND-005",
    name: "Blue Sapphire Royal Pendant",
    category: "pendant",
    metal: "platinum",
    karat: 0,
    weightGrams: 5.8,
    caratWeight: 2.5,
    price: 220000,
    availability: "in_stock",
    bestSeller: false,
    description: "Ceylon royal blue sapphire surrounded by tapered baguette diamonds in Platinum 950.",
  },

  // ── Chain (5 items)
  {
    sku: "CH-001",
    name: "Traditional 22K Gold Rope Chain (32g)",
    category: "chain",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 32.0,
    caratWeight: 0,
    price: 275000,
    availability: "in_stock",
    bestSeller: true,
    description: "24-inch diamond-cut hollow rope chain in 22K hallmarked yellow gold with lobster lock.",
  },
  {
    sku: "CH-002",
    name: "Solid Figaro Men's Gold Chain (45.5g)",
    category: "chain",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 45.5,
    caratWeight: 0,
    price: 395000,
    availability: "in_stock",
    bestSeller: true,
    description: "Classic 3+1 Italian Figaro pattern solid gold chain in heavy 22K purity (6mm width).",
  },
  {
    sku: "CH-003",
    name: "Italian Box Link Platinum Chain",
    category: "chain",
    metal: "platinum",
    karat: 0,
    weightGrams: 22.0,
    caratWeight: 0,
    price: 185000,
    availability: "in_stock",
    bestSeller: false,
    description: "High-density square box link chain in mirror-polished Platinum 950 (20 inches).",
  },
  {
    sku: "CH-004",
    name: "Foxtail Wheat Link Gold Chain",
    category: "chain",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 26.4,
    caratWeight: 0,
    price: 210000,
    availability: "in_stock",
    bestSeller: false,
    description: "Supple circular wheat grain weave chain in 18K yellow gold with high tensile strength.",
  },
  {
    sku: "CH-005",
    name: "Singapore Twister Rose Gold Chain",
    category: "chain",
    metal: "rose_gold_18k",
    karat: 18,
    weightGrams: 10.2,
    caratWeight: 0,
    price: 88000,
    availability: "in_stock",
    bestSeller: false,
    description: "Sparkling twisted Singapore chain that catches the light from every angle in 18K rose gold.",
  },

  // ── Other (5 items)
  {
    sku: "OTH-001",
    name: "Traditional Gold Mangalsutra (26.5g)",
    category: "other",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 26.5,
    caratWeight: 0.5,
    price: 230000,
    availability: "in_stock",
    bestSeller: true,
    description: "Auspicious double-strand black bead chain with 22K floral gold vathi pendant and diamond accents.",
  },
  {
    sku: "OTH-002",
    name: "Royal Temple Kamarbandh / Waistband",
    category: "other",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 95.0,
    caratWeight: 0,
    price: 815000,
    availability: "in_stock",
    bestSeller: false,
    description: "Grand bridal waist belt with carved temple dancers and hanging jhumka bell tassels in 22K gold.",
  },
  {
    sku: "OTH-003",
    name: "Pure Silver 999 Pooja Coin Set (100g)",
    category: "other",
    metal: "silver",
    karat: 0,
    weightGrams: 100.0,
    caratWeight: 0,
    price: 12500,
    availability: "in_stock",
    bestSeller: true,
    description: "Govt hallmarked 99.9% fine silver coins embossed with Lakshmi-Ganesh for Diwali and Dhanteras.",
  },
  {
    sku: "OTH-004",
    name: "Peacock Diamond Brooch Pin",
    category: "other",
    metal: "gold_18k",
    karat: 18,
    weightGrams: 14.8,
    caratWeight: 1.2,
    price: 165000,
    availability: "in_stock",
    bestSeller: false,
    description: "Artisan brooch pin featuring royal blue enamel feathers and rose-cut diamonds.",
  },
  {
    sku: "OTH-005",
    name: "Bridal Matha Patti / Maang Tikka",
    category: "other",
    metal: "gold_22k",
    karat: 22,
    weightGrams: 21.0,
    caratWeight: 0,
    price: 182000,
    availability: "in_stock",
    bestSeller: false,
    description: "Headpiece with side pearl matha patti chains and central kundan-studded tikka drop.",
  },
];

async function run() {
  console.log("=== Seeding Rich Raw Data & Photos Across All 8 Categories ===");
  await mkdir(UPLOAD_DIR, { recursive: true });

  const org = await prisma.organisation.findFirst();
  if (!org) {
    throw new Error("No organisation found in database");
  }
  const orgId = org.id;

  const store = await prisma.store.findFirst({
    where: { organisationId: orgId, isAggregate: false },
  });
  const storeId = store?.id || null;

  console.log(`Target organisation: ${orgId} (${org.name}), Store: ${storeId || "company-wide"}`);

  // 1. Download / generate real image buffers for each category
  const imageBuffers = {};
  for (const [cat, urls] of Object.entries(CATEGORY_IMAGES)) {
    imageBuffers[cat] = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          imageBuffers[cat].push(buf);
        }
      } catch (err) {
        console.warn(`Could not download image for ${cat} #${i}: ${err.message}`);
      }
    }
    console.log(`  ${cat}: ${imageBuffers[cat].length} photos ready`);
  }

  // Fallback 1x1 buffer or solid image if any category failed
  const fallbackBuffer = Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
    "base64"
  );

  let createdCount = 0;
  let updatedCount = 0;
  let embeddedCount = 0;

  for (let i = 0; i < PRODUCTS_DATA.length; i++) {
    const item = PRODUCTS_DATA[i];
    const catBuffers = imageBuffers[item.category] || [];
    const buf = catBuffers[i % catBuffers.length] || fallbackBuffer;

    // Save image to uploads/products/<sku>.jpg
    const fileName = `${item.sku.toLowerCase()}.jpg`;
    const filePath = join(UPLOAD_DIR, fileName);
    await writeFile(filePath, buf);
    const imageUrl = `/uploads/products/${fileName}`;

    // Upsert Product row
    const existing = await prisma.product.findFirst({
      where: { organisationId: orgId, sku: item.sku },
    });

    let product;
    if (existing) {
      product = await prisma.product.update({
        where: { id: existing.id },
        data: {
          name: item.name,
          category: item.category,
          metal: item.metal,
          karat: item.karat,
          weightGrams: item.weightGrams,
          caratWeight: item.caratWeight,
          price: item.price,
          imageUrl,
          availability: item.availability,
          bestSeller: item.bestSeller,
          description: item.description,
          storeId,
        },
      });
      updatedCount++;
    } else {
      product = await prisma.product.create({
        data: {
          organisationId: orgId,
          sku: item.sku,
          name: item.name,
          category: item.category,
          metal: item.metal,
          karat: item.karat,
          weightGrams: item.weightGrams,
          caratWeight: item.caratWeight,
          price: item.price,
          imageUrl,
          availability: item.availability,
          bestSeller: item.bestSeller,
          description: item.description,
          storeId,
          embedding: [],
        },
      });
      createdCount++;
    }

    // 2. Compute AI embedding via DINOv2 + SigLIP 2 on port 8000
    try {
      const mlRes = await fetch(`${ML_URL}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image_b64: buf.toString("base64"),
          mime: "image/jpeg",
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (mlRes.ok) {
        const data = await mlRes.json();
        const dino = data.dino || [];
        const siglip = data.siglip || [];
        const hash = createHash("sha256").update(buf).digest("hex");

        if (dino.length && siglip.length) {
          // Update Product.embedding
          await prisma.product.update({
            where: { id: product.id },
            data: { embedding: dino },
          });

          // Upsert ProductEmbedding
          await prisma.productEmbedding.upsert({
            where: {
              productId_preprocessingVersion: {
                productId: product.id,
                preprocessingVersion: "1",
              },
            },
            create: {
              organisationId: orgId,
              productId: product.id,
              storeId,
              dinoEmbedding: dino,
              siglipEmbedding: siglip,
              dinoModelVersion: "facebook/dinov2-base",
              siglipModelVersion: "google/siglip2-base-patch16-224",
              preprocessingVersion: "1",
              imageHash: hash,
            },
            update: {
              dinoEmbedding: dino,
              siglipEmbedding: siglip,
              imageHash: hash,
            },
          });
          embeddedCount++;
        }
      }
    } catch (err) {
      console.warn(`  ML embedding failed for ${item.sku}: ${err.message}`);
    }

    process.stdout.write(`\rProcessed [${i + 1}/${PRODUCTS_DATA.length}] ${item.sku} (${item.category})`);
  }

  console.log(`\n\n=== Seeding Completed Successfully ===`);
  console.log(`Created products: ${createdCount}`);
  console.log(`Updated products: ${updatedCount}`);
  console.log(`AI ML Embeddings computed: ${embeddedCount}/${PRODUCTS_DATA.length}`);
}

run()
  .catch((err) => {
    console.error("Seeding failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
