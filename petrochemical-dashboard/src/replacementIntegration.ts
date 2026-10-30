import { canonicalProduct, canonicalProducts } from "./productMapping.ts";
import { monthFromIsoDate, parseNumericCell } from "./dataValidation.ts";

export type ReplacementForecastRow = Record<string, string>;
export type ReplacementMetricRow = {
  Fold: string;
  Model: string;
  Product: string;
  Sample_Count: number;
  MAE: number;
  RMSE: number;
  R2: number | null;
};
export type ReplacementForecastPoint = {
  label: string;
  naive: number;
  forest: number;
  products: number;
};
export type ReplacementForecastView = {
  asOfDate: string;
  horizonMonths: number;
  chart: ReplacementForecastPoint[];
};

const modelNames = ["Naive_Last_Observed", "Random_Forest_Recursive"] as const;
const monthIndex = (month: string) => {
  const [year, monthNumber] = month.split("-").map(Number);
  return year * 12 + monthNumber - 1;
};

export function buildReplacementForecastView(rows: ReplacementForecastRow[]): ReplacementForecastView {
  if (!rows.length) throw new Error("Replacement future forecast is empty.");
  const asOfDates = new Set(rows.map((row) => row.As_Of_Date));
  if (asOfDates.size !== 1 || !monthFromIsoDate(rows[0].As_Of_Date) || !rows[0].As_Of_Date.endsWith("-01")) {
    throw new Error("Replacement forecast must have one valid first-of-month as-of date.");
  }
  const asOfDate = rows[0].As_Of_Date;
  const asOfMonth = monthFromIsoDate(asOfDate)!;
  const byDate = new Map<string, { naive: number; forest: number; products: Set<string> }>();
  const keys = new Set<string>();

  for (const row of rows) {
    const targetMonth = monthFromIsoDate(row.Date);
    const step = parseNumericCell(row.Horizon_Month);
    const family = canonicalProduct(row.Product ?? "");
    if (!targetMonth || !row.Date.endsWith("-01") || !family || family !== row.Canonical_Product) {
      throw new Error("Replacement forecast contains an invalid date or unmapped/mismatched product.");
    }
    if (row.Synthetic_Data_Label !== "SYNTHETIC_DEMO_ONLY_NOT_MARKET_FORECAST") {
      throw new Error("Replacement forecast is missing its synthetic demonstration label.");
    }
    const distance = monthIndex(targetMonth) - monthIndex(asOfMonth);
    if (step === null || step !== distance || step < 1 || step > 6) {
      throw new Error("Replacement forecast dates must cover forecast months 1–6 after the as-of month.");
    }
    const key = `${targetMonth}:${family}`;
    if (keys.has(key)) throw new Error(`Duplicate replacement forecast row for ${targetMonth}/${family}.`);
    keys.add(key);
    const naive = parseNumericCell(row.Naive_Prediction_Tonnes);
    const forest = parseNumericCell(row.Random_Forest_Prediction_Tonnes);
    if (naive === null || forest === null || naive < 0 || forest < 0) {
      throw new Error("Replacement forecast contains missing, invalid, or negative predictions.");
    }
    const group = byDate.get(targetMonth) ?? { naive: 0, forest: 0, products: new Set<string>() };
    group.naive += naive;
    group.forest += forest;
    group.products.add(family);
    byDate.set(targetMonth, group);
  }

  if (byDate.size !== 6 || canonicalProducts.length !== 10) {
    throw new Error("Replacement forecast must contain exactly six months across the reviewed ten-product set.");
  }
  const chart = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, values], index) => {
    if (values.products.size !== canonicalProducts.length || canonicalProducts.some((product) => !values.products.has(product))) {
      throw new Error(`Replacement forecast product coverage is incomplete for ${date}.`);
    }
    if (monthIndex(date) - monthIndex(asOfMonth) !== index + 1) {
      throw new Error("Replacement forecast months must be contiguous from the as-of date.");
    }
    return { label: date, naive: values.naive / values.products.size, forest: values.forest / values.products.size, products: values.products.size };
  });
  return { asOfDate, horizonMonths: chart.length, chart };
}

export function buildReplacementAggregateMetrics(rows: Record<string, string>[]): ReplacementMetricRow[] {
  const folds = ["2025-01", "2025-07", "ALL_FOLDS"];
  const selected = rows.filter((row) => folds.includes(row.Fold) && row.Product === "ALL");
  if (selected.length !== 6) throw new Error("Replacement aggregate metrics must contain two models for each evaluation fold.");
  const seen = new Set<string>();
  const result = selected.map((row) => {
    if (!(modelNames as readonly string[]).includes(row.Model)) throw new Error(`Unknown replacement model: ${row.Model}`);
    const key = `${row.Fold}:${row.Model}`;
    if (seen.has(key)) throw new Error(`Duplicate replacement aggregate metric: ${key}`);
    seen.add(key);
    const count = parseNumericCell(row.Sample_Count);
    const mae = parseNumericCell(row.MAE);
    const rmse = parseNumericCell(row.RMSE);
    const r2 = row.R2 === "" ? null : parseNumericCell(row.R2);
    if (count === null || count < 1 || mae === null || rmse === null || r2 === null && row.R2 !== "") {
      throw new Error(`Replacement aggregate metric contains an invalid value: ${key}`);
    }
    return { Fold: row.Fold, Model: row.Model, Product: row.Product, Sample_Count: count, MAE: mae, RMSE: rmse, R2: r2 };
  });
  for (const fold of folds) {
    const pair = result.filter((row) => row.Fold === fold);
    if (pair.length !== 2 || pair[0].Sample_Count !== pair[1].Sample_Count) {
      throw new Error(`Replacement models do not have identical eligible sample counts for ${fold}.`);
    }
  }
  return result.sort((a, b) => folds.indexOf(a.Fold) - folds.indexOf(b.Fold) || modelNames.indexOf(a.Model as typeof modelNames[number]) - modelNames.indexOf(b.Model as typeof modelNames[number]));
}
