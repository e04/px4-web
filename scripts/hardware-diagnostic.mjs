import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const timeoutMs = 20_000;
const server = await createServer({
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  logLevel: 'warn',
});
let browser;

try {
  await server.listen();
  // Chromium intentionally disables WebUSB in its headless mode.
  browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    ignoreDefaultArgs: [
      '--disable-component-extensions-with-background-pages',
      '--disable-extensions',
      '--use-mock-keychain',
    ],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (message) =>
    console.log(`Browser console: ${message.type()}: ${message.text()}`),
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send('DeviceAccess.enable');

  const selected = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`PLEX PX4 did not appear in the WebUSB chooser within ${timeoutMs} ms`)),
      timeoutMs,
    );
    cdp.on('DeviceAccess.deviceRequestPrompted', async (prompt) => {
      const summary = prompt.devices.map((device) => `${device.name} (${device.id})`).join(', ');
      console.log(`WebUSB chooser devices: ${summary || '(none)'}`);
      const device = prompt.devices.find((candidate) =>
        /PX-[WQ]3U4|PX-[WQ]3PE[45]|PX[WQ]3U4|PX[WQ]3PE[45]/i.test(candidate.name),
      );
      if (!device) return;
      try {
        await cdp.send('DeviceAccess.selectPrompt', { id: prompt.id, deviceId: device.id });
        clearTimeout(timer);
        resolve(device.name);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });

  await page.goto('http://127.0.0.1:4173');
  const capability = await page.evaluate(() => ({
    secureContext: window.isSecureContext,
    webUsb: 'usb' in navigator,
  }));
  console.log(`Browser capability: ${JSON.stringify(capability)}`);
  if (!capability.webUsb) throw new Error('WebUSB is unavailable in the launched browser');
  await page.getByRole('button', { name: 'Connect PLEX PX4' }).click();
  const earlyFailure = page
    .locator('#status.error')
    .waitFor({ timeout: timeoutMs })
    .then(async () => {
      const output =
        (await page.locator('#result').textContent())?.trim() ?? 'unknown browser error';
      throw new Error(`WebUSB request failed before device selection: ${output}`);
    });
  const selectedName = await Promise.race([selected, earlyFailure]);
  console.log(`Selected: ${selectedName}`);

  await page
    .locator('#status')
    .filter({ hasText: /接続成功|接続失敗/ })
    .waitFor({ timeout: timeoutMs });
  const status = (await page.locator('#status').textContent())?.trim();
  const output = (await page.locator('#result').textContent())?.trim() ?? '';
  if (status !== '接続成功') throw new Error(`Hardware diagnostic failed: ${output}`);

  const report = JSON.parse(output);
  await mkdir('artifacts', { recursive: true });
  const path = 'artifacts/px4-diagnostic.json';
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Firmware: ${report.it930x.firmwareVersion}`);
  console.log(`Diagnostic report: ${path}`);
} finally {
  await browser?.close();
  await server.close();
}
