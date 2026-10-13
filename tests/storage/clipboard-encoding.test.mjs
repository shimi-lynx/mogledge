import test from "node:test";
import assert from "node:assert/strict";

test("reported Mac basename matches UTF-8 interpreted as Shift-JIS", () => {
  const basename = "カンバンToDo.html";
  const utf8 = Buffer.from(basename, "utf8");
  assert.equal(new TextDecoder("shift_jis").decode(utf8), "繧ｫ繝ｳ繝舌ΦToDo.html");
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(utf8), basename);
  for (const name of [
    "カンバンToDo.html",
    "ガギグゲゴ.html",
    "カ\u3099キ\u3099ク\u3099ケ\u3099コ\u3099.html",
  ]) {
    const bytes = Buffer.from(JSON.parse(JSON.stringify(name)), "utf8");
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(bytes), name);
  }
});
