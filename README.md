# VANTAGE

A desktop terminal for multi-asset market research and paper trading — equities, futures, FX, indices and crypto — with a portfolio ledger, a trading journal and an AI research assistant.

![VANTAGE chart workspace](docs/vantage-chart.jpg)

## What it does

- **Charting.** A canvas chart engine written from scratch: candles, line and volume series, indicators, and drawing tools anchored to time and price, so a drawing stays on the bar it was placed on across timeframes and window sizes. Bar sizes run from one second to one month, and every size loads the full history the source publishes.
- **Market data.** Quotes, history, options and fundamentals from free public sources (Yahoo Finance, Binance, Cboe, SEC EDGAR), with company filings read straight from XBRL when no other fundamentals are available.
- **Paper trading.** Market, limit, stop, stop-limit and trailing orders against a simulated broker, with take-profit and stop-loss.
- **Portfolio and journal.** Positions are derived from a transaction ledger rather than stored, so an average entry price can never drift from its own lots. Real, paper and imported holdings are kept as separate books and are never added together.
- **Research assistant.** SYRIX answers questions using live prices, filings, news and web search, and the reply passes through guards that strip unsupported advice and flag figures that do not match a source.
- **News and discovery.** Worldwide news search, a reader that stays inside the app, sector heatmaps, a screener and an economic calendar.

## How it is built

| | |
|---|---|
| Runtime | Electron, plain JavaScript, no npm dependencies |
| Main process | All network access, data providers, storage, the assistant's tool loop |
| Renderer | Interface only — its Content Security Policy sets `connect-src 'none'`, so a compromised page has no way to reach the network |
| Storage | JSON files in a local data directory, outside version control |

```
main/        Electron main process, IPC, window management
src/
  core/      HTTP client, storage, audit log, PDF reader, branding
  market/    Instruments, candles, freshness, integrity checks, data providers
  paper/     Simulated broker
  portfolio/ Ledger, positions, valuation, risk, journal
  analysis/  Technical indicators
  syrix/     Assistant gateway, tool loop, evidence and answer guards
web/         Interface: screens, chart engine, drawing tools, styles
tests/       Unit, architecture and live-interface test suites
tools/       Launcher, icon generator, inspection and screenshot tools
```

## Rules the code enforces

These are checked by tests, not left to convention.

- **Nothing claims to be live on its own authority.** A price is shown as live only when its provider declares real-time data with zero delay; anything else is labelled delayed. There is exactly one place in the code that can produce the live state.
- **A figure that fails a blocking integrity check is not shown at all.** Showing it with a warning would still put a wrong number on screen.
- **A total inherits the worst freshness inside it**, and unpriced holdings are named rather than dropped.
- **No single-currency total without a real exchange rate.** Per-currency subtotals are shown instead.
- **The interface never makes a network request.** Verified by an architecture test as well as by the policy.

## Tests

```
node tests/run-all.js      # 1,623 assertions, no window opened
node tests/ui-probe.js     # drives the running app over the Chrome DevTools Protocol
```

The interface probe launches its own copy of the app on a throwaway data directory and checks every screen, both themes, chart interaction and control wiring.

## Running it

Requires Node.js 18 or later and Electron 31.

```
npx electron@31.7.7 .
```

or, with an existing Electron install:

```
set ELECTRON_PATH=C:\path\to\electron.exe
node tools/launch.js
```

Optional configuration, read from the environment:

| Variable | Purpose |
|---|---|
| `VANTAGE_CONTACT` | Contact address sent in the User-Agent header (required by SEC EDGAR) |
| `SYRIX_GATEWAY_URL` | Address of the assistant's model gateway |
| `TERMINAL_DATA_DIR` | Where records are stored (defaults to `./data`) |

The assistant pairs once with `node tools/pair-syrix.js <pairing-code>` and stores only a revocable device token. No provider API key is ever held by this application.

## Status

A personal project, in active development. Paper trading only — it places no real orders.

---

© 2026 Kabirr Kohli. All rights reserved. Published for viewing; no licence is granted to copy, modify or redistribute.
