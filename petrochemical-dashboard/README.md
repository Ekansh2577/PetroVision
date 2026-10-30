# PetroVision

PetroVision is a React, TypeScript, and Vite dashboard for reviewing synthetic petrochemical demand, the existing pricing exports, and model results. The repository contains static CSV exports and a **separate new replacement forecasting pipeline**. The replacement methodology is not the recovered original pipeline and does not reproduce its results.

## Frontend setup and checks

Use Node.js 22.12+ and npm for all listed commands. From the repository root, install the lockfile dependencies and start the development server:

```powershell
npm.cmd ci
npm.cmd run dev
```

On shells where `npm` is not blocked by PowerShell execution policy, the equivalent commands are `npm ci` and `npm run dev`. Run the checks from the same repository root:

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

The test command runs the TypeScript data-validation and replacement-dashboard integration tests. The production build type-checks and builds the Vite app into the ignored `dist/` directory. Vite may warn that the minified JavaScript bundle exceeds 500 kB; this audit leaves code splitting unchanged because no safe, measured split was established.

## Project layout and data separation

- `src/`: dashboard pages, CSV validation, reviewed product mapping, charts, tables, and replacement output integration.
- `public/data/`: original source/export CSVs and Phase 1 derived files. The source CSVs are retained; `pricing_recommendations_phase1.csv` is a separate derivative.
- `replacement_pipeline/`: independent Python methodology, tests, configuration, audit files, outputs, and backup history.
- `backups/`: preserved Phase 1, Phase 2, Phase 4, and Phase 5 file backups.

The dashboard continues to read its overview, summary, pricing, and historical evaluation exports from `public/data/`. In the Demand Forecast page, the historical evaluation chart uses `demand_forecast_results.csv`. The separate synthetic future chart and replacement metric table read `replacement_pipeline/outputs/future_forecasts.csv` and `evaluation_metrics.csv` through Vite build-time imports. The legacy `public/data/future_demand_forecasts.csv` remains preserved but is not used for that replacement future chart. No replacement output is copied over public dashboard data or connected to pricing.

### Principal CSVs

| File | Purpose |
| --- | --- |
| `public/data/Petrochemical_Raw_Messy_Dataset_Large.csv` | Raw synthetic rows with demand, prices, operating measures, and market indicators. |
| `public/data/demand_forecast_results.csv` | Existing exported historical evaluation actuals and two predictions. |
| `public/data/future_demand_forecasts.csv` | Legacy forecast export containing historical dates as well as Jan–Jun 2026 rows; it is retained, not used as the replacement chart source. |
| `public/data/pricing_recommendations.csv` | Original price export, unchanged. |
| `public/data/pricing_recommendations_phase1.csv` | Unit-reviewed derivative used for the dashboard. Ambiguous current prices and calculated changes remain blank and marked `REVIEW_REQUIRED`. |
| `public/data/product_name_mapping.csv` | Reviewed alias mapping used for display and replacement family tags. Aliases are not merged by the replacement pipeline. |
| `replacement_pipeline/outputs/evaluation_predictions.csv` | Replacement historical evaluation predictions, separate from future forecasts. |
| `replacement_pipeline/outputs/evaluation_metrics.csv` | Replacement per-product and pooled metrics for each fold and both folds combined. |
| `replacement_pipeline/outputs/future_forecasts.csv` | Replacement-only Jan–Jun 2026 synthetic demonstration forecasts. |

The dashboard reports invalid or missing numeric values as **Review**, unmatched product labels, aliases that collide on a canonical product, and unresolved price units. Its average domestic-price KPI is withheld because the source does not establish unit-consistent aggregation.

## Existing exports: limits and reported arithmetic

The existing `model_comparison.csv` values were independently recalculated from the 620 rows in `demand_forecast_results.csv` and match that metric export:

| Existing exported model | MAE | RMSE | R² |
| --- | ---: | ---: | ---: |
| Linear Regression | 3,388.73 | 9,255.19 | 0.9063 |
| Random Forest | 4,041.22 | 9,800.29 | 0.8949 |

This checks arithmetic consistency only. The original notebook/Python training pipeline was not found in the repository, so the original preprocessing, split, feature engineering, leakage risk, and metric procedure cannot be reproduced or independently validated. These figures do not establish real-world accuracy.

## Replacement pipeline: separate, synthetic methodology

The replacement pipeline is a newly developed review artifact, not recovery or reproduction of the original methodology. Its source has no real-market provenance; treat every result as synthetic demonstration data, not a market prediction. Read [replacement_pipeline/README.md](replacement_pipeline/README.md) for schema, preprocessing, units, date handling, fixed-origin splits, recursive feature rules, output details, and limitations.

From `replacement_pipeline/`, create an environment with Python and install the pinned dependency, then run tests:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
```

The replacement tests and run were verified in this workspace with Python 3.14.6 and scikit-learn 1.9.0, the version pinned in `requirements.txt`.

To safely check reproducibility without replacing the submission outputs, direct a run to a new directory inside `replacement_pipeline/`:

```powershell
python run_pipeline.py --output phase5_repro_check
```

To intentionally refresh the normal replacement outputs instead, run `python run_pipeline.py`. Existing files in `outputs/` are copied into a timestamped `backups/` directory before they are overwritten. This process does not alter original `public/data/` CSVs. After refreshing the outputs, return to the repository root and run `npm.cmd run build` (or `npm run build` outside restricted PowerShell) to embed those CSVs in the dashboard bundle.

### Replacement evaluation summary

The two non-overlapping recursive six-month evaluation folds use origins 2025-01-01 and 2025-07-01, with 117 eligible product-month targets combined. Across both folds, the naïve last-observed baseline has MAE 5,251.32, RMSE 6,738.87, and pooled R² 0.9545; Random Forest has MAE 4,734.71, RMSE 7,150.38, and pooled R² 0.9488. Random Forest reduces MAE, while the naïve model has lower RMSE and higher pooled R². Neither model is best on every measure. Fold-level and per-product results vary, and pooled R² can be dominated by product-level differences. These results do not demonstrate predictive validity.

The separate future export is as of 2025-12-01 and covers Jan–Jun 2026. It contains predictions only, not invented future observations. The dashboard labels it synthetic and keeps historical evaluation predictions in a separate chart.

## Pricing, data quality, and known limitations

- Treat the raw dataset, existing exported metrics, and replacement outputs as synthetic; no provenance is supplied.
- The raw records include missing/placeholder values, duplicates, inconsistent date/product labels, negative quantities, and both `INR/tonne` and `INR/kg` unit declarations.
- Phase 1 converts a current-price aggregate only where its exact-label source unit can be established (`P.V.C.`). Mixed or unresolved unit rows remain flagged for review; the original pricing CSV is unchanged. The replacement pipeline does not produce pricing recommendations and does not endorse the existing fixed 2% uplift.
- Product mappings are reviewed labels, not evidence that aliases or grades should be aggregated. Replacement modeling keeps aliases separate and requires domain confirmation for grouped identities.
- Replacement preprocessing preserves ambiguous dates/units in its audit, excludes ineligible targets without imputing them, and uses no future price or market covariates.
- Replacement evaluation has two origins and small per-product sample counts. The model outputs are for methodology review only.
- The forecast pipeline is reproducible as a **new replacement** from the included script/configuration and available dependencies; the original notebook method is not reproducible from this repository.
