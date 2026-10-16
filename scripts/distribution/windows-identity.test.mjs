import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const template = await readFile(
  new URL("../../src-tauri/windows/installer.nsi", import.meta.url),
  "utf8",
);
const macro = template.match(
  /!macro RenameLegacyShortcut legacy renamed\r?\n([\s\S]*?)!macroend/,
)[1];

// Evaluate only this template's shortcut branch against synthetic link metadata.
// This checks source control flow; it does not emulate NSIS/COM or establish Native QA.
function renameLegacy(links) {
  const values = { $LegacyInstall: 1, $0: 0, $R0: 0 };
  const stack = [];
  const conditions = [];
  const paths = {
    "${legacy}": "old.lnk",
    "${renamed}": "new.lnk",
    "$INSTDIR\\${LEGACYBINARY}": "old.exe",
    "$INSTDIR\\${MAINBINARYNAME}.exe": "new.exe",
  };
  const resolve = (value) => paths[value] ?? value;
  const active = () => conditions.every(({ enabled }) => enabled);
  const condition = (text) => {
    const file = text.match(/^\$\{FileExists\} "([^"]+)"$/);
    if (file) return links.has(resolve(file[1]));
    const compare = text.match(/^(\$\w+) (=|<>) (\d+)$/);
    assert.ok(compare, `Unsupported shortcut condition: ${text}`);
    return compare[2] === "="
      ? values[compare[1]] === Number(compare[3])
      : values[compare[1]] !== Number(compare[3]);
  };
  for (const raw of macro.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    if (line.startsWith("${If} ")) {
      conditions.push({ parent: active(), enabled: active() && condition(line.slice(6)) });
      continue;
    }
    if (line === "${Else}") {
      const last = conditions.at(-1);
      last.enabled = last.parent && !last.enabled;
      continue;
    }
    if (line === "${EndIf}") {
      conditions.pop();
      continue;
    }
    if (!active()) continue;
    const args = [...line.matchAll(/"([^"]*)"/g)].map((match) => resolve(match[1]));
    if (line.startsWith("!insertmacro IsShortcutTarget "))
      stack.push(links.get(args[0])?.target === args[1] ? 1 : 0);
    else if (line === "Pop $0") values.$0 = stack.pop();
    else if (line.startsWith("!insertmacro SetShortcutTarget ")) {
      if (links.has(args[0])) links.get(args[0]).target = args[1];
    } else if (line.startsWith("!insertmacro SetLnkAppUserModelId ")) {
      if (links.has(args[0])) links.get(args[0]).appId = "com.shimilynx.mogledge";
    } else if (line.startsWith("Delete ")) links.delete(args[0]);
    else if (line.startsWith("Rename ")) {
      assert.ok(!links.has(args[1]));
      links.set(args[1], links.get(args[0]));
      links.delete(args[0]);
    } else if (line === "StrCpy $R0 1") values.$R0 = 1;
    else if (line === "StrCpy $0 1") values.$0 = 1;
    else assert.fail(`Unsupported shortcut command: ${line}`);
  }
  assert.equal(conditions.length, 0);
  return links;
}

for (const existing of [undefined, "old.exe", "new.exe", "foreign.exe"]) {
  test(`owned predecessor shortcut remains usable with new-label target ${existing ?? "absent"}`, () => {
    const links = new Map([["old.lnk", { target: "old.exe", appId: "legacy" }]]);
    if (existing) links.set("new.lnk", { target: existing, appId: "existing" });
    renameLegacy(links);
    if (existing === "foreign.exe") {
      assert.deepEqual(links.get("new.lnk"), { target: "foreign.exe", appId: "existing" });
      assert.deepEqual(links.get("old.lnk"), {
        target: "new.exe",
        appId: "com.shimilynx.mogledge",
      });
    } else {
      assert.equal(links.has("old.lnk"), false);
      assert.equal(links.get("new.lnk").target, "new.exe");
      assert.equal(links.get("new.lnk").appId, "com.shimilynx.mogledge");
    }
  });
}

test("retargeting current-name links also updates their bundle identity", () => {
  const functions = template.slice(template.indexOf("Function CreateOrUpdateStartMenuShortcut"));
  const targets = [
    ...functions.matchAll(
      /!insertmacro SetShortcutTarget "([^"]+)"[^\r\n]*\r?\n\s*!insertmacro SetLnkAppUserModelId "\1"/g,
    ),
  ];
  assert.equal(
    targets.length,
    3,
    "start-menu folder, root start menu and desktop must update AUMID with target",
  );
});

test("shortcut helpers finish retargeting all current-name links before returning", () => {
  for (const name of ["CreateOrUpdateStartMenuShortcut", "CreateOrUpdateDesktopShortcut"]) {
    const body = template.match(new RegExp(`Function ${name}\\r?\\n([\\s\\S]*?)FunctionEnd`))[1];
    assert.ok(body.indexOf("Return") > body.lastIndexOf("!insertmacro SetShortcutTarget"), name);
  }
});
