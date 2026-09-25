# Michael Kors → Full Size Run: 5-hourly refresh (instructions for the scheduled Claude task)

Project: `C:\Users\gully\Downloads\New folder (2)\on-sync`. Shopify credentials are already in `.env`, so never ask
for any. Full Size Run is the official authorized Michael Kors importer for India, and image and description reuse is
authorized. Michael Kors WATCHES are never imported; the code excludes them.

1. **Harvest in the in-app browser** (`mcp__Claude_Browser__*` tools):
   - Open `https://www.michaelkors.com/robots.txt` with `preview_start` (url) or `navigate`.
   - Read `src/michaelkors/harvest.browser.js`. Pass its full text, followed by
     `;startMkHarvest({ delayMs: 2000 })`, to `javascript_tool` on that tab.
   - Every ~3 minutes, call `javascript_tool` with `mkHarvestStatus()` until `state` is no longer `running`. Wait
     with a background `sleep 180` Bash command, never a foreground sleep. It takes ~35 minutes.
   - If `state` is `blocked`: stop, do not retry, and do not try to get around it. Report the `stoppedReason`. The
     existing Shopify products stay as they are.
2. **Export:** call `javascript_tool` with `mkHarvestExport()`. The result is large and is saved to a file; the error
   message gives its path. Do not read that file into the conversation.
3. **Import the feed:** `node src/michaelkors/cli.ts feed-import "<that path>"`. It prints `"applied": true` for a
   complete harvest. An incomplete harvest is set aside and the previous feed is kept.
4. **Sync:** only if step 3 printed `"applied": true`, run `node src/michaelkors/cli.ts sync --live --trigger scheduler`.
   Otherwise skip the sync and report why. The existing products keep their last prices.
5. **Report**, briefly:
   - the numbers from the newest `logs/MICHAELKORS-SYNC-*.report.txt` header: created / updated / unchanged /
     WATCH_EXCLUDED / skipped / needs review / missing / archived / failed
   - the exchange rate
   - any WARNINGS lines

Rules: nothing is ever deleted. No CAPTCHA solving, proxies, stealth, or retrying around a 403/429.
