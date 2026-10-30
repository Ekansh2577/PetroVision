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
import "./App.css";

type Page = "Overview" | "Demand Forecast" | "Pricing Strategy" | "Products" | "Model Performance";
type Row = Record<string, string>;
type Product = {
  name: string;
  demand: number;
  price: number;
  competitorPrice: number;
  recommendedPrice: number;
  change: number;
  forecast: number;
};
type Metric = { Model: string; MAE: number; RMSE: number; "R2 Score": number };

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
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function loadCsv<T extends Row = Row>(file: string): Promise<T[]> {
  const response = await fetch(`/data/${file}`);
  if (!response.ok) throw new Error(`Could not load ${file} (${response.status})`);
  const text = await response.text();
  const parsed = Papa.parse<T>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length && !parsed.data.length) {
    throw new Error(`Could not parse ${file}`);
  }
  return parsed.data;
}

export default function App() {
  const [page, setPage] = useState<Page>("Overview");
  const [query, setQuery] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [kpis, setKpis] = useState<Record<string, number>>({});
  const [products, setProducts] = useState<Product[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [forecastRows, setForecastRows] = useState<Row[]>([]);
  const [futureRows, setFutureRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        setLoading(true);
        setError("");

        const [kpiRows, pricingRows, summaryRows, metricRows, predictionRows, futureForecastRows] =
          await Promise.all([
            loadCsv("dashboard_kpis.csv"),
            loadCsv("pricing_recommendations.csv"),
            loadCsv("final_product_summary.csv"),
            loadCsv("model_comparison.csv"),
            loadCsv("demand_forecast_results.csv"),
            loadCsv("future_demand_forecasts.csv"),
          ]);

        if (!alive) return;

        const kpiMap: Record<string, number> = {};
        kpiRows.forEach((r) => {
          kpiMap[r.KPI] = num(r.Value);
        });
        setKpis(kpiMap);

        const pricing = new Map<string, Row>();
        pricingRows.forEach((r) => {
          pricing.set((r.product || "").trim().toLowerCase(), r);
        });

        const productRows: Product[] = summaryRows
          .map((r) => {
            const name = (r.product || "Unknown").trim();
            const p = pricing.get(name.toLowerCase()) || r;
            const current = num(p.Current_Average_Price ?? r.Current_Average_Price);
            const competitor = num(p.Competitor_Average_Price ?? r.Competitor_Average_Price);
            const recommended = num(p.Recommended_Average_Price ?? r.Recommended_Average_Price);
            const computedChange = current
              ? ((recommended - current) / current) * 100
              : 0;

            return {
              name,
              demand: num(r.Actual_Average_Demand),
              price: current,
              competitorPrice: competitor,
              recommendedPrice: recommended,
              change: computedChange,
              forecast: num(r.Linear_Regression_Forecast),
            };
          })
          .filter((p) => p.name !== "Unknown");

        setProducts(productRows);
        setMetrics(
          metricRows.map((r) => ({
            Model: r.Model,
            MAE: num(r.MAE),
            RMSE: num(r.RMSE),
            "R2 Score": num(r["R2 Score"]),
          })),
        );
        setForecastRows(predictionRows);
        setFutureRows(futureForecastRows);
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

  // Average the available evaluation records for each month.
  // Missing months are represented as null, not zero, so the chart does not imply
  // observations exist where the exported evaluation file has no rows.
  const chartData = useMemo(() => {
    const grouped = new Map<
      string,
      { date: string; actual: number; linear: number; forest: number; count: number }
    >();

    forecastRows.forEach((r) => {
      const date = (r.date || "").slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(date)) return;

      const item = grouped.get(date) || {
        date,
        actual: 0,
        linear: 0,
        forest: 0,
        count: 0,
      };

      item.actual += num(r.actual_demand);
      item.linear += num(r.linear_regression_prediction);
      item.forest += num(r.random_forest_prediction);
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
        actual: row ? row.actual / row.count : null,
        linear: row ? row.linear / row.count : null,
        forest: row ? row.forest / row.count : null,
        records: row?.count ?? 0,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return result;
  }, [forecastRows]);

  const futureChartData = useMemo(() => {
    const grouped = new Map<string, { date: string; demand: number; count: number }>();
    futureRows.forEach((r) => {
      const date = (r.date || "").slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(date)) return;
      const item = grouped.get(date) || { date, demand: 0, count: 0 };
      item.demand += num(r.predicted_demand_tonnes);
      item.count += 1;
      grouped.set(date, item);
    });
    return [...grouped.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({
        label: r.date,
        predicted: r.count ? r.demand / r.count : null,
        records: r.count,
      }));
  }, [futureRows]);

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
        CalculatedPriceChangePercent: Number(p.change.toFixed(2)),
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
                      <strong>{number(kpis.Average_Demand_Tonnes)} <small>tonnes</small></strong>
                      <p>Average per record in dataset</p>
                    </article>
                    <article className="kpi">
                      <span>Average domestic price</span>
                      <strong>{money(kpis.Average_Domestic_Price)}</strong>
                      <p>Per tonne · dataset average</p>
                    </article>
                    <article className="kpi">
                      <span>Products</span>
                      <strong>{number(kpis.Total_Products)}</strong>
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
                      <p>Average predicted demand per available product record from future_demand_forecasts.csv.</p>
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
                    <p className="note">No future forecast rows are available in future_demand_forecasts.csv.</p>
                  )}
                </section>
                </>
              )}

              {page === "Pricing Strategy" && (
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Pricing recommendations</h2>
                      <p>Percentage change is recalculated from current and recommended prices.</p>
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
                        {filtered.map((p) => (
                          <tr key={p.name}>
                            <td><b>{p.name}</b></td>
                            <td>{money(p.price)}</td>
                            <td>{money(p.competitorPrice)}</td>
                            <td>{money(p.recommendedPrice)}</td>
                            <td className={p.change >= 0 ? "positive" : "negative"}>
                              {p.change > 0 ? "+" : ""}{decimal(p.change)}%
                            </td>
                          </tr>
                        ))}
                        {!filtered.length && <tr><td colSpan={5}>No matching products found.</td></tr>}
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
                            <td>{decimal(m.MAE)}</td>
                            <td>{decimal(m.RMSE)}</td>
                            <td>{decimal(m["R2 Score"], 4)}</td>
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
                <td>{number(p.demand)}</td>
                <td>{money(p.price)}</td>
                <td>{money(p.recommendedPrice)}</td>
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
