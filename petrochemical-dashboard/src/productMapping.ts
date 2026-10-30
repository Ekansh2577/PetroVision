/** Reviewed aliases for the synthetic dataset's ten resin product families. */
const reviewedAliases: Record<string, string> = {
  "A.B.S.": "ABS",
  "ABS": "ABS",
  "ABS RESIN": "ABS",
  "ETHYLENE VINYL ACETATE (EVA)": "EVA",
  "ETHYLENE-VINYL ACETATE": "EVA",
  "EVA": "EVA",
  "HDPE": "HDPE",
  "HIGH DENSITY POLYETHYLENE": "HDPE",
  "LDPE": "LDPE",
  "LOW DENSITY POLYETHYLENE": "LDPE",
  "LLDPE": "LLDPE",
  "LINEAR LOW DENSITY PE": "LLDPE",
  "P.E.T.": "PET",
  "PET": "PET",
  "PET RESIN": "PET",
  "P.V.C.": "PVC",
  "PVC": "PVC",
  "PC": "PC",
  "POLY CARBONATE": "PC",
  "POLYCARBONATE": "PC",
  "POLYCARBONATE (PC)": "PC",
  "POLYPROPYLENE": "PP",
  "POLYPROPYLENE (PP)": "PP",
  "PP": "PP",
  "POLYSTYRENE": "PS",
  "POLYSTYRENE (PS)": "PS",
  "PS": "PS",
};

export const canonicalProduct = (value: string): string | null =>
  reviewedAliases[value.trim().toUpperCase()] ?? null;

export const canonicalProducts = [...new Set(Object.values(reviewedAliases))].sort();

export const reviewedProductAliases = Object.entries(reviewedAliases).map(
  ([alias, canonical]) => ({ alias, canonical }),
);
