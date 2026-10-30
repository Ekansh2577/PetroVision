# PetroVision

PetroVision is a React, TypeScript, and Vite dashboard for exploring synthetic petrochemical demand forecasts, price recommendations, product summaries, and exported model metrics.

## Setup

Requirements: Node.js 20.19+ or 22.12+ and npm.

```sh
npm install
npm run dev
```

The dashboard reads static CSV files from `public/data/`. To check TypeScript and create the Vite production bundle, run `npm run build`. Run `npm run lint` for the configured Oxlint checks. There is no automated test script in `package.json`.

## Project layout

- `src/App.tsx`: dashboard pages, CSV loading and validation, tables, charts, and CSV export.
- `src/productMapping.ts`: reviewed product aliases mapped to ten canonical resin families.
- `public/data/`: source data and notebook-style export CSVs. The original exports are retained; `pricing_recommendations_phase1.csv` is a separate Phase 1 derived file.
- `src/App.css`, `src/index.css`: dashboard and base styles.

## Data files

| File | Purpose |
| --- | --- |
| `Petrochemical_Raw_Messy_Dataset_Large.csv` | Raw synthetic records, including demand, prices, operating measures, and market indicators. |
| `historical_trends.csv`, `monthly_demand.csv` | Historical and monthly demand/price exports. |
| `demand_forecast_results.csv` | Actual values and two model predictions for the evaluation rows. |
| `future_demand_forecasts.csv`, `future_product_summary.csv`, `monthly_forecast_summary.csv` | Forecast-oriented exports. The row-level future file also contains historical dates; the dashboard excludes dates at or before the latest evaluation month. |
| `pricing_recommendations.csv` | Original price export, preserved unchanged. |
| `pricing_recommendations_phase1.csv` | Unit-reviewed derivative used by the dashboard. Verified percentages are recalculated; unresolved current prices and percentages are blank and marked `REVIEW_REQUIRED`. |
| `product_name_mapping.csv` | Human-readable reviewed alias-to-canonical mapping. |
| `dashboard_kpis.csv`, `model_comparison.csv`, `model_performance.csv`, `feature_importance.csv` | KPI, reported metric, and feature-importance exports. |

The dashboard validates required headers, reports malformed CSV input and invalid numeric cells, and displays unresolved values as **Review** rather than converting them to zero. It also surfaces unmatched product labels, aliases that collide on a canonical product, and price-unit review rows.

## Reported evaluation metrics

The following metrics were independently recalculated from all 620 rows in `demand_forecast_results.csv`. They exactly match `model_comparison.csv`:

| Model | MAE | RMSE | R² |
| --- | ---: | ---: | ---: |
| Linear Regression | 3,388.73 | 9,255.19 | 0.9063 |
| Random Forest | 4,041.22 | 9,800.29 | 0.8949 |

These figures verify arithmetic consistency between the prediction export and metric export only. They do not verify the training procedure, split strategy, absence of leakage, or real-world accuracy.

## Synthetic-data limitations and known issues

- Treat all project data and metrics as synthetic; no real market provenance is supplied.
- The raw file contains missing/place-holder values, duplicate records, inconsistent dates and product labels, negative quantities, and both `INR/tonne` and `INR/kg` domestic prices.
- Phase 1 converts only a current-price aggregate whose exact-label source unit is unambiguous (`P.V.C.`). Rows with mixed or unavailable exact-label units are withheld from price-change calculation and flagged for review. The original CSV files are not overwritten.
- The overall average domestic price KPI is withheld because its source does not document unit-consistent aggregation.
- Product aliases are mapped for dashboard matching, but rows are not merged because their aggregate weighting and identity cannot be established from the exports alone.
- `future_demand_forecasts.csv` contains 2011–2025 historical dates as well as January–June 2026. The dashboard only displays rows after the latest evaluation month; no future observations are generated.
- No notebook or Python pipeline is included in this repository. Data preprocessing, feature engineering, model training, chronological splitting, and recommendation logic therefore cannot be reproduced or audited from this project alone.
- Evaluation metrics are aggregate, with no supplied baseline or per-product evaluation. Synthetic results do not establish operational forecasting quality.

## Reproducibility

The frontend can be installed and run using the commands above. Forecast/model data generation is **not reproducible from this repository** because the notebook/Python pipeline was not found. The checked-in CSV files are static inputs to the dashboard.
