import base from './playwright.config.ts';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cfg: any = base;
for (const p of cfg.projects ?? []) {
  p.use = { ...(p.use ?? {}), channel: undefined, headless: true,
    launchOptions: { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' } };
}
export default cfg;
