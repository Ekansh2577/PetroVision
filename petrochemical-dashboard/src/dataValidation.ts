export function parseNumericCell(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function findMissingHeaders(actual: string[], required: string[]): string[] {
  const present = new Set(actual);
  return required.filter((header) => !present.has(header));
}

export function monthFromIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    month < 1 || month > 12 || day < 1 ||
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
  ) return null;
  return `${match[1]}-${match[2]}`;
}

export function latestMonthFromDates(dates: string[]): string | null {
  const months = dates.map(monthFromIsoDate).filter((month): month is string => month !== null);
  return months.length ? months.sort().at(-1)! : null;
}

export function rowsAfterMonth<T>(
  rows: T[],
  cutoffMonth: string | null,
  getDate: (row: T) => unknown,
): T[] {
  if (!cutoffMonth) return [];
  return rows.filter((row) => {
    const month = monthFromIsoDate(getDate(row));
    return month !== null && month > cutoffMonth;
  });
}
