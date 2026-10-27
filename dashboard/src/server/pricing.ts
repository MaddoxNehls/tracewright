import type { PriceTable, PricingFile } from "@/lib/pricing";
// Ingest owns the price table. Importing the same file (bundled at build time) keeps
// seeded and rendered costs identical to what ingest computes.
import pricingFile from "../../../ingest/internal/pricing/pricing.json";

export const PRICES: PriceTable = (pricingFile as PricingFile).models;
