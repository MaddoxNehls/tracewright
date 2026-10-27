/**
 * LLM call pricing, using the same table and rules as ingest
 * (ingest/internal/pricing/pricing.json): USD per million tokens, an optional
 * long-context tier, and null for models the table doesn't list.
 */
export interface ModelPrice {
  input: number;
  output: number;
  long_context?: { above_input_tokens: number; input: number; output: number };
}

export type PriceTable = Record<string, ModelPrice>;

export interface PricingFile {
  as_of?: string;
  models: PriceTable;
}

/** Cost in USD, rounded to the 6 decimals `numeric(12,6)` stores, or null for an unknown model. */
export function priceCall(table: PriceTable, model: string, inputTokens: number, outputTokens: number): number | null {
  const price = table[model];
  if (!price) return null;
  const tier = price.long_context && inputTokens > price.long_context.above_input_tokens ? price.long_context : price;
  const usd = (inputTokens * tier.input + outputTokens * tier.output) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
