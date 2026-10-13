// The former runner replaced formal settings but left document DB/index writes behind.
// Identifier migration also permits an active bundle instead of ordinary settings.
console.error(
  "Production E2E is disabled before profile access. Use dedicated identifiers and temporary Native fixtures as described in docs/identifier-migration.md.",
);
process.exitCode = 1;
