export interface SourceVariant {
  key: string;
  label?: string;
  priceCents: number;
}

export interface SourceProduct {
  id: string;
  name: string;
  description: string;
  variants: SourceVariant[];
  colors: string[];
}

export interface ResultItem {
  name: string;
  description: string;
  price: number;
  colors?: string[];
}

export interface Catalog {
  results: ResultItem[];
  total: number;
}

export type OutputFormat = "json" | "csv" | "tsv";

export interface Progress {
  phase: "discovering" | "scraping";
  pages: number;
  discoveredProducts: number;
  processedProducts: number;
  queued: number;
  active: number;
  retries: number;
}

export interface Completion {
  catalog: Catalog;
  output: string;
  format: OutputFormat;
  pretty: boolean;
  outputPath?: string;
  productCount: number;
  elapsedMs: number;
}
