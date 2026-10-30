"""New, auditable synthetic demand forecasting pipeline for PetroVision review.

This is an independent replacement methodology, not a recovery of the original
notebook/model. It reads the original raw CSV and writes only under this folder.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.metadata
import json
import math
import shutil
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

PIPELINE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = PIPELINE_DIR / "pipeline_config.json"
DATE_COLUMN = "Date"
PRODUCT_COLUMN = "Product"
UNIT_COLUMN = "Price_Unit"
TARGET_COLUMN = "Demand_Tonnes"
PRICE_COLUMN = "Domestic_Price_INR_per_Tonne"
QUANTITY_COLUMNS = (
    "Demand_Tonnes", "Sales_Volume_Tonnes", "Production_Tonnes",
    "Installed_Capacity_Tonnes", "Import_Tonnes", "Export_Tonnes",
    "Inventory_Tonnes", "Order_Backlog_Tonnes",
)
EVALUATION_COLUMNS = (
    "Fold", "Training_Cutoff", "Date", "Horizon_Month", "Product",
    "Canonical_Product", "Actual_Demand_Tonnes", "Naive_Prediction_Tonnes",
    "Random_Forest_Prediction_Tonnes", "Eligible_For_Metrics",
    "Target_Status", "Training_Sample_Count",
)
METRIC_COLUMNS = (
    "Fold", "Model", "Product", "Sample_Count", "MAE", "RMSE", "R2",
)
FUTURE_COLUMNS = (
    "As_Of_Date", "Date", "Horizon_Month", "Product", "Canonical_Product",
    "Naive_Prediction_Tonnes", "Random_Forest_Prediction_Tonnes",
    "Synthetic_Data_Label",
)


def parse_numeric(value: Any) -> tuple[float | None, str]:
    """Parse a finite numeric cell without imputing blanks or text as zero."""
    if value is None or not str(value).strip():
        return None, "missing"
    text = str(value).strip()
    if text.lower() in {"nan", "na", "n/a", "unknown", "null", "none"}:
        return None, "missing"
    if text.lower() == "check":
        return None, "invalid"
    try:
        parsed = float(text.replace(",", ""))
    except ValueError:
        return None, "invalid"
    if not math.isfinite(parsed):
        return None, "invalid"
    return parsed, "valid"


def parse_source_date(value: str) -> tuple[date | None, str]:
    """Parse supported formats; preserve ambiguous slash dates as unresolved."""
    text = (value or "").strip()
    formats = (
        ("%Y-%m-%d", "parsed_iso"),
        ("%b-%Y", "parsed_month_year"),
        ("%d-%b-%y", "parsed_day_month_name"),
    )
    for fmt, status in formats:
        try:
            return datetime.strptime(text, fmt).date(), status
        except ValueError:
            pass

    if len(text) == 10 and text[4] == "/" and text[7] == "/":
        try:
            parsed = datetime.strptime(text, "%Y/%m/%d").date()
            return parsed, "parsed_year_slash"
        except ValueError:
            return None, "invalid_date"

    parts = text.split("/")
    if len(parts) == 3 and len(parts[2]) == 4:
        try:
            first, second, year = (int(part) for part in parts)
            month_first = _candidate_date(year, first, second)
            day_first = _candidate_date(year, second, first)
            if month_first and day_first:
                if month_first != day_first:
                    return None, "ambiguous_slash_date"
                return month_first, "parsed_unambiguous_slash"
            if month_first:
                return month_first, "parsed_unambiguous_slash"
            if day_first:
                return day_first, "parsed_unambiguous_slash"
        except ValueError:
            pass
    return None, "invalid_date"


def _candidate_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def normalize_domestic_price(value: Any, unit: str) -> tuple[float | None, str]:
    """Convert only explicit price units to INR/tonne; unknown units are withheld."""
    parsed, status = parse_numeric(value)
    if status != "valid":
        return None, f"{status}_price"
    normalized_unit = (unit or "").strip().lower().replace(" ", "")
    if normalized_unit in {"inr/tonne", "inr/ton", "inr/t"}:
        return parsed, "verified_inr_per_tonne"
    if normalized_unit in {"inr/kg", "inr/kilogram"}:
        return parsed * 1000, "converted_inr_per_kg"
    return None, "review_required_unknown_unit"


def month_distance(earlier: date, later: date) -> int:
    return (later.year - earlier.year) * 12 + later.month - earlier.month


def add_months(value: date, months: int) -> date:
    serial = value.year * 12 + value.month - 1 + months
    year, zero_month = divmod(serial, 12)
    return date(year, zero_month + 1, 1)


def features_from_history(history: dict[date, float], target_date: date) -> list[float]:
    prior_dates = [observed for observed in history if observed < target_date]
    if not prior_dates:
        raise ValueError(f"No prior demand observation exists before {target_date.isoformat()}")
    latest_date = max(prior_dates)
    angle = 2 * math.pi * (target_date.month - 1) / 12
    return [
        float(history[latest_date]),
        float(month_distance(latest_date, target_date)),
        math.sin(angle),
        math.cos(angle),
    ]


def build_training_examples(
    observations: dict[date, float], cutoff: date,
) -> tuple[list[list[float]], list[float]]:
    """Build one-step rows strictly before cutoff using expanding past-only history."""
    past = {observed: demand for observed, demand in observations.items() if observed < cutoff}
    x_values: list[list[float]] = []
    y_values: list[float] = []
    ordered = sorted(past)
    history: dict[date, float] = {}
    for target_date in ordered:
        if history:
            x_values.append(features_from_history(history, target_date))
            y_values.append(past[target_date])
        history[target_date] = past[target_date]
    return x_values, y_values


def recursive_forecast(
    history: dict[date, float],
    target_dates: list[date],
    predict_one: Callable[[list[float]], float],
) -> dict[date, float]:
    """Predict sequentially; only each model's prior predictions extend history."""
    recursive_history = dict(history)
    forecasts: dict[date, float] = {}
    for target_date in target_dates:
        feature_row = features_from_history(recursive_history, target_date)
        prediction = float(predict_one(feature_row))
        if not math.isfinite(prediction) or prediction < 0:
            raise ValueError(f"Invalid nonnegative demand prediction for {target_date.isoformat()}: {prediction}")
        forecasts[target_date] = prediction
        recursive_history[target_date] = prediction
    return forecasts


def compute_metrics(actual: list[float], predicted: list[float]) -> dict[str, float | int | None]:
    if len(actual) != len(predicted):
        raise ValueError("Metric inputs must use identical eligible target rows")
    count = len(actual)
    if not count:
        return {"Sample_Count": 0, "MAE": None, "RMSE": None, "R2": None}
    errors = [p - y for y, p in zip(actual, predicted)]
    mae = sum(abs(error) for error in errors) / count
    rmse = math.sqrt(sum(error * error for error in errors) / count)
    mean_actual = sum(actual) / count
    total = sum((value - mean_actual) ** 2 for value in actual)
    r2 = None if count < 2 or total == 0 else 1 - sum(error * error for error in errors) / total
    return {"Sample_Count": count, "MAE": mae, "RMSE": rmse, "R2": r2}


def evaluation_target(observations: dict[date, float], target_date: date) -> tuple[float | None, bool, str]:
    if target_date not in observations:
        return None, False, "missing_target_no_imputation"
    return observations[target_date], True, "observed"


def _csv_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise ValueError(f"CSV has no header: {path}")
        rows = [dict(row) for row in reader]
        return list(reader.fieldnames), rows


def _write_csv(path: Path, columns: tuple[str, ...] | list[str], rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(columns), extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: _csv_value(row.get(key)) for key in columns})


def assert_csv_schema(path: Path, expected: tuple[str, ...]) -> None:
    actual, _ = _csv_rows(path)
    if tuple(actual) != tuple(expected):
        raise AssertionError(f"Output schema mismatch in {path.name}: {actual}")


def _csv_value(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return repr(value)
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def backup_existing_outputs(output_dir: Path, backup_root: Path) -> Path | None:
    """Copy prior output files before a run can overwrite them."""
    if not output_dir.exists():
        return None
    files = [path for path in output_dir.rglob("*") if path.is_file()]
    if not files:
        return None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    destination = backup_root / f"outputs-{stamp}"
    destination.mkdir(parents=True, exist_ok=False)
    for path in files:
        shutil.copy2(path, destination / path.relative_to(output_dir))
    return destination


def _load_mapping(path: Path) -> dict[str, str]:
    headers, rows = _csv_rows(path)
    required = {"product_variant", "canonical_product", "mapping_status"}
    missing = sorted(required - set(headers))
    if missing:
        raise ValueError(f"Product mapping is missing columns: {', '.join(missing)}")
    mapping: dict[str, str] = {}
    for row in rows:
        alias = (row.get("product_variant") or "").strip().upper()
        canonical = (row.get("canonical_product") or "").strip()
        if not alias or not canonical:
            continue
        mapping[alias] = canonical
    return mapping


def preprocess_source(source_path: Path, mapping_path: Path, config: dict[str, Any]) -> tuple[dict[str, dict[date, float]], dict[str, Any], list[dict[str, Any]]]:
    headers, raw_rows = _csv_rows(source_path)
    required = {DATE_COLUMN, PRODUCT_COLUMN, UNIT_COLUMN, TARGET_COLUMN, PRICE_COLUMN}
    missing_headers = sorted(required - set(headers))
    if missing_headers:
        raise ValueError(f"Raw dataset is missing required columns: {', '.join(missing_headers)}")

    mapping = _load_mapping(mapping_path)
    primary = {item["source_label"].strip().upper(): item for item in config["primary_series"]}
    for source_label, item in primary.items():
        expected = item["canonical"].strip()
        mapped = mapping.get(source_label)
        if mapped != expected:
            raise ValueError(f"Primary label {source_label!r} maps to {mapped!r}, expected {expected!r}")

    numeric_columns = [column for column in headers if column not in {DATE_COLUMN, PRODUCT_COLUMN, UNIT_COLUMN}]
    counts: dict[str, Any] = {
        "source_rows": len(raw_rows),
        "columns": headers,
        "schema_notes": {
            "target": "Demand_Tonnes is the forecast target, labeled tonnes; no target unit conversion is applied.",
            "quantities": "Fields ending in _Tonnes are quantities; negative quantity values are audited. Only negative Demand_Tonnes is excluded from modeling.",
            "domestic_price": "Header says INR per tonne while Price_Unit includes INR/kg. Explicit units are normalized in a separate audit-only field; unknown units are withheld.",
            "competitor_price": "Header says INR per tonne; not used as a model feature.",
            "international_price": "Header says USD per tonne; not used as a model feature.",
            "market_and_operations": "Economic, commodity, weather, capacity, logistics, and promotion fields are present, but excluded because forecast-time availability is not established.",
        },
        "date_status_counts": Counter(),
        "missing_numeric_by_column": Counter(),
        "invalid_numeric_by_column": Counter(),
        "negative_quantity_by_column": Counter(),
        "unit_status_counts": Counter(),
        "raw_unit_counts": Counter(),
        "exact_duplicate_rows": 0,
        "duplicate_raw_date_product_key_rows": 0,
        "unmapped_product_labels": set(),
        "alias_rows_not_merged": 0,
        "alias_rows_by_variant": Counter(),
        "target_exclusion_counts": Counter(),
    }
    exact_first: dict[tuple[str, ...], int] = {}
    raw_key_counts: Counter[tuple[str, str]] = Counter()
    audit_rows: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []

    for index, row in enumerate(raw_rows, start=2):
        source_label = (row.get(PRODUCT_COLUMN) or "").strip()
        normalized_label = source_label.upper()
        canonical = mapping.get(normalized_label)
        if source_label and canonical is None:
            counts["unmapped_product_labels"].add(source_label)
        is_primary = normalized_label in primary
        if canonical and not is_primary:
            counts["alias_rows_not_merged"] += 1
            counts["alias_rows_by_variant"][source_label] += 1

        parsed_date, date_status = parse_source_date(row.get(DATE_COLUMN) or "")
        counts["date_status_counts"][date_status] += 1
        raw_key_counts[((row.get(DATE_COLUMN) or "").strip(), normalized_label)] += 1

        cell_status: dict[str, tuple[float | None, str]] = {}
        missing_fields: list[str] = []
        invalid_fields: list[str] = []
        negative_quantities: list[str] = []
        for column in numeric_columns:
            value, status = parse_numeric(row.get(column))
            cell_status[column] = (value, status)
            if status == "missing":
                counts["missing_numeric_by_column"][column] += 1
                missing_fields.append(column)
            elif status == "invalid":
                counts["invalid_numeric_by_column"][column] += 1
                invalid_fields.append(column)
            if column in QUANTITY_COLUMNS and value is not None and value < 0:
                counts["negative_quantity_by_column"][column] += 1
                negative_quantities.append(column)

        unit = (row.get(UNIT_COLUMN) or "").strip()
        counts["raw_unit_counts"][unit or "<blank>"] += 1
        normalized_price, price_unit_status = normalize_domestic_price(row.get(PRICE_COLUMN), unit)
        counts["unit_status_counts"][price_unit_status] += 1

        exact_key = tuple((row.get(column) or "") for column in headers)
        duplicate_of = exact_first.get(exact_key)
        if duplicate_of is None:
            exact_first[exact_key] = index
        else:
            counts["exact_duplicate_rows"] += 1

        target, target_status = cell_status[TARGET_COLUMN]
        exclusion: list[str] = []
        if not is_primary:
            exclusion.append("alias_not_merged_or_not_primary_series")
        if duplicate_of is not None:
            exclusion.append(f"exact_duplicate_of_row_{duplicate_of}")
        if parsed_date is None:
            exclusion.append(date_status)
        if target_status != "valid":
            exclusion.append(f"target_{target_status}")
        elif target is not None and target < 0:
            exclusion.append("negative_target")
        if parsed_date is not None and parsed_date.day != 1:
            # Month-year observations are monthly; retain their month but audit original day.
            pass

        audit = {
            "Source_Row": index,
            "Raw_Product": source_label,
            "Canonical_Product": canonical or "",
            "Series_Selection": "primary_exact_label" if is_primary else ("alias_not_merged" if canonical else "unmapped"),
            "Raw_Date": row.get(DATE_COLUMN, ""),
            "Parsed_Date": parsed_date.isoformat() if parsed_date else "",
            "Date_Status": date_status,
            "Price_Unit_Raw": unit,
            "Price_Unit_Status": price_unit_status,
            "Domestic_Price_Raw": row.get(PRICE_COLUMN, ""),
            "Domestic_Price_INR_per_Tonne_Audit_Only": normalized_price,
            "Missing_Numeric_Fields": ";".join(missing_fields),
            "Invalid_Numeric_Fields": ";".join(invalid_fields),
            "Negative_Quantity_Fields": ";".join(negative_quantities),
            "Exact_Duplicate_Of_Row": duplicate_of or "",
            "Modeling_Status": "eligible_candidate" if not exclusion else "excluded",
            "Modeling_Exclusion_Reasons": ";".join(exclusion),
        }
        audit_rows.append(audit)
        if not exclusion:
            candidates.append({"audit": audit, "date": date(parsed_date.year, parsed_date.month, 1), "target": float(target)})
        for reason in exclusion:
            counts["target_exclusion_counts"][reason.split("_of_row_")[0]] += 1

    # Preserve every source row in the audit. Exclude all non-identical collisions
    # after month normalization rather than aggregating them silently.
    by_month: dict[tuple[str, date], list[dict[str, Any]]] = defaultdict(list)
    for candidate in candidates:
        by_month[(candidate["audit"]["Raw_Product"].strip().upper(), candidate["date"])].append(candidate)
    series: dict[str, dict[date, float]] = {label: {} for label in primary}
    for (label, target_date), grouped in by_month.items():
        if len(grouped) > 1:
            for candidate in grouped:
                candidate["audit"]["Modeling_Status"] = "excluded"
                candidate["audit"]["Modeling_Exclusion_Reasons"] = "duplicate_product_month_after_date_parse"
                counts["target_exclusion_counts"]["duplicate_product_month_after_date_parse"] += 1
            continue
        series[label][target_date] = grouped[0]["target"]

    raw_key_repeats = sum(count - 1 for count in raw_key_counts.values())
    counts["duplicate_raw_date_product_key_rows"] = raw_key_repeats
    counts["unmapped_product_labels"] = sorted(counts["unmapped_product_labels"])
    counts["date_status_counts"] = dict(counts["date_status_counts"])
    counts["missing_numeric_by_column"] = dict(counts["missing_numeric_by_column"])
    counts["invalid_numeric_by_column"] = dict(counts["invalid_numeric_by_column"])
    counts["negative_quantity_by_column"] = dict(counts["negative_quantity_by_column"])
    counts["unit_status_counts"] = dict(counts["unit_status_counts"])
    counts["raw_unit_counts"] = dict(counts["raw_unit_counts"])
    counts["target_exclusion_counts"] = dict(counts["target_exclusion_counts"])
    counts["alias_rows_by_variant"] = dict(counts["alias_rows_by_variant"])
    counts["domain_confirmation_aliases"] = sorted(counts["alias_rows_by_variant"])
    counts["modeled_series"] = {
        item["canonical"]: {
            "source_label": item["source_label"],
            "valid_month_observations": len(series[item["source_label"].strip().upper()]),
            "first_month": min(series[item["source_label"].strip().upper()]).isoformat() if series[item["source_label"].strip().upper()] else None,
            "last_month": max(series[item["source_label"].strip().upper()]).isoformat() if series[item["source_label"].strip().upper()] else None,
        }
        for item in config["primary_series"]
    }
    counts["modeling_target_rows"] = sum(len(values) for values in series.values())
    counts["row_level_audit_rows"] = len(audit_rows)
    return series, counts, audit_rows


def _fit_random_forest(x_values: list[list[float]], y_values: list[float], params: dict[str, Any]):
    if len(y_values) < 2:
        raise ValueError("Insufficient supervised history to fit Random Forest")
    try:
        from sklearn.ensemble import RandomForestRegressor
    except ImportError as exc:
        raise RuntimeError("scikit-learn is required; install with `python -m pip install -r requirements.txt`") from exc
    model = RandomForestRegressor(**params)
    model.fit(x_values, y_values)
    return model


def _series_name(config: dict[str, Any], source_label: str) -> str:
    return next(item["canonical"] for item in config["primary_series"] if item["source_label"].strip().upper() == source_label)


def _prepare_model(history: dict[date, float], cutoff: date, config: dict[str, Any]):
    x_values, y_values = build_training_examples(history, cutoff)
    minimum = int(config["minimum_history_observations"])
    if len(history) < minimum or len(y_values) < minimum - 1:
        raise ValueError(f"History before {cutoff.isoformat()} is below configured minimum {minimum}")
    model = _fit_random_forest(x_values, y_values, config["random_forest"])
    return model, len(y_values)


def _fold_rows(series: dict[str, dict[date, float]], config: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    horizon = int(config["evaluation_horizon_months"])
    for origin_text in config["evaluation_origins"]:
        origin = date.fromisoformat(origin_text)
        target_dates = [add_months(origin, step) for step in range(horizon)]
        for source_label, observations in series.items():
            history = {observed: value for observed, value in observations.items() if observed < origin}
            model, train_count = _prepare_model(history, origin, config)
            latest_observed = max(history)
            naive_anchor = history[latest_observed]
            forest = recursive_forecast(history, target_dates, lambda features: model.predict([features])[0])
            canonical = _series_name(config, source_label)
            for step, target_date in enumerate(target_dates, start=1):
                actual, eligible, target_status = evaluation_target(observations, target_date)
                rows.append({
                    "Fold": origin_text[:7],
                    "Training_Cutoff": origin.isoformat(),
                    "Date": target_date.isoformat(),
                    "Horizon_Month": step,
                    "Product": source_label,
                    "Canonical_Product": canonical,
                    "Actual_Demand_Tonnes": actual,
                    "Naive_Prediction_Tonnes": naive_anchor,
                    "Random_Forest_Prediction_Tonnes": forest[target_date],
                    "Eligible_For_Metrics": eligible,
                    "Target_Status": target_status,
                    "Training_Sample_Count": train_count,
                })
    return rows


def _metric_rows(predictions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    groups: list[tuple[str, str, list[dict[str, Any]]]] = []
    for fold in sorted({row["Fold"] for row in predictions}):
        fold_rows = [row for row in predictions if row["Fold"] == fold and row["Eligible_For_Metrics"]]
        groups.append((fold, "ALL", fold_rows))
        for product in sorted({row["Product"] for row in fold_rows}):
            groups.append((fold, product, [row for row in fold_rows if row["Product"] == product]))
    eligible_all = [row for row in predictions if row["Eligible_For_Metrics"]]
    groups.append(("ALL_FOLDS", "ALL", eligible_all))
    for product in sorted({row["Product"] for row in eligible_all}):
        groups.append(("ALL_FOLDS", product, [row for row in eligible_all if row["Product"] == product]))

    for fold, product, group in groups:
        actual = [float(row["Actual_Demand_Tonnes"]) for row in group]
        for model_name, field in (
            ("Naive_Last_Observed", "Naive_Prediction_Tonnes"),
            ("Random_Forest_Recursive", "Random_Forest_Prediction_Tonnes"),
        ):
            metric = compute_metrics(actual, [float(row[field]) for row in group])
            output.append({"Fold": fold, "Model": model_name, "Product": product, **metric})
    return output


def _future_rows(series: dict[str, dict[date, float]], config: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
    all_dates = [observed for observations in series.values() for observed in observations]
    if not all_dates:
        raise ValueError("No valid modeling targets remain")
    cutoff = max(all_dates)
    future_dates = [add_months(cutoff, step) for step in range(1, int(config["future_horizon_months"]) + 1)]
    rows: list[dict[str, Any]] = []
    for source_label, observations in series.items():
        latest = max(observations)
        if latest != cutoff:
            raise ValueError(f"{source_label} ends at {latest}, earlier than common forecast cutoff {cutoff}; refusing stale-history forecast")
        model, _ = _prepare_model(observations, add_months(cutoff, 1), config)
        forest = recursive_forecast(observations, future_dates, lambda features: model.predict([features])[0])
        naive_anchor = observations[latest]
        canonical = _series_name(config, source_label)
        for step, target_date in enumerate(future_dates, start=1):
            rows.append({
                "As_Of_Date": cutoff.isoformat(),
                "Date": target_date.isoformat(),
                "Horizon_Month": step,
                "Product": source_label,
                "Canonical_Product": canonical,
                "Naive_Prediction_Tonnes": naive_anchor,
                "Random_Forest_Prediction_Tonnes": forest[target_date],
                "Synthetic_Data_Label": "SYNTHETIC_DEMO_ONLY_NOT_MARKET_FORECAST",
            })
    return rows, cutoff.isoformat()


def _audit_markdown(audit: dict[str, Any], source_path: Path) -> str:
    missing = audit["missing_numeric_by_column"]
    negative = audit["negative_quantity_by_column"]
    status = audit["date_status_counts"]
    units = audit["unit_status_counts"]
    return "\n".join([
        "# Replacement pipeline source audit",
        "",
        "This report describes the source CSV as read by the new replacement pipeline. It does not describe or reproduce the missing original notebook.",
        "",
        f"- Source: `{source_path}`",
        f"- Rows / columns: {audit['source_rows']} / {len(audit['columns'])}",
        f"- Schema notes: `{json.dumps(audit['schema_notes'], sort_keys=True)}`",
        f"- Raw date status counts: `{json.dumps(status, sort_keys=True)}`",
        f"- Exact duplicate rows: {audit['exact_duplicate_rows']}",
        f"- Repeated raw date/product keys: {audit['duplicate_raw_date_product_key_rows']} extra rows",
        f"- Price unit status counts: `{json.dumps(units, sort_keys=True)}`",
        f"- Missing / invalid numeric cells by column: `{json.dumps(missing, sort_keys=True)}` / `{json.dumps(audit['invalid_numeric_by_column'], sort_keys=True)}`",
        f"- Negative quantity cells by column: `{json.dumps(negative, sort_keys=True)}`",
        f"- Unmapped labels: `{audit['unmapped_product_labels']}`",
        f"- Alias rows retained in audit but not merged into model series: {audit['alias_rows_not_merged']}",
        f"- Alias labels requiring domain confirmation: `{audit['domain_confirmation_aliases']}`",
        f"- Modeling target rows after exclusions: {audit['modeling_target_rows']}",
        "",
        "## Rules",
        "",
        "- Ambiguous slash dates are retained in the row-level audit and excluded from modeling; no month/day ordering is guessed.",
        "- Exact duplicate source rows remain in the audit; repeated copies are excluded from modeling. Distinct rows colliding within a product-month are all excluded rather than averaged.",
        "- Blank/place-holder/invalid targets and negative demand are not imputed. Non-target negative quantity cells are flagged but not used as model features.",
        "- Domestic price normalization in the audit converts only explicit INR/kg or INR/tonne labels. Prices are not used for training or recommendations.",
        "- Product aliases are retained and tagged with the Phase 1 canonical mapping, but only the explicit primary source label per family is modeled. No aliases are merged.",
        "- Dataset provenance is not supplied. Treat all records and resulting forecasts as synthetic demonstration data.",
        "",
    ])


def _resolve_inside_pipeline(value: str, base: Path) -> Path:
    path = (base / value).resolve() if not Path(value).is_absolute() else Path(value).resolve()
    try:
        path.relative_to(PIPELINE_DIR)
    except ValueError as exc:
        raise ValueError(f"Output path must stay inside {PIPELINE_DIR}") from exc
    return path


def run_pipeline(config_path: Path = DEFAULT_CONFIG, source_override: Path | None = None, output_override: str | None = None) -> dict[str, Any]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    source_path = (PIPELINE_DIR / config["source_csv"]).resolve()
    mapping_path = (PIPELINE_DIR / config["product_mapping_csv"]).resolve()
    if source_override:
        source_path = source_override.resolve()
    output_dir = _resolve_inside_pipeline(output_override or config["output_dir"], PIPELINE_DIR)
    if not source_path.is_file():
        raise FileNotFoundError(f"Raw source CSV not found: {source_path}")
    if not mapping_path.is_file():
        raise FileNotFoundError(f"Reviewed product mapping not found: {mapping_path}")

    backup = backup_existing_outputs(output_dir, PIPELINE_DIR / "backups")
    series, audit, audit_rows = preprocess_source(source_path, mapping_path, config)
    prediction_rows = _fold_rows(series, config)
    metric_rows = _metric_rows(prediction_rows)
    future_rows, future_cutoff = _future_rows(series, config)

    # Evaluation targets are defined from the target stream, not either model's
    # prediction. Both models must therefore score exactly the same eligible rows.
    eligible_keys = {(r["Fold"], r["Date"], r["Product"]) for r in prediction_rows if r["Eligible_For_Metrics"]}
    if len(eligible_keys) != sum(bool(r["Eligible_For_Metrics"]) for r in prediction_rows):
        raise AssertionError("Evaluation predictions contain duplicate eligible product/date rows")
    audit["evaluation_rows"] = len(prediction_rows)
    audit["evaluation_eligible_target_rows"] = len(eligible_keys)
    audit["future_forecast_rows"] = len(future_rows)
    audit["future_as_of_date"] = future_cutoff
    audit["evaluation_origins"] = config["evaluation_origins"]
    audit["evaluation_horizon_months"] = config["evaluation_horizon_months"]

    output_dir.mkdir(parents=True, exist_ok=True)
    _write_csv(output_dir / "preprocessing_audit.csv", [
        "Source_Row", "Raw_Product", "Canonical_Product", "Series_Selection",
        "Raw_Date", "Parsed_Date", "Date_Status", "Price_Unit_Raw",
        "Price_Unit_Status", "Domestic_Price_Raw", "Domestic_Price_INR_per_Tonne_Audit_Only",
        "Missing_Numeric_Fields", "Invalid_Numeric_Fields", "Negative_Quantity_Fields",
        "Exact_Duplicate_Of_Row", "Modeling_Status", "Modeling_Exclusion_Reasons",
    ], audit_rows)
    _write_csv(output_dir / "evaluation_predictions.csv", EVALUATION_COLUMNS, prediction_rows)
    _write_csv(output_dir / "evaluation_metrics.csv", METRIC_COLUMNS, metric_rows)
    _write_csv(output_dir / "future_forecasts.csv", FUTURE_COLUMNS, future_rows)
    assert_csv_schema(output_dir / "evaluation_predictions.csv", EVALUATION_COLUMNS)
    assert_csv_schema(output_dir / "evaluation_metrics.csv", METRIC_COLUMNS)
    assert_csv_schema(output_dir / "future_forecasts.csv", FUTURE_COLUMNS)
    (output_dir / "data_audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True), encoding="utf-8")
    (output_dir / "data_audit.md").write_text(_audit_markdown(audit, source_path), encoding="utf-8")
    manifest = {
        "pipeline_name": "PetroVision replacement synthetic demand forecast",
        "methodology_status": "new_replacement_not_recovered_original",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_path": str(source_path),
        "source_sha256": _sha256(source_path),
        "mapping_path": str(mapping_path),
        "mapping_sha256": _sha256(mapping_path),
        "source_rows": audit["source_rows"],
        "data_as_of_date": future_cutoff,
        "evaluation": {
            "strategy": "two non-overlapping fixed-origin recursive six-month folds",
            "origins": config["evaluation_origins"],
            "training_rule": "training targets strictly earlier than each origin",
            "horizon_months": config["evaluation_horizon_months"],
            "aggregate_metric_definition": "pooled micro metrics across all eligible product-month targets; aggregate R2 can be dominated by between-product level differences",
            "prediction_rows": len(prediction_rows),
            "eligible_targets": len(eligible_keys),
            "metrics_file": "evaluation_metrics.csv",
            "combined_metrics": [
                row for row in metric_rows if row["Fold"] == "ALL_FOLDS" and row["Product"] == "ALL"
            ],
        },
        "future_forecast": {
            "as_of_date": future_cutoff,
            "dates": sorted({row["Date"] for row in future_rows}),
            "horizon_months": config["future_horizon_months"],
            "rows": len(future_rows),
        },
        "model": {
            "comparison": ["Naive_Last_Observed", "Random_Forest_Recursive"],
            "random_forest_parameters": config["random_forest"],
            "features": config["model_features"],
            "excluded_features": config["excluded_model_features"],
            "recursive_strategy": "only prior observations before origin, then prior predictions; held-out actuals are not fed back",
            "minimum_history_observations": config["minimum_history_observations"],
        },
        "runtime": {
            "python_version": sys.version.split()[0],
            "scikit_learn_version": importlib.metadata.version("scikit-learn"),
        },
        "assumptions_and_limitations": [
            "Synthetic/demo data only; source provenance is unavailable.",
            "Reviewed aliases are not merged; only configured primary source labels are modeled.",
            "Ambiguous slash dates and invalid targets are audited and excluded, never guessed or imputed.",
            "Pricing and exogenous market features are not used; their future availability is unverified.",
            "R2 is blank when a metric group has fewer than two samples or zero actual variance.",
            "This is a new replacement methodology, not the original model or an assertion of model validity.",
        ],
        "output_files": [
            "preprocessing_audit.csv", "data_audit.json", "data_audit.md",
            "evaluation_predictions.csv", "evaluation_metrics.csv", "future_forecasts.csv",
        ],
        "backed_up_previous_outputs_to": str(backup) if backup else None,
    }
    (output_dir / "run_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return {"audit": audit, "metrics": metric_rows, "future_rows": len(future_rows), "backup": str(backup) if backup else None}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--source", type=Path, help="Optional raw CSV override (read-only input).")
    parser.add_argument("--output", help="Output directory relative to this folder; cannot escape replacement_pipeline.")
    args = parser.parse_args()
    try:
        result = run_pipeline(args.config.resolve(), args.source, args.output)
    except Exception as exc:
        print(f"Pipeline failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({
        "source_rows": result["audit"]["source_rows"],
        "eligible_evaluation_targets": result["audit"]["evaluation_eligible_target_rows"],
        "evaluation_prediction_rows": result["audit"]["evaluation_rows"],
        "future_forecast_rows": result["future_rows"],
        "future_as_of_date": result["audit"]["future_as_of_date"],
        "previous_output_backup": result["backup"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
