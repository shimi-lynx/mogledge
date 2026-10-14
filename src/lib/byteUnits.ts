export const byteUnits = ["B", "KB", "MB", "GB"] as const;
export type ByteUnit = (typeof byteUnits)[number];
const factors: Record<ByteUnit, bigint> = { B: 1n, KB: 1000n, MB: 1000000n, GB: 1000000000n };

export function parseByteAmount(value: string, unit: ByteUnit): number | null {
  if (value.length > 32 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const scaled = BigInt(whole + fraction) * factors[unit];
  // Reject fractional bytes instead of silently rounding a quota.
  if (scaled % denominator !== 0n) return null;
  const bytes = scaled / denominator;
  return bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null;
}

export function exactByteAmount(bytes: number, unit: ByteUnit): string {
  const value = BigInt(bytes),
    factor = factors[unit];
  const remainder = value % factor;
  const fraction = remainder
    .toString()
    .padStart(factor.toString().length - 1, "0")
    .replace(/0+$/, "");
  return `${value / factor}${fraction ? `.${fraction}` : ""}`;
}

export function formatBytes(bytes: number, language: string): string {
  const unit = [...byteUnits].reverse().find((value) => bytes >= Number(factors[value])) ?? "B";
  return `${(bytes / Number(factors[unit])).toLocaleString(language, { maximumFractionDigits: 3 })} ${unit}`;
}
