import { expect, test } from "@playwright/test";

for (const language of ["ja", "en"] as const) {
  test(`Codex CLI copy diagnostics ${language} keep input and require explicit retry (mock Native)`, async ({
    page,
  }) => {
    const text =
      language === "ja"
        ? {
            destination: "連携先",
            copy: "依頼文をコピー",
            failed: "クリップボードにコピーできませんでした",
            unknown: "コピーの完了を確認できませんでした",
            copied: "依頼文をコピーしました",
          }
        : {
            destination: "Destination",
            copy: "Copy request",
            failed: "The request could not be copied to the clipboard",
            unknown: "Copy completion could not be verified",
            copied: "Request copied",
          };
    await page.addInitScript(
      (value) => localStorage.setItem("mogledge.ui-language", value),
      language,
    );
    await page.route("**/src/app/App.tsx", async (route) => {
      const source = await (await route.fetch()).text();
      const reactModule = source.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
      if (!reactModule) throw new Error("Vite did not resolve React");
      await route.fulfill({
        contentType: "application/javascript",
        body: `
        import React from ${JSON.stringify(reactModule)};
        import AiHandoffDialog from '/src/app/AiHandoffDialog.tsx';
        window.copyCalls=[];
        const api={prepare:async()=>({selectedPath:'/fixture/日本語 root',workingDirectory:'/fixture/日本語 root',revision:1}),perform:async request=>{
          window.copyCalls.push(request);
          if(window.copyCalls.length===1)throw 'パスをコピーできません';
          if(window.copyCalls.length===2)throw new Error('/fixture/private: reply lost');
        }};
        const context={workspaceId:'workspace',viewId:'view',target:'root'};
        export function App(){return React.createElement(AiHandoffDialog,{context,api,onClose:()=>{}});}
      `,
      });
    });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.emulateMedia({ colorScheme: language === "ja" ? "dark" : "light" });
    await page.goto("/");
    const dialog = page.getByRole("dialog");
    const copy = dialog.getByRole("button", { name: text.copy });
    await expect(copy).toBeEnabled();
    await dialog.getByRole("combobox", { name: text.destination }).selectOption("codexCli");
    await copy.click();
    await expect(dialog.getByRole("alert")).toContainText(text.failed);
    await expect(dialog.getByRole("status")).toHaveCount(0);
    await expect(dialog).not.toContainText("/fixture/");
    expect(
      await page.evaluate(() => (window as unknown as { copyCalls: unknown[] }).copyCalls),
    ).toEqual([
      {
        context: { workspaceId: "workspace", viewId: "view", target: "root" },
        preview: {
          selectedPath: "/fixture/日本語 root",
          workingDirectory: "/fixture/日本語 root",
          revision: 1,
        },
        instruction: "",
        destination: "codexCli",
        copy: true,
      },
    ]);
    const instruction = "  日本語 😀 & ? # %\n/fixture/user-entered.html  ";
    await dialog.getByRole("textbox").fill(instruction);
    await copy.click();
    await expect(dialog.getByRole("alert")).toContainText(text.unknown);
    await expect(dialog.getByRole("alert")).not.toContainText("private");
    await expect(dialog.getByRole("textbox")).toHaveValue(instruction);
    await expect(dialog.getByRole("status")).toHaveCount(0);
    await dialog.getByRole("alert").scrollIntoViewIfNeeded();
    const bounds = (await dialog.getByRole("alert").boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    await page.screenshot({ path: test.info().outputPath(`ai-copy-${language}-mock.png`) });
    expect(
      await page.evaluate(() => (window as unknown as { copyCalls: unknown[] }).copyCalls.length),
    ).toBe(2);
    await copy.click();
    await expect(dialog.getByRole("status")).toContainText(text.copied);
    expect(
      await page.evaluate(() =>
        (
          window as unknown as {
            copyCalls: { instruction: string; copy: boolean; destination: string }[];
          }
        ).copyCalls.map((call) => ({
          instruction: call.instruction,
          copy: call.copy,
          destination: call.destination,
        })),
      ),
    ).toEqual([
      { instruction: "", copy: true, destination: "codexCli" },
      { instruction, copy: true, destination: "codexCli" },
      { instruction, copy: true, destination: "codexCli" },
    ]);
  });
}
