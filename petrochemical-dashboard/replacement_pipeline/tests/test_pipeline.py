from __future__ import annotations

import sys
import csv
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline import (  # noqa: E402
    EVALUATION_COLUMNS,
    FUTURE_COLUMNS,
    METRIC_COLUMNS,
    add_months,
    assert_csv_schema,
    build_training_examples,
    compute_metrics,
    evaluation_target,
    normalize_domestic_price,
    parse_numeric,
    parse_source_date,
    preprocess_source,
    recursive_forecast,
    _csv_value,
)


class DateAndUnitTests(unittest.TestCase):
    def test_ambiguous_slash_dates_are_unresolved(self):
        parsed, status = parse_source_date("01/11/2024")
        self.assertIsNone(parsed)
        self.assertEqual(status, "ambiguous_slash_date")

    def test_same_day_month_slash_date_is_unambiguous(self):
        parsed, status = parse_source_date("01/01/2024")
        self.assertEqual(parsed, date(2024, 1, 1))
        self.assertEqual(status, "parsed_unambiguous_slash")

    def test_supported_dates_and_invalid_dates(self):
        self.assertEqual(parse_source_date("2025-12-01"), (date(2025, 12, 1), "parsed_iso"))
        self.assertEqual(parse_source_date("Feb-2007"), (date(2007, 2, 1), "parsed_month_year"))
        self.assertEqual(parse_source_date("01-Oct-07"), (date(2007, 10, 1), "parsed_day_month_name"))
        self.assertEqual(parse_source_date("2021/02/01"), (date(2021, 2, 1), "parsed_year_slash"))
        self.assertEqual(parse_source_date("2025-02-30"), (None, "invalid_date"))

    def test_units_convert_only_when_explicit(self):
        self.assertEqual(normalize_domestic_price("78.47", "INR/kg"), (78470.0, "converted_inr_per_kg"))
        self.assertEqual(normalize_domestic_price("81525.39", "INR/tonne"), (81525.39, "verified_inr_per_tonne"))
        self.assertEqual(normalize_domestic_price("120", "unknown"), (None, "review_required_unknown_unit"))
        self.assertEqual(normalize_domestic_price("", "INR/kg"), (None, "missing_price"))

    def test_preprocessing_preserves_and_flags_rows_without_imputation_or_alias_merge(self):
        columns = ["Date", "Product", "Demand_Tonnes", "Domestic_Price_INR_per_Tonne", "Price_Unit"]
        rows = [
            ["2025-01-01", "ABS", "10", "100", "INR/tonne"],
            ["2025-01-01", "ABS", "10", "100", "INR/tonne"],  # exact duplicate
            ["01/02/2025", "ABS", "20", "20", "INR/kg"],  # ambiguous date, explicit unit
            ["2025-03-01", "ABS", "", "100", "INR/tonne"],  # missing target
            ["2025-04-01", "ABS", "-3", "100", "INR/tonne"],  # negative target
            ["2025-05-01", "A.B.S.", "12", "100", "INR/tonne"],  # mapped alias, not merged
        ]
        with tempfile.TemporaryDirectory() as temp_name:
            temp = Path(temp_name)
            source = temp / "raw.csv"
            mapping = temp / "mapping.csv"
            with source.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(columns)
                writer.writerows(rows)
            with mapping.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(["product_variant", "canonical_product", "mapping_status"])
                writer.writerow(["ABS", "ABS", "reviewed_alias"])
                writer.writerow(["A.B.S.", "ABS", "reviewed_alias"])
            config = {
                "primary_series": [{"canonical": "ABS", "source_label": "ABS"}],
            }
            series, audit, audit_rows = preprocess_source(source, mapping, config)

        self.assertEqual(audit["source_rows"], 6)
        self.assertEqual(len(audit_rows), 6)
        self.assertEqual(audit["exact_duplicate_rows"], 1)
        self.assertEqual(audit_rows[2]["Date_Status"], "ambiguous_slash_date")
        self.assertEqual(audit_rows[2]["Domestic_Price_INR_per_Tonne_Audit_Only"], 20000)
        self.assertEqual(audit_rows[3]["Modeling_Exclusion_Reasons"], "target_missing")
        self.assertEqual(audit_rows[4]["Modeling_Exclusion_Reasons"], "negative_target")
        self.assertEqual(audit_rows[5]["Series_Selection"], "alias_not_merged")
        self.assertEqual(series["ABS"], {date(2025, 1, 1): 10.0})


class SplitAndLeakageTests(unittest.TestCase):
    def test_training_targets_are_strictly_before_cutoff(self):
        data = {
            date(2024, 11, 1): 10.0,
            date(2024, 12, 1): 11.0,
            date(2025, 1, 1): 900.0,
            date(2025, 2, 1): 901.0,
        }
        x_values, y_values = build_training_examples(data, date(2025, 1, 1))
        self.assertEqual(y_values, [11.0])
        self.assertEqual(len(x_values), 1)

    def test_six_month_origins_have_expected_boundaries(self):
        january = date(2025, 1, 1)
        july = date(2025, 7, 1)
        self.assertEqual([add_months(january, step) for step in range(6)][-1], date(2025, 6, 1))
        self.assertEqual([add_months(july, step) for step in range(6)][-1], date(2025, 12, 1))
        self.assertEqual(add_months(date(2025, 12, 1), 6), date(2026, 6, 1))

    def test_recursive_forecast_uses_prior_prediction_not_held_out_actual(self):
        history = {date(2025, 6, 1): 100.0}
        observed_feature_values = []

        def predictor(features):
            observed_feature_values.append(features[0])
            return features[0] + 1

        predictions = recursive_forecast(
            history,
            [date(2025, 7, 1), date(2025, 8, 1)],
            predictor,
        )
        self.assertEqual(observed_feature_values, [100.0, 101.0])
        self.assertEqual(predictions[date(2025, 8, 1)], 102.0)
        self.assertEqual(history, {date(2025, 6, 1): 100.0})

    def test_missing_target_is_not_imputed_or_metric_eligible(self):
        actual, eligible, status = evaluation_target({}, date(2025, 9, 1))
        self.assertIsNone(actual)
        self.assertFalse(eligible)
        self.assertEqual(status, "missing_target_no_imputation")
        actual, eligible, status = evaluation_target({date(2025, 9, 1): 42.0}, date(2025, 9, 1))
        self.assertEqual((actual, eligible, status), (42.0, True, "observed"))

    def test_metric_inputs_must_share_same_eligible_rows(self):
        with self.assertRaises(ValueError):
            compute_metrics([1.0, 2.0], [1.0])


class OutputContractTests(unittest.TestCase):
    def test_output_schemas_are_explicit_and_distinct(self):
        self.assertIn("Eligible_For_Metrics", EVALUATION_COLUMNS)
        self.assertIn("Training_Cutoff", EVALUATION_COLUMNS)
        self.assertIn("Sample_Count", METRIC_COLUMNS)
        self.assertIn("R2", METRIC_COLUMNS)
        self.assertIn("As_Of_Date", FUTURE_COLUMNS)
        self.assertIn("Synthetic_Data_Label", FUTURE_COLUMNS)
        self.assertNotIn("Actual_Demand_Tonnes", FUTURE_COLUMNS)

    def test_written_csv_schema_is_checked_against_contract(self):
        with tempfile.TemporaryDirectory() as temp_name:
            path = Path(temp_name) / "metrics.csv"
            path.write_text("Fold,Model,Product,Sample_Count,MAE,RMSE,R2\n", encoding="utf-8")
            assert_csv_schema(path, METRIC_COLUMNS)
            path.write_text("Fold,Model,Product\n", encoding="utf-8")
            with self.assertRaises(AssertionError):
                assert_csv_schema(path, METRIC_COLUMNS)

    def test_csv_float_serialization_round_trips(self):
        value = 0.12345678901234566
        self.assertEqual(float(_csv_value(value)), value)

    def test_blank_numeric_is_not_zero(self):
        self.assertEqual(parse_numeric("0"), (0.0, "valid"))
        self.assertEqual(parse_numeric("unknown"), (None, "missing"))
        self.assertEqual(parse_numeric("check"), (None, "invalid"))
        self.assertEqual(parse_numeric(""), (None, "missing"))


if __name__ == "__main__":
    unittest.main()
