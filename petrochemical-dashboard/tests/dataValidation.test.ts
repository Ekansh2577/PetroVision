import assert from "node:assert/strict";
import test from "node:test";
import {
  findMissingHeaders,
  latestMonthFromDates,
  monthFromIsoDate,
  parseNumericCell,
  rowsAfterMonth,
} from "../src/dataValidation.ts";
import { canonicalProducts } from "../src/productMapping.ts";
import { buildReplacementAggregateMetrics, buildReplacementForecastView } from "../src/replacementIntegration.ts";

test("numeric validation preserves valid zero and rejects blank or invalid values", () => {
  assert.equal(parseNumericCell("0"), 0);
  assert.equal(parseNumericCell(" 12.5 "), 12.5);
  assert.equal(parseNumericCell(""), null);
  assert.equal(parseNumericCell("unknown"), null);
  assert.equal(parseNumericCell(Number.NaN), null);
});

test("required header validation returns only absent columns", () => {
  assert.deepEqual(
    findMissingHeaders(["date", "actual_demand"], ["date", "product", "actual_demand"]),
    ["product"],
  );
});

test("ISO date parsing rejects impossible dates and extracts valid months", () => {
  assert.equal(monthFromIsoDate("2025-12-31"), "2025-12");
  assert.equal(monthFromIsoDate("2025-02-29"), null);
  assert.equal(monthFromIsoDate("2026-13-01"), null);
  assert.equal(monthFromIsoDate("not-a-date"), null);
});

test("future filtering excludes evaluation history and keeps only rows after cutoff", () => {
  const evaluationDates = ["2025-11-01", "2025-12-01", "invalid"];
  const cutoff = latestMonthFromDates(evaluationDates);
  const rows = [
    { date: "2011-09-01", value: 1 },
    { date: "2025-12-01", value: 2 },
    { date: "2026-01-01", value: 3 },
    { date: "2026-06-01", value: 4 },
    { date: "2026-06-31", value: 5 },
  ];
  assert.equal(cutoff, "2025-12");
  assert.deepEqual(rowsAfterMonth(rows, cutoff, (row) => row.date), [rows[2], rows[3]]);
  assert.deepEqual(rowsAfterMonth(rows, null, (row) => row.date), []);
});

function replacementForecastRows() {
  const months = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"];
  return months.flatMap((date, index) => canonicalProducts.map((product, productIndex) => ({
    As_Of_Date: "2025-12-01",
    Date: date,
    Horizon_Month: String(index + 1),
    Product: product,
    Canonical_Product: product,
    Naive_Prediction_Tonnes: String(100 + productIndex),
    Random_Forest_Prediction_Tonnes: String(110 + productIndex),
    Synthetic_Data_Label: "SYNTHETIC_DEMO_ONLY_NOT_MARKET_FORECAST",
  })));
}

test("replacement future integration validates canonical coverage and six-month date boundary", () => {
  const view = buildReplacementForecastView(replacementForecastRows());
  assert.equal(view.asOfDate, "2025-12-01");
  assert.equal(view.horizonMonths, 6);
  assert.deepEqual(view.chart.map((point) => point.label), ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
  assert.equal(view.chart[0].products, 10);
  assert.equal(view.chart[0].naive, 104.5);
  assert.equal(view.chart[0].forest, 114.5);
});

test("replacement future integration rejects historical, duplicate, missing, and mismapped rows", () => {
  const historical = replacementForecastRows();
  historical[0] = { ...historical[0], Date: "2025-12-01", Horizon_Month: "0" };
  assert.throws(() => buildReplacementForecastView(historical), /months 1–6/);
  const duplicate = replacementForecastRows();
  duplicate[1] = { ...duplicate[1], Product: duplicate[0].Product, Canonical_Product: duplicate[0].Canonical_Product };
  assert.throws(() => buildReplacementForecastView(duplicate), /Duplicate/);
  const missing = replacementForecastRows();
  missing[0] = { ...missing[0], Naive_Prediction_Tonnes: "" };
  assert.throws(() => buildReplacementForecastView(missing), /missing, invalid/);
  const mismapped = replacementForecastRows();
  mismapped[0] = { ...mismapped[0], Canonical_Product: "OTHER" };
  assert.throws(() => buildReplacementForecastView(mismapped), /unmapped\/mismatched/);
});

test("replacement metric integration requires both models to share eligible samples", () => {
  const rows = ["2025-01", "2025-07", "ALL_FOLDS"].flatMap((Fold) => [
    { Fold, Model: "Naive_Last_Observed", Product: "ALL", Sample_Count: "59", MAE: "2", RMSE: "3", R2: "0.8" },
    { Fold, Model: "Random_Forest_Recursive", Product: "ALL", Sample_Count: "59", MAE: "1", RMSE: "4", R2: "0.7" },
  ]);
  assert.equal(buildReplacementAggregateMetrics(rows).length, 6);
  assert.throws(() => buildReplacementAggregateMetrics(rows.map((row) => row.Fold === "2025-07" && row.Model === "Random_Forest_Recursive" ? { ...row, Sample_Count: "58" } : row)), /identical eligible sample counts/);
  assert.throws(() => buildReplacementAggregateMetrics(rows.slice(1)), /two models/);
});
