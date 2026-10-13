import { expect, it } from "vite-plus/test";
import {
  ARTIFACT_MAX_BYTES,
  artifactProposal,
  artifactBytes,
  artifactError,
  artifactErrorCode,
} from "./artifactExport";
it("bounds canonical base64 before decode, includes exact 5MiB and rejects padding, names and formats", () => {
  const value = { format: "text", name: "report", data: "YQ==" };
  expect(artifactProposal(value)).toEqual(value);
  for (const data of [
    "",
    "YQ=",
    "YR==",
    "YWJ=",
    "=AAA",
    "YQ==AAAA",
    "YQ==\n",
    "data:text/plain;base64,YQ==",
  ])
    expect(artifactProposal({ ...value, data })).toBeNull();
  const limit = btoa("a".repeat(ARTIFACT_MAX_BYTES));
  expect(artifactBytes(limit)).toBe(ARTIFACT_MAX_BYTES);
  expect(artifactProposal({ ...value, data: limit })?.data.length).toBe(limit.length);
  expect(artifactProposal({ ...value, data: btoa("a".repeat(ARTIFACT_MAX_BYTES + 1)) })).toBeNull();
  expect(artifactProposal({ ...value, name: "日".repeat(342) })).toBeNull();
  expect(artifactProposal({ ...value, format: "html" })).toBeNull();
});
it("maps only stable Native codes without disclosing private diagnostics or allowing automatic retry", () => {
  expect(artifactErrorCode("ArtifactPublishedUnconfirmed")).toBe("ArtifactPublishedUnconfirmed");
  expect(artifactErrorCode("/private/report.csv failure")).toBe("ArtifactResultUnknown");
  expect(artifactErrorCode("ArtifactUnavailable")).toBe("ArtifactUnavailable");
  expect(artifactError("ArtifactResultUnknown")).toContain("自動で再試行せず");
  expect(artifactError("/private/report.csv failure")).not.toContain("/private");
});
