# Thailand Export Monitor: สาหร่าย HS 20089930

Static GitHub Pages dashboard for Thailand export data from the Ministry of Commerce Thailand Trade Report.

## Online Dashboard

Open the dashboard online:

https://benzkanin41-alt.github.io/moc-seaweed-hs20089930-dashboard/

## Dataset

- Product: สาหร่าย
- HS code: `20089930`
- HS version: `2022`
- HS name from MOC lookup: `20089930 : ของก้าน ราก และส่วนอื่นของพืชที่บริโภคได้ ไม่รวมถึงผลไม้หรือลูกนัต จะเติมน้ำตาลหรือสารทำให้หวานอื่น ๆ หรือสุรา หรือไม่ก็ตาม`
- Source: https://tradereport.moc.go.th/th/stat/reporthscodeexport01
- Endpoint: `https://tradereport.moc.go.th/stat/reporthscodeexport01/result`
- Coverage: `2021-01` to `2026-09`
- Latest source month: ก.ย. 2569
- Source publication: `2026-10-26 10:30 Asia/Bangkok` ([MOC publication schedule](https://tradereport.moc.go.th/th/documentpublish))
- Currency: บาท

## Validation

- Months fetched: `69`
- Country-month rows: `3,315`
- Total rows: `69`
- Continent rows: `369`
- Reconciliation max value diff: `0.0`
- Reconciliation max quantity diff: `0.0`
- Unmapped continent country IDs: none

The reconciliation file is available at `data/validation_reconciliation.csv`.

## Refresh

Run `python -X utf8 .\scripts\fetch_moc_hs20089930.py` to fetch the latest month and regenerate the dataset. When MOC revises previously published data, add `--refresh-year 2025` (repeat for each affected year) to refetch those months before regeneration.

## Files

- `index.html` - dashboard entry point
- `styles.css` - dashboard styles
- `app.js` - dashboard interactions, charts, filters, table sorting, CSV export
- `data.js` - embedded dashboard dataset
- `data/dataset.json` - full dataset and metadata
- `data/monthly_country_hs20089930.csv` - monthly country-level exports
- `data/monthly_continent_hs20089930.csv` - monthly continent-level exports
- `data/monthly_total_hs20089930.csv` - monthly world totals
- `data/validation_reconciliation.csv` - monthly reconciliation checks
- `dashboard-desktop-smoke.png` - desktop QA screenshot
- `dashboard-mobile-smoke.png` - mobile QA screenshot
- `qa-results.json` - local Edge/CDP QA results
- `scripts/fetch_moc_hs20089930.py` - data fetch script used for this build
- `scripts/qa_dashboard_cdp.js` - local dashboard QA script used for this build

## QA Performed

- `node --check app.js`
- `node --check data.js`
- `curl http://127.0.0.1:8778/`
- Edge/CDP desktop layout check: `1440x1200`
- Edge/CDP tablet layout check: `826x1200`
- Edge/CDP mobile layout check: `390x1600`
- DOM smoke checks for KPI cards, charts, table controls, source section, no horizontal overflow, and no overlapping x-axis labels
- Chart point interaction checks for mouse click and keyboard Enter
- Country, continent, quarterly, annual, and quantity view checks
- Current browser screenshots are generated under `work/qa-local`; set `QA_RESULTS_OUT` and `QA_SCREENSHOT_DIR` for a separate online run. Set `EXPECTED_LATEST_PERIOD=2026-09` to assert the published month.

## Notes

This dashboard is a static snapshot generated from MOC data fetched on `2026-10-26`. All January-September 2026 responses were fetched again for this update. It does not call the MOC API at page load time.
