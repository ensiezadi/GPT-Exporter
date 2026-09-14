/* Optional real Chromium smoke test. Uses only synthetic ChatGPT responses. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const path = require("node:path"),
  fs = require("node:fs"),
  os = require("node:os"),
  assert = require("node:assert/strict");
(async () => {
  const extension = path.resolve(__dirname, "../chrome-extension");
  const artifacts = path.resolve(
    process.env.BROWSER_ARTIFACT_DIR || "browser-artifacts",
  );
  fs.mkdirSync(artifacts, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-exporter-test-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: process.env.HEADLESS !== "false",
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
    viewport: { width: 1280, height: 1000 },
  });
  const errors = [];
  let notionRequests = 0;
  try {
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host,
      page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await context.route("https://api.notion.com/**", (route) => {
      notionRequests++;
      return route.abort();
    });
    await page.goto(`chrome-extension://${id}/pages/options.html`);
    await page.getByText("未连接 Notion", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(artifacts, "options.png"),
      fullPage: true,
    });
    await page.locator("#workspace").fill("workspace-test");
    await page.locator("#token").fill("fixture-only-notion-secret");
    let n = 1;
    for (const k of ["projects", "conversations", "runs"])
      await page.locator("#source-" + k).fill(`${n++}`.repeat(32));
    await page.getByText("保存配置", { exact: true }).click();
    await page.getByText("操作完成", { exact: true }).waitFor();
    assert.equal(await page.locator("#token").inputValue(), "");
    await page.locator("#scan").click();
    await page
      .getByText("请先打开并登录 ChatGPT，再重试", { exact: true })
      .waitFor();
    await page.goto(`chrome-extension://${id}/pages/popup.html`);
    await page.locator("#projects-count").filter({ hasText: "0" }).waitFor();
    await page.screenshot({ path: path.join(artifacts, "popup.png") });
    await context.addCookies([
      {
        name: "oai-did",
        value: "fixture-device",
        domain: "chatgpt.com",
        path: "/",
      },
    ]);
    await context.route("https://chatgpt.com/**", (route) => {
      const url = route.request().url();
      if (url.includes("/api/auth/session"))
        return route.fulfill({
          json: { accessToken: "fixture-chatgpt-token" },
        });
      if (url.includes("/backend-api/"))
        return route.fulfill({ json: { items: [], has_more: false } });
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><html><head><meta charset="utf-8"></head><body><main>Exporter test fixture</main></body></html>',
      });
    });
    const chat = await context.newPage();
    chat.on("pageerror", (e) => errors.push(e.message));
    await chat.goto("https://chatgpt.com/");
    await chat.waitForFunction(() => !!window.ChatGPTExporter);
    await chat.evaluate(() => window.ChatGPTExporter.showDialog());
    await chat.getByRole("dialog").waitFor();
    await chat.screenshot({ path: path.join(artifacts, "page-export.png") });
    await chat.getByRole("button", { name: "关闭", exact: true }).click();
    await page.goto(`chrome-extension://${id}/pages/options.html`);
    await page.getByText("已保存连接", { exact: true }).waitFor();
    await page.locator("#scan").click();
    await page
      .locator("#sync-status")
      .filter({ hasText: "扫描完成，等待同步" })
      .waitFor();
    const boundary = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => ({
          local: await chrome.storage.local.get(null),
          databases: await indexedDB.databases(),
          control: await chrome.runtime.sendMessage({
            type: "GPT_SYNC_CONTROL",
            action: "status",
          }),
        }),
      });
      return result;
    });
    assert.ok(!JSON.stringify(boundary).includes("fixture-only-notion-secret"));
    assert.ok(
      !boundary.databases.some((d) => d.name === "gpt-exporter-private"),
    );
    assert.equal(boundary.control.ok, false);
    assert.equal(notionRequests, 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(artifacts, "browser-result.json"),
      JSON.stringify(
        {
          errors,
          notionRequests,
          boundary,
          checks: [
            "MV3 worker loaded",
            "options save and token input cleared",
            "missing ChatGPT error",
            "popup rendered",
            "declarative MAIN page UI rendered",
            "scan across bridge reached review",
            "automatic writes stayed off",
            "extension vault inaccessible from content origin",
            "privileged page commands denied",
          ],
        },
        null,
        2,
      ),
    );
    console.log("Browser smoke test passed");
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
