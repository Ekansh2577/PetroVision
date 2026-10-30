# PetroVision replacement forecasting pipeline

This is a **new replacement methodology** for review. It is not the recovered original pipeline, does not reproduce the original notebook, and makes no claim that its model is valid for real markets. All inputs are treated as synthetic demonstration data because no provenance is included.

## Run

Run commands from this directory (`replacement_pipeline/`):

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python run_pipeline.py
```

The default config reads `../public/data/Petrochemical_Raw_Messy_Dataset_Large.csv` and the Phase 1 reviewed mapping at `../public/data/product_name_mapping.csv`. All generated files stay under `replacement_pipeline/outputs/`. Before a rerun overwrites existing output files, the runner copies them to a timestamped folder under `replacement_pipeline/backups/`.

Optional read-only source override:

```powershell
python run_pipeline.py --source "C:\path\to\another\raw.csv"
```

The output path can be changed with `--output`, but must remain inside this pipeline directory. Model, split, product series, and feature parameters are configured in `pipeline_config.json`.

## Dashboard integration (explicit, build-time)

The dashboard imports only `outputs/future_forecasts.csv` and `outputs/evaluation_metrics.csv` as Vite `?raw` assets from this directory. It validates the synthetic label, as-of date, contiguous six-month boundary, reviewed product-family coverage, output values, aggregate metric rows, and identical eligible sample counts before displaying them. Future forecasts appear in a separate chart from historical evaluation predictions; the latter remain sourced from `public/data/demand_forecast_results.csv`. No replacement outputs are copied into or written over `public/data/`, and replacement forecasts are not connected to pricing.

After intentionally rerunning this pipeline, rebuild the dashboard so Vite embeds the newly written replacement outputs:

```powershell
cd ..
npm run build
```

The replacement methodology is independently developed and remains a synthetic demonstration, not the recovered original pipeline or a real market forecast. Dashboard build-time embedding means output changes are not picked up until the next build/restart.

## Source schema and preprocessing

The raw CSV has 3,200 rows and 38 columns. It includes `Date`, `Product`, `Demand_Tonnes`, sales/production/capacity/inventory/trade quantities, domestic and competitor prices, `Price_Unit`, commodity costs, exchange rate, economic/industry indicators, weather/operations fields, and a promotion flag. The complete source header list and row-level checks are written in `outputs/data_audit.json` and `outputs/preprocessing_audit.csv`.

Important rules:

- Recognized date forms are `YYYY-MM-DD`, `Mon-YYYY`, `DD-Mon-YY`, `YYYY/MM/DD`, and slash dates only when calendar validity determines one date. If slash month/day and day/month interpretations produce different valid dates, the original string is retained in the audit as `ambiguous_slash_date` and excluded from modeling. No locale guess is applied.
- The source has 3,015 ISO dates, 46 month-year dates, 45 day-month-name dates, 39 year-first slash dates, and 55 month/day-style slash strings. Ambiguous slash strings are retained and reported.
- `Price_Unit` has `INR/tonne` and `INR/kg` entries. The row audit includes a separate normalized domestic-price field only for explicit units (`INR/kg` is multiplied by 1,000; `INR/tonne` is unchanged). Unknown or missing units are withheld. Price fields are audit-only and are not model inputs; this pipeline does not generate or endorse pricing recommendations.
- Blank, placeholder, invalid, and nonfinite numeric cells are reported. No target demand is imputed. Missing/invalid targets and negative demand are ineligible; other negative quantity cells remain in the audit and are not model features.
- Exact duplicate source rows are retained in the audit, with repeated copies excluded from modeling. If distinct records collide in one selected product-month after date parsing, all such records are flagged and excluded rather than averaged.
- The Phase 1 mapping is used as a family tag only. Aliases stay separate. The configured primary source label for each family is modeled; all other aliases remain audit-only and are flagged for domain confirmation. This avoids treating grades or variants as interchangeable without evidence.
- Demand is modeled in tonnes as labeled. No price, currency, or external covariate is used to predict demand.

## Evaluation strategy

There are two non-overlapping fixed-origin recursive six-month folds:

| Fold origin / cutoff | Training target dates | Evaluation dates |
| --- | --- | --- |
| 2025-01-01 | Strictly before 2025-01-01 | 2025-01 through 2025-06 |
| 2025-07-01 | Strictly before 2025-07-01 | 2025-07 through 2025-12 |

Each fold fits per-product models using only pre-origin observations. For every six-month path, subsequent-step features use the model's earlier predictions, never held-out actuals. Missing evaluation targets still receive forecasts in the prediction file but have blank actuals and are excluded from both models' metrics identically.

The comparison is a persistence baseline (repeat the last observed pre-origin demand for all six steps) against one `RandomForestRegressor` per configured primary series. Features are latest prior demand, months since that observation, and sine/cosine calendar-month terms. The calendar is known in advance; demand features come only from observations before the origin or recursive predictions made after it. Prices and economic/operating covariates are excluded because the repository does not provide verified future values or historical as-of vintages.

After evaluation, each Random Forest is refit through the common latest valid observed month (expected 2025-12-01) and recursively forecasts six new dates (expected 2026-01-01 through 2026-06-01). The runner refuses to forecast if a selected series lacks sufficient history or does not reach the common cutoff.

MAE and RMSE are reported for all groups with eligible observations. R² is blank when a group has fewer than two observations or zero actual variance. Per-product counts and aggregate counts are included. Aggregate metrics are pooled across product-month rows; pooled R² can be dominated by between-product demand-level differences and should be read alongside per-product metrics. Small per-product holdout counts and synthetic data limit interpretation; a successful run is not evidence of real-market model validity.

## Outputs

- `preprocessing_audit.csv`: one row per original input record, with raw date/product/unit, parse/unit status, missing/invalid/negative fields, duplicate reference, and modeling inclusion/exclusion reason.
- `data_audit.json` and `data_audit.md`: source schema, date/unit/missing/duplicate/negative summaries, alias counts, exclusions, and model-row counts.
- `evaluation_predictions.csv`: both model predictions and actual/eligibility fields for each product, fold, and horizon month.
- `evaluation_metrics.csv`: per-product and aggregate MAE, RMSE, R², and sample counts by fold and combined folds.
- `future_forecasts.csv`: newly generated January–June 2026 baseline and Random Forest predictions, with no actual values.
- `run_manifest.json`: input hashes, timestamps, cutoffs, model/feature parameters, metrics, assumptions, and output names.

## Known limitations

- The original notebook/Python pipeline was not found. This package is an independent replacement and is not a reconstruction.
- Raw data provenance is absent; regard values and all results as synthetic.
- Product-family alias mappings require domain confirmation; no alias rows are merged.
- Ambiguous slash dates, missing targets, negative demand, and duplicate product-month collisions reduce usable data.
- This first replacement intentionally excludes pricing and external regressors. Their availability and units are not adequate for leakage-safe future forecasting.
- The two evaluation origins provide limited evidence. Results are useful for pipeline review, not a claim of predictive validity.
