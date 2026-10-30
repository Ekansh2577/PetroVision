# Replacement pipeline source audit

This report describes the source CSV as read by the new replacement pipeline. It does not describe or reproduce the missing original notebook.

- Source: `C:\Users\ekans\OneDrive\Desktop\HCL-Tech Project\petrochemical-dashboard\public\data\Petrochemical_Raw_Messy_Dataset_Large.csv`
- Rows / columns: 3200 / 38
- Schema notes: `{"competitor_price": "Header says INR per tonne; not used as a model feature.", "domestic_price": "Header says INR per tonne while Price_Unit includes INR/kg. Explicit units are normalized in a separate audit-only field; unknown units are withheld.", "international_price": "Header says USD per tonne; not used as a model feature.", "market_and_operations": "Economic, commodity, weather, capacity, logistics, and promotion fields are present, but excluded because forecast-time availability is not established.", "quantities": "Fields ending in _Tonnes are quantities; negative quantity values are audited. Only negative Demand_Tonnes is excluded from modeling.", "target": "Demand_Tonnes is the forecast target, labeled tonnes; no target unit conversion is applied."}`
- Raw date status counts: `{"ambiguous_slash_date": 52, "parsed_day_month_name": 45, "parsed_iso": 3015, "parsed_month_year": 46, "parsed_unambiguous_slash": 3, "parsed_year_slash": 39}`
- Exact duplicate rows: 80
- Repeated raw date/product keys: 80 extra rows
- Price unit status counts: `{"converted_inr_per_kg": 104, "verified_inr_per_tonne": 3096}`
- Missing / invalid numeric cells by column: `{"Competitor_Price_INR_per_Tonne": 49, "Construction_Activity_Index": 47, "Crude_Oil_USD_per_Barrel": 46, "Electricity_Cost_INR_per_kWh": 45, "Ethylene_USD_per_Tonne": 45, "Export_Tonnes": 48, "Freight_USD_per_Tonne": 47, "Humidity_Percent": 47, "Import_Tonnes": 47, "Installed_Capacity_Tonnes": 45, "International_Price_USD_per_Tonne": 46, "Naphtha_USD_per_Tonne": 46, "Natural_Gas_USD_per_MMBtu": 46, "Order_Backlog_Tonnes": 46, "Packaging_Demand_Index": 45, "Port_Congestion_Index": 45, "Propylene_USD_per_Tonne": 46, "Rainfall_mm": 45, "Sales_Volume_Tonnes": 46, "Seasonal_Promotion_Flag": 46, "Supplier_Lead_Time_Days": 45, "Temperature_C": 46, "USD_INR": 45, "WPI_Index": 46}` / `{"Demand_Tonnes": 1, "Export_Tonnes": 1, "Import_Tonnes": 1, "Inventory_Tonnes": 1, "Production_Tonnes": 1}`
- Negative quantity cells by column: `{"Demand_Tonnes": 1, "Export_Tonnes": 1, "Import_Tonnes": 1, "Inventory_Tonnes": 1, "Production_Tonnes": 1}`
- Unmapped labels: `[]`
- Alias rows retained in audit but not merged into model series: 59
- Modeling target rows after exclusions: 3010

## Rules

- Ambiguous slash dates are retained in the row-level audit and excluded from modeling; no month/day ordering is guessed.
- Exact duplicate source rows remain in the audit; repeated copies are excluded from modeling. Distinct rows colliding within a product-month are all excluded rather than averaged.
- Blank/place-holder/invalid targets and negative demand are not imputed. Non-target negative quantity cells are flagged but not used as model features.
- Domestic price normalization in the audit converts only explicit INR/kg or INR/tonne labels. Prices are not used for training or recommendations.
- Product aliases are retained and tagged with the Phase 1 canonical mapping, but only the explicit primary source label per family is modeled. No aliases are merged.
- Dataset provenance is not supplied. Treat all records and resulting forecasts as synthetic demonstration data.
