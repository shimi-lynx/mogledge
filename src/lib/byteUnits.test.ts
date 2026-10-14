import { expect, test } from "vite-plus/test";
import { exactByteAmount, formatBytes, parseByteAmount } from "./byteUnits";

test("decimal units preserve bytes and reject fractions or unsafe integers", () => {
  expect(formatBytes(1000, "en")).toBe("1 KB");
  expect(parseByteAmount("1.048576", "MB")).toBe(1048576);
  expect(parseByteAmount("0.000000001", "GB")).toBe(1);
  for (const value of ["-1", "NaN", "1e3", "", "1.0001"])
    expect(parseByteAmount(value, "B")).toBeNull();
  expect(parseByteAmount("9007199254740992", "B")).toBeNull();
  for (const bytes of [1, 1000, 5242880, 536870912, Number.MAX_SAFE_INTEGER])
    for (const unit of ["B", "KB", "MB", "GB"] as const)
      expect(parseByteAmount(exactByteAmount(bytes, unit), unit)).toBe(bytes);
});
