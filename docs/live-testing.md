# Live testing

The live tests have the real agent, on free models, do real tasks on real sites in your own Chrome. Each run is scored from what its run log shows it did, never from what the agent says it did.

The goal is that the agent can do what a person does with a browser: search, filter, compare, collect, save, sign in, and finish long multi-step jobs. The tests below are a **ladder**. A run is one activity, on one site, on one model pair. A few of those is a sample. They are not a gate, and they are not a batch to grind.

## Running it

```sh
scripts/live.sh setup                      # build, load the extension, check the host and key
scripts/live.sh activities                 # one browse run on the next site in the rotation
scripts/live.sh activities --repeat 6      # six runs on six sites, on the batch's model pair
scripts/live.sh activities filter_sort,site_median --repeat 4   # deep jobs, rotating across shop sites
scripts/live.sh activities browse filter_sort   # positional ids accumulate: both rungs, in that order
scripts/live.sh activities --site mercari.com --query "Ryzen 5 5600X"   # pin a site and part
# both seats are nvidia/nemotron-3.5-lightning:free unless you set these
NB_LIVE_LEADER=poolside/laguna-s-2.1:free NB_LIVE_FOLLOWER=poolside/laguna-s-2.1:free \
  scripts/live.sh activities
node scripts/harness/activities.mjs list   # every activity id
node scripts/harness/activities.mjs board  # model pair by site for one activity (default browse), from every saved run
```

Each run opens a fresh tab and closes it when the run ends. Results go to `runs/activities-<time>/`: the task, the live stream, the run log, and the scored report. Every run is also appended to `runs/history.jsonl`. A run that outlives `NB_LIVE_TIMEOUT` (600 s per run by default) is cancelled in the extension, not merely abandoned by the CLI — the CLI prints `timed out after <N>s; cancelling <run-id>`. To see that path work, `NB_LIVE_TIMEOUT=15 scripts/live.sh activities browse` should print that line within a minute, and the run log should end in a cancelled/interrupted status rather than the tab acting on for the full step budget.

**Sites rotate. Models do not.** Each run goes to the site tested least recently — for the deep rungs, the priced shop sites — where every country domain of one operator counts as one site, so eBay.com, eBay UK and eBay.de are one. A long series spreads across sites instead of returning to the same few, and no single account sees a pattern of repeated automated visits. The query rotates too. The model pair does not: both seats are `nvidia/nemotron-3.5-lightning:free` until that choice changes. `NB_LIVE_LEADER` and `NB_LIVE_FOLLOWER` override either seat for a comparison; they are not how the everyday run picks a model.

## What a run does

### Rung 1: `browse`, go to a URL and click

This is the floor: any site, one search, one listing. It is what almost every other task is built from, so if it is flaky nothing above it can be trusted.

1. Open a site from `scripts/harness/sites.json`. It lists 245 sites that sell used computer parts: marketplaces, refurbishers, surplus and liquidation sites, enthusiast forums, and retailers' renewed sections, across more than 25 countries.
2. Use the site's own search to look for a part: DDR4 or DDR5 RAM, a GPU, a CPU, an SSD, a ThinkPad or an OptiPlex.
3. Open one listing.
4. Call `done` with only `{"title", "price", "url"}`.

### Rung 2: one site, one job

These are built and passing today, and they are the default next step once `browse` is solid — not eBay. Each picks a priced, USD shop site (marketplace, refurbisher, used-retailer section, classifieds) by the same least-recently-tested rotation as `browse`, so repeating them moves across sites instead of camping on one. They run by name (`scripts/live.sh activities filter_sort,site_median`):

| Activity | What it asks of the agent |
|---|---|
| `filter_sort` | search a site, then sort by price or filter with the site's own controls, and prove it from the URL or the page (#51) |
| `site_median` | read two pages of results, using the site's own next-page control, and work out the median price |

A site that filters in the page without touching its URL shows no URL evidence; the scorer's detail says so rather than guessing.

### Rung 3: three sites in one run

`compare_sites` starts on one shop site, has the agent navigate to two more, and names the cheapest of the three offers it grounded in pages it actually visited. Fifty steps, three searches, three currencies' worth of sites kept to one (USD) so the comparison means something.

### Opt-in: the eBay jobs

The eBay activities are the same jobs pinned to one site — eBay — which is also the most defended site in the list: a run can end behind a CAPTCHA or a bot wall, and the scorer marks those **invalid**, a fact about the setup, not a verdict on the model. Until the agent has a way past those walls (of seven eBay live runs on 2026-10-12, three ended at CAPTCHAs and one passed), these runs measure the walls, not the agent. So they are opt-in: run one when deliberately probing eBay (`scripts/live.sh activities ebay_compare` — live.sh passes the harness's `--legacy` opt-in for you), not as the default deep job, and never many back to back — one or two runs, then return to the rungs above, which rotate for you.

| Activity | What it asks of the agent | Preconditions |
|---|---|---|
| `ebay_compare` | apply eBay's own Buy It Now and price filters, open three listings, read title, price, shipping and seller, report JSON | none beyond the walls |
| `ebay_csv` | extract every listing on a results page with a userscript and save it as a CSV (checked on disk: at least 10 rows with 10 distinct item ids) | none beyond the walls |
| `ebay_sold_median` | use the Sold Items filter across two pages and work out the median | none beyond the walls |
| `ebay_watchlist` | read a signed-in watchlist without changing it | the Chrome profile must be signed in to eBay; until it is, this comes back **invalid** every time |

A run that ends behind a CAPTCHA, a bot wall or a sign-in redirect is scored invalid and kept out of pass rates. Repeating an eBay job repeats on ebay.com every time — that is the one rotation cannot spread.

**What to build next.** The rungs above cover search, the site's own filter controls, two-page reading and cross-site comparison. Still unbuilt, each a multi-step job on any of the 245 sites, scored by the same run-log method:

- **Collect:** walk several pages of results into a file, with a count, deduplicated.
- **Cart and forms, up to checkout:** add to a cart, fill an address form, stop before paying. Test credentials and addresses only.
- **Sign-in:** reuse the current session, and complete a sign-in the user has authorized.
- **Recover:** a task that starts behind a cookie banner, a modal, or a moved search box.
- **Long runs:** 40 or more steps, with replans, where the cost and the cache share matter.
- **Defeat a bot wall or CAPTCHA:** the missing skill that keeps the eBay jobs out of the default.

Start a new activity as a rung-1 `browse` on the same site if that is quicker to get working, then climb.

## How a run is scored

`browse` is scored as a ladder, so a failed run shows how far it got:

| Checkpoint | What counts |
|---|---|
| reached the site | a page on the site's host |
| searched | a results page that carries the query, or the query typed into a field |
| opened a listing | a product-shaped page (`/dp/`, `/itm/`, `/item/`, `/products/`, `/s-anzeige/`, `/threads/`...) after the results, or any new path that is not a results page |
| reported JSON | `done` summary parses, with title, price and url |
| **grounded** | the reported listing is one it visited, matched by listing id (ASIN, numeric id), so a trimmed tracking suffix still matches and a different product does not |
| price | a number above 0 |
| right part | the title has most of the query's distinctive words (a Ryzen 7 5800X is not a Ryzen 5 5600X) |
| ended done | the run ended `done` |

**Invalid** means the run says nothing about the model: it ended behind a bot wall or CAPTCHA, the site was unreachable, or the model provider rate-limited it (429). Invalid runs are kept out of pass rates.

## Telemetry

**Live:** one line per step, with role, tool, arguments, tokens in and cache share, tokens out, latency and any tool error. Each new page prints its URL and snapshot size.

**Per run:**
- calls, tokens, cache share and model id per role
- steps, seconds, and gaps over 30 s between model calls
- tool errors and repeated identical calls
- tool results over 20k characters fed to the model
- the pages visited
- the change since the last run on the same site

**Not yet:** a screenshot per step (#50), and any sign of life during a long model call (#52).

## Models

Agent-initiated runs use one free pair: `nvidia/nemotron-3.5-lightning:free` on both seats. Pair rotation is off. These runs are measurement, not a gate — CI does not run them. Before trying another model, probe it with one tool-call request. `thinkingmachines/inkling` returns 403 ("only available on agentic harnesses"), and some free models 429 for long stretches. Compare a deliberate override with `board`, never by reading logs.

Results on 2026-10-12 (small samples):

| Leader + Follower | Valid passes | Mean score | Calls/run | Tokens in/run |
|---|---|---|---|---|
| laguna-s-2.1 + laguna-s-2.1 | 2/2 | 100% | 10 | 96k |
| nemotron-3-ultra + nemotron-3-super | 2/3 | 73% | 19 | 250k |
| gemma-4-31b + gemma-4-26b | 1/2 | 90% | 9 | 90k |
| nemotron-3-ultra + nemotron-3.5-lightning (the old default; ultra is not used now) | 2/13 | 48% | 19 | 207k |

That fallback pair's 13 runs include six on the build before the fixes below.

## Rules for whoever works on this

- **A recoverable error must not end a run.** That covers a failed screenshot, a swapped tab id, one 429, and two failed clicks: each is information for the agent, not a verdict. Each of those ended runs at some point and was fixed. Treat any new one as a product bug.
- **Check the scorer before blaming the model.** Rescore with `board` and read the run log. The scorer was wrong four times on 2026-10-12 (Amazon product URLs carry the search keywords, Kleinanzeigen's results path, trimmed listing URLs, wrong-part listings), and every fix is pinned by a test in `tests/activities.test.ts`.
- **A few runs, then stop.** `--repeat` defaults to 1. One browse run is a sample; six is a batch you asked for. Once browse passes on lightning, the next run is a rung-2 job (`filter_sort`, `site_median`, `compare_sites`), not another browse.
- **Sites rotate. The model does not.** Every run is nemotron-3.5-lightning on both seats. Sites still move so one account is not hammered. `--site` and `--query` pin a page. The eBay jobs stay opt-in: one or two runs, then stop.
- **Paste real output** when reporting a result: the report lines, the board, the run id.

## Product bugs these runs found

| Found live | Fixed by |
|---|---|
| a tab id swap made every page op fail with `No tab with id` | following `chrome.tabs.onReplaced` |
| a stalled `captureVisibleTab` ended the run at step 0 | a failed screenshot costs one observation |
| Enter in a search box never submitted (untrusted keydown has no default action) | Enter submits the form via `requestSubmit` |
| clicks refused as "occluded by another element", with no way to tell what was in the way | the error names the cover and its ref |
| every run asked for JSON answered in prose | `done.summary` describes the result, in the format asked |
| two identical failures ended the run | they hand back to the Leader first |
| one free-tier 429 ended the run after 0 to 4 steps | 429s are retried with backoff |
| test tabs were never closed | the `closeTabWhenDone` run option |
