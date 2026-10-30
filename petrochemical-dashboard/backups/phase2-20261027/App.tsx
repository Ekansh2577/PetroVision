import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import {
  Activity, BarChart3, Boxes, Download, Factory, LayoutDashboard,
  Menu, Search, TrendingUp, X,
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { canonicalProduct } from "./productMapping";
import "./App.css";

type Page = "Overview" | "Demand Forecast" | "Pricing Strategy" | "Products" | "Model Performance";
type Row = Record<string, string>;
type Product = {
  name: string;
  demand: number | null;
  price: number | null;
  competitorPrice: number | null;
  recommendedPrice: number | null;
  change: number | null;
  forecast: number | null;
};
type Metric = { Model: string; MAE: number | null; RMSE: number | null; "R2 Score": number | null };
type PriceRecommendation = {
  product: string;
  canonical: string | null;
  current: number | null;
  competitor: number | null;
  recommended: number | null;
  change: number | null;
  status: string;
};

const nav: { label: Page; icon: typeof LayoutDashboard }[] = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Demand Forecast", icon: TrendingUp },
  { label: "Pricing Strategy", icon: BarChart3 },
  { label: "Products", icon: Boxes },
  { label: "Model Performance", icon: Activity },
];

const number = (n: number) =>
  Number.isFinite(n)
    ? new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n)
    : "—";

const decimal = (n: number, digits = 2) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-IN", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      })
    : "—";

const money = (n: number) => `₹${number(n)}`;
const safeNumber = (n: number | null | undefined, format = number) =>
  n === null || n === undefined ? "Review" : format(n);
const safeMoney = (n: number | null | undefined) =>
  n === null || n === undefined ? "Review" : money(n);
const parseNumber = (v: unknown): number | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
};
const normalizedName = (value: string) => value.trim().toUpperCase();

function validateHeaders(rows: Row[], file: string, required: string[]) {
  const available = new Set(rows.length ? Object.keys(rows[0]) : []);
  const missing = required.filter((header) => !available.has(header));
  if (missing.length) throw new Error(`${file} is missing required columns: ${missing.join(", ")}`);
}

function checkedNumber(value: unknown, file: string, column: string, issues: Map<string, number>) {
  const parsed = parseNumber(value);
  if (parsed === null) {
    const key = `${file}: ${column}`;
    issues.set(key, (issues.get(key) ?? 0) + 1);
  }
  return parsed;
}

function unmatchedProducts(file: string, rows: Row[]) {
  const names = [...new Set(rows.map((row) => (row.product ?? "").trim()).filter(Boolean))];
  return names.filter((name) => !canonicalProduct(name)).map((name) => `${file}: ${name}`);
}

function rawDataWarnings(rows: Row[]) {
  const warnings: string[] = [];
  const numericColumns = [
    "Demand_Tonnes", "Sales_Volume_Tonnes", "Production_Tonnes", "Installed_Capacity_Tonnes",
    "Capacity_Utilization_Percent", "Import_Tonnes", "Export_Tonnes", "Inventory_Tonnes",
    "Order_Backlog_Tonnes", "Domestic_Price_INR_per_Tonne", "Competitor_Price_INR_per_Tonne",
    "International_Price_USD_per_Tonne", "Crude_Oil_USD_per_Barrel", "Naphtha_USD_per_Tonne",
    "Propylene_USD_per_Tonne", "Ethylene_USD_per_Tonne", "Natural_Gas_USD_per_MMBtu",
    "USD_INR", "Freight_USD_per_Tonne", "Electricity_Cost_INR_per_kWh", "WPI_Index",
    "IIP_Index", "Manufacturing_PMI", "GDP_Growth_Percent", "Interest_Rate_Percent",
    "Construction_Activity_Index", "Automotive_Production_Index", "Packaging_Demand_Index",
    "Temperature_C", "Rainfall_mm", "Humidity_Percent", "Supplier_Lead_Time_Days",
    "Plant_Downtime_Days", "Port_Congestion_Index", "Seasonal_Promotion_Flag",
  ];
  const badCells = new Map<string, number>();
  for (const row of rows) {
    for (const column of numericColumns) {
      const raw = (row[column] ?? "").trim();
      if (!raw || ["nan", "na", "unknown", "check"].includes(raw.toLowerCase())) {
        badCells.set(column, (badCells.get(column) ?? 0) + 1);
        continue;
      }
      if (!Number.isFinite(Number(raw.replaceAll(",", "")))) badCells.set(column, (badCells.get(column) ?? 0) + 1);
    }
  }
  if (badCells.size) {
    const examples = [...badCells.entries()].slice(0, 8).map(([column, count]) => `${column}: ${count}`);
    warnings.push(`Raw data has blank or invalid numeric cells (${examples.join("; ")}${badCells.size > 8 ? "; more columns omitted" : ""}).`);
  }
  const exactRows = new Set(rows.map((row) => JSON.stringify(row)));
  if (rows.length !== exactRows.size) warnings.push(`Raw data contains ${rows.length - exactRows.size} exact duplicate rows.`);
  const kgPrices = rows.filter((row) => row.Price_Unit?.trim() === "INR/kg").length;
  if (kgPrices) warnings.push(`${kgPrices} raw domestic prices declare INR/kg and require unit-aware handling.`);
  const negativeDemand = rows.filter((row) => Number((row.Demand_Tonnes ?? "").replaceAll(",", "")) < 0).length;
  const negativeProduction = rows.filter((row) => Number((row.Production_Tonnes ?? "").replaceAll(",", "")) < 0).length;
  if (negativeDemand || negativeProduction) warnings.push(`Raw data contains negative demand (${negativeDemand}) or production (${negativeProduction}) values.`);
  return warnings;
}

async function loadCsv<T extends Row = Row>(file: string, warnings: string[]): Promise<T[]> {
  const response = await fetch(`/data/${file}`);
  if (!response.ok) throw new Error(`Could not load ${file} (${response.status})`);
  const text = await response.text();
  const parsed = Papa.parse<T>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length) warnings.push(`${file}: ${parsed.errors.length} CSV parsing issue(s); affected fields will be reviewed.`);
  return parsed.data;
}

export default function App() {
  const [page, setPage] = useState<Page>("Overview");
  const [query, setQuery] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [kpis, setKpis] = useState<Record<string, number | null>>({});
  const [products, setProducts] = useState<Product[]>([]);
  const [priceRecommendations, setPriceRecommendations] = useState<PriceRecommendation[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [forecastRows, setForecastRows] = useState<Row[]>([]);
  const [futureRows, setFutureRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [qualityWarnings, setQualityWarnings] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        setLoading(true);
        setError("");
        const warnings: string[] = [];
        const numericIssues = new Map<string, number>();

        const [kpiRows, pricingRows, summaryRows, metricRows, predictionRows, futureForecastRows, rawRows] =
          await Promise.all([
            loadCsv("dashboard_kpis.csv", warnings),
            loadCsv("pricing_recommendations_phase1.csv", warnings),
            loadCsv("final_product_summary.csv", warnings),
            loadCsv("model_comparison.csv", warnings),
            loadCsv("demand_forecast_results.csv", warnings),
            loadCsv("future_demand_forecasts.csv", warnings),
            loadCsv("Petrochemical_Raw_Messy_Dataset_Large.csv", warnings),
          ]);

        if (!alive) return;

        validateHeaders(kpiRows, "dashboard_kpis.csv", ["KPI", "Value"]);
        validateHeaders(pricingRows, "pricing_recommendations_phase1.csv", ["product", "current_average_price_inr_per_tonne", "competitor_average_price_inr_per_tonne", "recommended_average_price_inr_per_tonne", "calculated_price_change_percent", "unit_status"]);
        validateHeaders(summaryRows, "final_product_summary.csv", ["product", "Actual_Average_Demand", "Linear_Regression_Forecast"]);
        validateHeaders(metricRows, "model_comparison.csv", ["Model", "MAE", "RMSE", "R2 Score"]);
        validateHeaders(predictionRows, "demand_forecast_results.csv", ["date", "product", "actual_demand", "linear_regression_prediction", "random_forest_prediction"]);
        validateHeaders(futureForecastRows, "future_demand_forecasts.csv", ["date", "product", "predicted_demand_tonnes"]);
        validateHeaders(rawRows, "Petrochemical_Raw_Messy_Dataset_Large.csv", ["Product", "Price_Unit"]);
        warnings.push(...rawDataWarnings(rawRows));

        const coverageFiles = [
          ["summary", summaryRows],
          ["pricing", pricingRows],
          ["evaluation forecast", predictionRows],
          ["future forecast", futureForecastRows],
        ] as const;
        const unmatched = coverageFiles.flatMap(([label, rows]) => unmatchedProducts(label, rows));
        for (const [label, rows] of coverageFiles) {
          const canonical = rows.map((row) => canonicalProduct(row.product ?? "")).filter((name): name is string => name !== null);
          const fileUnmatched = unmatchedProducts(label, rows);
          warnings.push(`${label} mapping coverage: ${new Set(canonical).size}/10 canonical product families matched; ${fileUnmatched.length} unmatched label(s)${fileUnmatched.length ? ` (${fileUnmatched.join(", ")})` : ""}.`);
          if (canonical.length !== new Set(canonical).size) warnings.push(`${label} contains aliases that map to the same canonical product; rows remain separate pending reconciliation.`);
        }
        if (unmatched.length) warnings.push(`Unmatched product labels across files: ${unmatched.join(", ")}.`);

        const kpiMap: Record<string, number | null> = {};
        kpiRows.forEach((r) => {
          const value = checkedNumber(r.Value, "dashboard_kpis.csv", "Value", numericIssues);
          if (r.KPI === "Average_Domestic_Price") {
            kpiMap[r.KPI] = null;
          } else {
            kpiMap[r.KPI] = value;
          }
        });
        warnings.push("Average domestic price KPI is withheld because its source does not establish unit-consistent aggregation.");
        setKpis(kpiMap);

        const pricing = new Map<string, Row>();
        pricingRows.forEach((r) => {
          pricing.set(normalizedName(r.product || ""), r);
        });
        const priceRows: PriceRecommendation[] = pricingRows.map((r) => ({
          product: r.product || "Unknown",
          canonical: canonicalProduct(r.product || ""),
          current: r.unit_status === "REVIEW_REQUIRED" ? null : checkedNumber(r.current_average_price_inr_per_tonne, "pricing_recommendations_phase1.csv", "current_average_price_inr_per_tonne", numericIssues),
          competitor: checkedNumber(r.competitor_average_price_inr_per_tonne, "pricing_recommendations_phase1.csv", "competitor_average_price_inr_per_tonne", numericIssues),
          recommended: checkedNumber(r.recommended_average_price_inr_per_tonne, "pricing_recommendations_phase1.csv", "recommended_average_price_inr_per_tonne", numericIssues),
          change: r.unit_status === "REVIEW_REQUIRED" ? null : checkedNumber(r.calculated_price_change_percent, "pricing_recommendations_phase1.csv", "calculated_price_change_percent", numericIssues),
          status: r.unit_status || "REVIEW_REQUIRED",
        }));
        setPriceRecommendations(priceRows);
        const priceReviewCount = priceRows.filter((r) => r.status === "REVIEW_REQUIRED").length;
        if (priceReviewCount) warnings.push(`${priceReviewCount} pricing rows have mixed or unverified source units; current price and percentage are withheld for review.`);

        const productRows: Product[] = summaryRows
          .map((r) => {
            const name = (r.product || "Unknown").trim();
            const p = pricing.get(normalizedName(name));

            return {
              name,
              demand: checkedNumber(r.Actual_Average_Demand, "final_product_summary.csv", "Actual_Average_Demand", numericIssues),
              price: p && p.unit_status !== "REVIEW_REQUIRED" ? parseNumber(p.current_average_price_inr_per_tonne) : null,
              competitorPrice: p ? parseNumber(p.competitor_average_price_inr_per_tonne) : null,
              recommendedPrice: p ? parseNumber(p.recommended_average_price_inr_per_tonne) : null,
              change: p && p.unit_status !== "REVIEW_REQUIRED" ? parseNumber(p.calculated_price_change_percent) : null,
              forecast: checkedNumber(r.Linear_Regression_Forecast, "final_product_summary.csv", "Linear_Regression_Forecast", numericIssues),
            };
          })
          .filter((p) => p.name !== "Unknown");

        setProducts(productRows);
        setMetrics(
          metricRows.map((r) => ({
            Model: r.Model,
            MAE: checkedNumber(r.MAE, "model_comparison.csv", "MAE", numericIssues),
            RMSE: checkedNumber(r.RMSE, "model_comparison.csv", "RMSE", numericIssues),
            "R2 Score": checkedNumber(r["R2 Score"], "model_comparison.csv", "R2 Score", numericIssues),
          })),
        );
        setForecastRows(predictionRows);
        setFutureRows(futureForecastRows);
        predictionRows.forEach((r) => {
          checkedNumber(r.actual_demand, "demand_forecast_results.csv", "actual_demand", numericIssues);
          checkedNumber(r.linear_regression_prediction, "demand_forecast_results.csv", "linear_regression_prediction", numericIssues);
          checkedNumber(r.random_forest_prediction, "demand_forecast_results.csv", "random_forest_prediction", numericIssues);
        });
        futureForecastRows.forEach((r) => checkedNumber(r.predicted_demand_tonnes, "future_demand_forecasts.csv", "predicted_demand_tonnes", numericIssues));
        warnings.push(...[...numericIssues.entries()].map(([field, count]) => `${field}: ${count} missing/invalid value(s); displayed as Review.`));
        if (summaryRows.some((r) => !pricing.has(normalizedName(r.product || "")))) warnings.push("Some summary products have no exact matching price row; their prices are withheld.");
        setQualityWarnings([...new Set(warnings)]);
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e.message : "Could not load dashboard data.");
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(
    () => products.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
    [products, query],
  );
  const filteredPricing = useMemo(
    () => priceRecommendations.filter((p) => p.product.toLowerCase().includes(query.toLowerCase())),
    [priceRecommendations, query],
  );

  // Average the available evaluation records for each month.
  // Missing months are represented as null, not zero, so the chart does not imply
  // observations exist where the exported evaluation file has no rows.
  const chartData = useMemo(() => {
    const grouped = new Map<
      string,
      { date: string; actual: number; linear: number; forest: number; actualCount: number; linearCount: number; forestCount: number; count: number }
    >();

    forecastRows.forEach((r) => {
      const date = (r.date || "").slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(date)) return;

      const item = grouped.get(date) || {
        date,
        actual: 0,
        linear: 0,
        forest: 0,
        actualCount: 0,
        linearCount: 0,
        forestCount: 0,
        count: 0,
      };

      const actual = parseNumber(r.actual_demand);
      const linear = parseNumber(r.linear_regression_prediction);
      const forest = parseNumber(r.random_forest_prediction);
      if (actual !== null) { item.actual += actual; item.actualCount += 1; }
      if (linear !== null) { item.linear += linear; item.linearCount += 1; }
      if (forest !== null) { item.forest += forest; item.forestCount += 1; }
      item.count += 1;
      grouped.set(date, item);
    });

    const months = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
    if (!months.length) return [];

    const first = new Date(`${months[0]}-01T00:00:00`);
    const last = new Date(`${months[months.length - 1]}-01T00:00:00`);
    const result: Array<{
      label: string;
      actual: number | null;
      linear: number | null;
      forest: number | null;
      records: number;
    }> = [];

    const cursor = new Date(first);
    while (cursor <= last) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
      const row = grouped.get(key);
      result.push({
        label: key,
        actual: row?.actualCount ? row.actual / row.actualCount : null,
        linear: row?.linearCount ? row.linear / row.linearCount : null,
        forest: row?.forestCount ? row.forest / row.forestCount : null,
        records: row?.count ?? 0,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return result;
  }, [forecastRows]);

  const futureChartData = useMemo(() => {
    const evaluationCutoff = forecastRows.map((r) => (r.date || "").slice(0, 7)).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort().at(-1) ?? "";
    const grouped = new Map<string, { date: string; demand: number; count: number }>();
    futureRows.forEach((r) => {
      const date = (r.date || "").slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(date) || date <= evaluationCutoff) return;
      const item = grouped.get(date) || { date, demand: 0, count: 0 };
      const value = parseNumber(r.predicted_demand_tonnes);
      if (value !== null) { item.demand += value; item.count += 1; }
      grouped.set(date, item);
    });
    return [...grouped.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({
        label: r.date,
        predicted: r.count ? r.demand / r.count : null,
        records: r.count,
      }));
  }, [futureRows, forecastRows]);

  const exportCsv = (rows: Record<string, unknown>[], filename: string) => {
    if (!rows.length) return;
    const csv = Papa.unparse(rows);
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8;" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportProducts = () =>
    exportCsv(
      filtered.map((p) => ({
        Product: p.name,
        AverageDemandTonnes: p.demand,
        CurrentPriceINR: p.price,
        CompetitorPriceINR: p.competitorPrice,
        RecommendedPriceINR: p.recommendedPrice,
        CalculatedPriceChangePercent: p.change === null ? "" : Number(p.change.toFixed(2)),
      })),
      "petrovision_products.csv",
    );

  return (
    <div className="layout">
      {mobileOpen && (
        <button
          className="backdrop"
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>
        <div className="brand">
          <span className="brand-icon"><Factory size={20} /></span>
          <span>
            <b>PetroVision</b>
            <small>Analytics workspace</small>
          </span>
          <button
            className="mobile-close"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        <p className="nav-title">MENU</p>
        <nav>
          {nav.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={`nav-link ${page === label ? "selected" : ""}`}
              onClick={() => {
                setPage(label);
                setMobileOpen(false);
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-note">
          <Factory size={18} />
          <b>Petrochemical analytics</b>
          <p>Demand forecasting and pricing insights in one place.</p>
        </div>

        <div className="sidebar-bottom">
          Project dashboard
          <span>{loading ? "Loading data…" : error ? "Data issue" : "CSV connected"}</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button
            className="menu-button"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div className="crumb">Workspace <span>/</span> <b>{page}</b></div>
          <div className="preview-pill">
            <i />
            {loading ? "Loading data" : error ? "Check CSVs" : "Notebook CSVs"}
          </div>
        </header>

        <div className="content">
          <div className="page-title">
            <div>
              <p className="eyebrow">PETROCHEMICAL ANALYTICS</p>
              <h1>{page}</h1>
              <p className="subtitle">
                Demand, pricing and model results from your notebook exports.
              </p>
            </div>
            <button className="button-primary" onClick={exportProducts}>
              <Download size={16} /> Export CSV
            </button>
          </div>

          <div className="search-row">
            <div className="search">
              <Search size={17} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search products..."
              />
              {query && (
                <button onClick={() => setQuery("")} aria-label="Clear search">
                  <X size={15} />
                </button>
              )}
            </div>
            <span>{filtered.length} summary entries</span>
          </div>

          {error && (
            <section className="panel">
              <h2>Unable to load CSV data</h2>
              <p>{error}</p>
              <p>Confirm the files exist in <code>public/data/</code> and restart the Vite server.</p>
            </section>
          )}

          {!loading && !error && qualityWarnings.length > 0 && (
            <section className="quality-warning" role="status" aria-label="Data quality warnings">
              <h2>Data quality warnings</h2>
              <p>Values marked “Review” are missing or have unresolved units and are not treated as zero.</p>
              <ul>{qualityWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </section>
          )}

          {loading && (
            <section className="panel"><p>Loading notebook CSV outputs…</p></section>
          )}

          {!loading && !error && (
            <>
              {page === "Overview" && (
                <>
                  <section className="kpis">
                    <article className="kpi">
                      <span>Average demand</span>
                      <strong>{safeNumber(kpis.Average_Demand_Tonnes)} <small>tonnes</small></strong>
                      <p>Average per record in dataset</p>
                    </article>
                    <article className="kpi">
                      <span>Average domestic price</span>
                      <strong>{safeMoney(kpis.Average_Domestic_Price)}</strong>
                      <p>Per tonne · dataset average</p>
                    </article>
                    <article className="kpi">
                      <span>Products</span>
                      <strong>{safeNumber(kpis.Total_Products)}</strong>
                      <p>Raw dataset product labels (not normalized)</p>
                    </article>
                  </section>

                  <section className="panel">
                    <div className="panel-head">
                      <div>
                        <h2>Demand predictions</h2>
                        <p>Average test-set demand per product record by month</p>
                      </div>
                    </div>
                    <div className="chart">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData}>
                          <CartesianGrid stroke="#edf0f5" strokeDasharray="4 4" vertical={false} />
                          <XAxis dataKey="label" axisLine={false} tickLine={false} />
                          <YAxis axisLine={false} tickLine={false} />
                          <Tooltip formatter={(value) => [typeof value === "number" ? number(value) : "No data", "Average demand (tonnes)"]} labelFormatter={(label) => `Month: ${label}`} />
                          <Legend />
                          <Area dataKey="actual" name="Actual demand" stroke="#159b79" fill="#159b79" fillOpacity={0.08} connectNulls={false} />
                          <Area dataKey="linear" name="Linear Regression prediction" stroke="#4776ee" fill="#4776ee" fillOpacity={0.1} connectNulls={false} />
                          <Area dataKey="forest" name="Random Forest prediction" stroke="#d99a32" fill="#d99a32" fillOpacity={0.08} connectNulls={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </section>

                  <ProductsTable items={filtered} />
                </>
              )}

              {page === "Demand Forecast" && (
                <>
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Model predictions</h2>
                      <p>Monthly average test-set demand; evaluation data, not future forecasts.</p>
                    </div>
                  </div>
                  <div className="chart tall">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartData}>
                        <CartesianGrid stroke="#edf0f5" strokeDasharray="4 4" vertical={false} />
                        <XAxis dataKey="label" axisLine={false} tickLine={false} />
                        <YAxis axisLine={false} tickLine={false} />
                        <Tooltip formatter={(value) => [typeof value === "number" ? number(value) : "No data", "Average demand (tonnes)"]} labelFormatter={(label) => `Month: ${label}`} />
                        <Legend />
                        <Area dataKey="actual" name="Actual demand" stroke="#159b79" fill="#159b79" fillOpacity={0.08} connectNulls={false} />
                        <Area dataKey="linear" name="Linear Regression" stroke="#4776ee" fill="#4776ee" fillOpacity={0.1} connectNulls={false} />
                        <Area dataKey="forest" name="Random Forest" stroke="#d99a32" fill="#d99a32" fillOpacity={0.08} connectNulls={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="note">
                    Source: demand_forecast_results.csv. Dates reflect the exported evaluation rows.
                    Missing months are shown as gaps; monthly values are averages of available product records.
                  </p>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Future demand forecast</h2>
                      <p>Only dates after the latest evaluation date are shown. Historical rows in the source file are excluded.</p>
                    </div>
                  </div>
                  {futureChartData.length ? (
                    <div className="chart tall">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={futureChartData}>
                          <CartesianGrid stroke="#edf0f5" strokeDasharray="4 4" vertical={false} />
                          <XAxis dataKey="label" axisLine={false} tickLine={false} />
                          <YAxis axisLine={false} tickLine={false} />
                          <Tooltip
                            formatter={(value) => [typeof value === "number" ? number(value) : "No data", "Predicted demand (tonnes)"]}
                            labelFormatter={(label) => `Month: ${label}`}
                          />
                          <Area dataKey="predicted" name="Future predicted demand" stroke="#4776ee" fill="#4776ee" fillOpacity={0.12} connectNulls={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="note">No forecast rows after the evaluation cutoff are available; no future values are inferred.</p>
                  )}
                </section>
                </>
              )}

              {page === "Pricing Strategy" && (
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Pricing recommendations</h2>
                      <p>Percentages use unit-verified current prices. Rows with ambiguous source units are withheld for review.</p>
                    </div>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Product</th>
                          <th>Current price</th>
                          <th>Competitor price</th>
                          <th>Recommended price</th>
                          <th>Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredPricing.map((p) => (
                          <tr key={p.product}>
                            <td><b>{p.product}</b><small className="canonical-label">{p.canonical ?? "Unmatched"}</small></td>
                            <td>{safeMoney(p.current)}</td>
                            <td>{safeMoney(p.competitor)}</td>
                            <td>{safeMoney(p.recommended)}</td>
                            <td className={p.change === null ? "review-value" : p.change >= 0 ? "positive" : "negative"}>
                              {p.change === null ? p.status : `${p.change > 0 ? "+" : ""}${decimal(p.change)}%`}
                            </td>
                          </tr>
                        ))}
                        {!filteredPricing.length && <tr><td colSpan={5}>No matching products found.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {page === "Products" && <ProductsTable items={filtered} />}

              {page === "Model Performance" && (
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Model performance</h2>
                      <p>Metrics read from model_comparison.csv</p>
                    </div>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr><th>Model</th><th>MAE</th><th>RMSE</th><th>R²</th></tr>
                      </thead>
                      <tbody>
                        {metrics.map((m) => (
                          <tr key={m.Model}>
                            <td><b>{m.Model}</b></td>
                            <td>{safeNumber(m.MAE, decimal)}</td>
                            <td>{safeNumber(m.RMSE, decimal)}</td>
                            <td>{safeNumber(m["R2 Score"], (v) => decimal(v, 4))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="note">
                    These are reported evaluation metrics for your synthetic dataset; they do not establish real-world market accuracy.
                  </p>
                </section>
              )}
            </>
          )}

          <footer className="footer">
            PetroVision <span>•</span> Synthetic dataset · CSV-based dashboard
          </footer>
        </div>
      </main>
    </div>
  );
}

function ProductsTable({ items }: { items: Product[] }) {
  return (
    <section className="panel table-panel">
      <div className="panel-head">
        <div>
          <h2>Products</h2>
          <p>Notebook summary by product</p>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Average demand (tonnes)</th>
              <th>Current price</th>
              <th>Recommended price</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.name}>
                <td><b>{p.name}</b></td>
                <td>{safeNumber(p.demand)}</td>
                <td>{safeMoney(p.price)}</td>
                <td>{safeMoney(p.recommendedPrice)}</td>
              </tr>
            ))}
            {!items.length && (
              <tr><td colSpan={4}>No matching products found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
