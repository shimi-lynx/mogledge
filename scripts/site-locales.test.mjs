import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../site/", import.meta.url));
const base = "https://shimi-lynx.github.io/mogledge/";
const variants = { en: base, ja: `${base}ja/`, "x-default": base };
const pages = ["en", "ja"].map((language) => {
  const url = variants[language];
  const source = readFileSync(
    path.join(root, language === "ja" ? "ja/index.html" : "index.html"),
    "utf8",
  );
  return { language, url, source, document: new JSDOM(source, { url }).window.document };
});
const links = (document, selector) =>
  [...document.querySelectorAll(selector)].map(
    (link) => new URL(link.getAttribute("href"), document.URL).href,
  );

test("each language has its own canonical and reciprocal absolute language alternatives", () => {
  for (const { language, document, url } of pages) {
    assert.equal(document.documentElement.lang, language);
    assert.equal(document.querySelector('link[rel="canonical"]').href, url);
    assert.equal(document.querySelector('meta[property="og:url"]').content, url);
    const alternatives = [...document.querySelectorAll('head link[rel="alternate"]')];
    assert.equal(alternatives.length, 3);
    assert.deepEqual(
      Object.fromEntries(alternatives.map((link) => [link.hreflang, link.href])),
      variants,
    );
    assert.equal(document.querySelector('meta[http-equiv="refresh"]'), null);
  }
  assert.ok(pages[0].document.querySelector('meta[name="google-site-verification"]').content);
  assert.match(pages[1].document.title, /ローカルHTML/);
});

test("visible language choices identify the current page and link to both versions", () => {
  for (const { language, document } of pages) {
    const choices = [...document.querySelectorAll(".language-switch a")];
    assert.equal(choices.length, 2);
    assert.deepEqual(
      choices.map((link) => link.textContent.trim()),
      ["English", "日本語"],
    );
    for (const choice of choices) {
      assert.equal(choice.href, variants[choice.hreflang]);
      assert.equal(choice.lang, choice.hreflang);
      assert.equal(
        choice.getAttribute("aria-current"),
        choice.hreflang === language ? "page" : null,
      );
    }
  }
});

test("both pages use the same current downloads and shared CSS, script and favicons", () => {
  const [english, japanese] = pages.map(({ document }) => document);
  const downloads = links(english, ".downloads a");
  assert.equal(downloads.length, 3);
  assert.deepEqual(links(japanese, ".downloads a"), downloads);
  for (const download of downloads)
    assert.match(download, /^https:\/\/github\.com\/shimi-lynx\/mogledge\/releases\/download\/v/);
  for (const selector of [
    'link[rel="stylesheet"]',
    'link[rel="icon"]',
    'link[rel="apple-touch-icon"]',
  ])
    assert.deepEqual(links(japanese, selector), links(english, selector));
  assert.equal(japanese.querySelector("script[src]").src, english.querySelector("script[src]").src);
});

test("Japanese reuses English media and discloses its language and sample version", () => {
  const [english, japanese] = pages.map(({ document }) => document);
  assert.deepEqual(
    [...japanese.images].map((image) => image.src),
    [...english.images].map((image) => image.src),
  );
  assert.equal(
    japanese.querySelector("video source").src,
    english.querySelector("video source").src,
  );
  assert.equal(japanese.querySelector("video").poster, english.querySelector("video").poster);
  assert.equal(japanese.querySelector("track").src, english.querySelector("track").src);
  assert.equal(japanese.querySelector("track").srclang, "en");
  assert.match(japanese.querySelector("track").label, /英語/);
  assert.match(japanese.querySelector(".screenshot-note").textContent, /0\.9\.0.*英語UI/);
  assert.match(japanese.querySelector(".overview summary").textContent, /日本語/);
  for (const image of japanese.images) assert.match(image.alt, /[ぁ-んァ-ヶ一-龠]/);
  for (const link of japanese.querySelectorAll(".screenshot a"))
    assert.match(link.getAttribute("aria-label"), /英語UI/);
  assert.equal(japanese.querySelector("video").hasAttribute("autoplay"), false);
  assert.equal(japanese.querySelector("video").getAttribute("preload"), "none");
});

test("Japanese keeps startup trust, profile, storage and network limitations explicit", () => {
  const japanese = pages[1].document;
  const text = japanese.body.textContent;
  for (const phrase of [
    "コード署名証明書がありません",
    "アドホック署名",
    "公証",
    "自動同期されません",
    "自動でコピーされません",
    "更新の確認とダウンロード",
    "自動送信されません",
  ])
    assert.ok(text.includes(phrase), phrase);
  const button = japanese.getElementById("copy-diagnostic");
  assert.match(button.dataset.copied, /コピーしました/);
  assert.match(button.dataset.copyFailed, /手動でコピー/);
  assert.match(japanese.getElementById("diagnostic-text").value, /保存データ.*バックアップ/);
});

test("local links, media and fragment destinations resolve under the repository base path", () => {
  for (const { document } of pages) {
    for (const element of document.querySelectorAll("[href], [src], [poster]")) {
      for (const attribute of ["href", "src", "poster"]) {
        if (!element.hasAttribute(attribute)) continue;
        const value = element.getAttribute(attribute);
        const url = new URL(value, document.URL);
        if (!url.href.startsWith(base)) continue;
        let target = decodeURIComponent(url.pathname.slice(new URL(base).pathname.length));
        if (!target || target.endsWith("/")) target += "index.html";
        assert.ok(existsSync(path.join(root, target)), `${document.URL}: ${value}`);
        if (value.startsWith("#") && url.hash)
          assert.ok(document.getElementById(url.hash.slice(1)), value);
      }
    }
  }
});

test("sitemap lists both canonical URLs and the same reciprocal language set", () => {
  const document = new JSDOM(readFileSync(path.join(root, "sitemap.xml"), "utf8"), {
    contentType: "application/xml",
  }).window.document;
  const urls = [...document.getElementsByTagName("url")];
  assert.equal(urls.length, 2);
  assert.deepEqual(
    urls.map((url) => url.getElementsByTagName("loc")[0].textContent),
    [variants.en, variants.ja],
  );
  for (const url of urls) {
    const alternatives = [...url.getElementsByTagNameNS("http://www.w3.org/1999/xhtml", "link")];
    assert.equal(alternatives.length, 3);
    assert.deepEqual(
      Object.fromEntries(
        alternatives.map((link) => [link.getAttribute("hreflang"), link.getAttribute("href")]),
      ),
      variants,
    );
  }
});

test("manual Pages packaging explicitly includes the Japanese entry point", () => {
  const workflow = readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(workflow, /cp site\/ja\/index\.html "\$RUNNER_TEMP\/pages\/ja\/index\.html"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(?:push|pull_request):/m);
});
