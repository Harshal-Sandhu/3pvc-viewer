# 3PVC UI — Detailed User Guide (Viewer & Admin)

A complete walk-through of every feature on the **3PVC Viewer** (`/`) and the
**Admin** page (`/admin`), with the **Configs** page (`/configs`) and the
**Operation** page (`/operation`) covered too, since the Admin page controls all
of them.

App URL: **http://192.168.6.34**

---

## 1. Overview

```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ /            │ /configs     │ /operation   │ /admin       │
│ Viewer       │ Configs      │ Operation    │ Admin        │
├──────────────┼──────────────┼──────────────┼──────────────┤
│ inspect bot  │ compare each │ run actions  │ configure    │
│ firmware     │ bot's config │ on bots      │ sites,       │
│ data per     │ against the  │ (deploy,     │ recipients,  │
│ site, per    │ validation   │ ping,        │ compliance   │
│ bot          │ expectations │ maintenance) │ + data entry │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

All pages share one authentication session. Links between pages are in the
top-right bar of every page.

---

## 2. Logging in

There are two login mechanisms:

| Page(s) | Method |
|---|---|
| Viewer `/`, Configs `/configs` | Email with `@greyorange.com` + 6-digit one-time code (mailed to you) |
| Admin `/admin` | Username + password (below), or viewer-style email code |

Standard test accounts:

| Account  | Username | Password |
|---|---|---|
| Viewer   | `viewer` | `viewer`  |
| Admin    | `admin`  | `apj0702` |

### Roles
- **viewer**: can use Viewer, Configs, and Operation pages. Cannot see or use Admin.
- **admin**: same as viewer plus the Admin page.

### Admin unlock (a second lock)
After logging in as **admin** you must additionally enter the **admin unlock
passphrase** (`product_validation`). Until it is entered, the Admin page is
read-only. Enter it once per session. Use the **Lock** button (top-right) to
re-lock immediately, or the session relocks automatically when you sign out.

---

## 3. Viewer page (`/`)

Read-only inspection of per-bot firmware data across any configured site.
Data is pulled live from each site's InfluxDB through the app server.

### 3.1 Top bar
- **Auto-refresh** — Off / 30s / 1m / 5m. Re-runs the current query automatically.
- **? (help)** — keyboard-shortcut popup.
- **Operation / Configs / Admin** links (Admin only appears for admin users).
- **who** — your username. **Sign out** ends the session.

### 3.2 Toolbar
- **Site** — which site (InfluxDB) to query.
- **Bot** — narrow to one bot, or "All bots".
- **Lookback** — time window: `1d`, `6h`, or a custom value like `48h`.
- **Row limit** — cap on the number of rows returned.
- **Fields ▾** — choose which firmware columns the query fetches (fewer fields =
  faster, less memory).
- **Columns ▾** — choose which columns are *visible* in the table. Your choice is
  remembered per browser.
- **Load data** — run the query.
- **Export CSV** — download the visible rows as a CSV (enabled once data loads).
- **Filter (Cmd/Ctrl+K)** — global free-text filter across visible columns.
- **Latest record per bot only (U)** — see §3.4.

### 3.3 Stat cards
Four counts over the loaded (non-dead) data:
- **Total bots**, **Unique VDA**, **Compliant**, **Mismatched**.
- Click any card to filter the table to that subset (click the same card again
  to clear the filter).

### 3.4 Table (rows = bot snapshots)
Columns include `time`, `bot_id`, `ip`, the version key (`api_version` for
RELAY sites, `version` for TTP sites), `vda_version`, every `app_*` firmware
field, plus three synthetic columns:

| Column | Meaning |
|---|---|
| `released_version` | the value the compliance/validation record *expects* |
| `status` | `✓ Compatible` (green) if every tracked field matches compliance, `✗ Incompatible (N)` (red) if N fields differ (hover = list of diffs), `Dead` if no version was reported |
| `expected_values` | the compliance row that was matched (if any) |

Cell colouring:
- `vda_version` cell green = matches compliance, red = differs. `kubot_master_version`
  gets the same treatment for HAI bots.

**Latest record per bot only** — keeps just the most recent **non-dead** row
per bot. Bots whose every row in the window is dead are hidden altogether.
Keyboard shortcut: <kbd>U</kbd>.

**Row detail popover** — click any row to open a per-bot comparison showing
every field: your bot's actual value vs the expected value, colour-coded.

### 3.5 Non-compliant bots panel
A collapsible card listing every bot that is:
- **mismatch** — compliance matched but some field differs (shows
  actual → expected for each differing field), or
- **dead** — no compliance row matched ("no version key reported").

The badge in the panel header shows the total count.

### 3.6 Compliance details table (lower half)
A second table showing the raw per-site `compliance_details` measurement — the
*expected* records that drive all the diff/status logic above. It has its own
**Export CSV** button.

### 3.7 TTP sites
TTP sites host both Quicktron and HAI bots. On those sites the viewer shows
only HAI bots (rows whose `version` contains `hai`). RELAY sites show everything.

---

## 4. Configs page (`/configs`)

Per-bot comparison of each bot's **firmware configuration settings** against
the validation/expected values, driven entirely by the Admin page's compliance
records (§6.5).

### 4.1 Toolbar
- **Site** — pick a site, then **Load configs**. Bots load grouped by model.
- **Filter (Cmd/Ctrl+K)** — global free-text search across visible columns.

### 4.2 Model tabs
Bots are split into **HTM** and **VTM** tables shown as always-visible tabs
with counts, e.g. `HTM (24)`. Click a tab to switch instantly (no scrolling
past the other model). An **Other** tab appears if any bots are unclassified
(still loading, fetch errors, or dead/unreachable).

### 4.3 The grid
Each row is one bot. Columns (in order):

| Column | Meaning |
|---|---|
| Config | the raw firmware-config JSON (expandable) — or `SSH unreachable — no config` for unreachable bots |
| Bot ID / IP | identity |
| Model | HTM / VTM, or `dead` when the bot is unreachable |
| Status | the bot's latest status |
| Config compliance | a summary pill: `N matching` (green) or `N/M differ` (red; hover = the specific settings that differ) |
| one column per featured setting | each cell green (matches) or red (differs from expected) |

Grid conveniences (mirror the Viewer):
- **Sort** — click any column header; click again to flip order (▲/▼ shown).
- **Filter ▾** — per-column value picker (values + counts); **Apply/Clear**.
- **Columns** menu — show/hide columns (remembered per browser).
- **Chips bar** — active filters shown as removable chips with **Clear all**.
- **Showing X of Y bots** counter.

---

## 5. Operation page (`/operation`)

Where write *actions* on bots happen. Each card is independent — pick a site
first, then use any card.

- **Run alias** — opens the `gor`-on-bridge shell and runs `alias` (sanity
  check the SSH chain to the site works). Disabled until the site has the
  operations SSH chain configured (§6.4.13–16).
- **Ping bot** — pick a bot ID, resolve its IP from InfluxDB, ping it from the
  bridge.
- **Deploy VDA to bots** — load the ansible inventory from the bridge, pick an
  existing tar on the bridge or upload a new one, pick a bot section, add bot
  IPs to the basket, and **Deploy**. The full sequence streams in real time:
  read group_vars → upload tar → patch group_vars → patch inventory →
  `bash vda_deploy.sh`.
- **Bot maintenance** — pick a site, a command (drop-down is populated from the
  site's vendor: QT = systemd commands, HAI = supervisorctl commands), select
  bot IPs, **Run**. Runs 7 bots in parallel with live results.

All operations are logged to `/home/gor/3pvc-viewer/v2/server.log` and to the
per-site audit log.

---

## 6. Admin page (`/admin`) — full how-to

The control centre. **Prerequisite:** log in as `admin` and enter the unlock
passphrase (`product_validation`) once per session. Everything below writes
straight to the server (`sites.json`, `agent-recipients.json`, etc.), so use
care.

### 6.1 Usage card (top of the page)
Shows who has logged in:
- Stat cards: **Total logins**, **Unique users**, **Password logins**,
  **Email-code logins**.
- A table of the most recent logins: `Time | User | Role | Method | IP`.
- **Refresh** re-loads the list.

### 6.2 Sites table
Lists every configured site. Columns:
`Name | Agent | Vendor | Host | Database | Main measurement | Compliance measurement | Alerts | actions`

The **Alerts** cell summarises the schedule, e.g. `Daily 08:00 → 3 recip`s,
or `Off — no recipients`.

Each row has three actions:
- **Send report** — builds the compliance report for that site and emails it
  immediately (works even when scheduled alerts are off). A toast confirms the
  recipient count and incompatible/total tally.
- **Edit** — opens the site modal pre-filled (see 6.4).
- **Delete** — opens a confirmation modal. Removes the entry from `sites.json`
  only; **InfluxDB data is untouched**.

**+ Add site** (top-right of the card) opens an empty site modal.

> Sites are stored in `sites.json` on the server and shared by all pages/users.
> There is **no** site field for the configs database (`configDb`) yet — add it
> by editing `sites.json` on the server directly (see §8), then restart the service.

### 6.3 Delete-site modal
Confirms the site name, warns that only the `sites.json` entry is removed, and
gives **Delete** / **Cancel**. Esc or clicking the backdrop also cancels.

### 6.4 Add/Edit site modal
When editing, the **Name** field is locked (renaming is not supported — create
a new site instead). Password fields say *"Leave blank to keep existing"* if a
password is already stored.

| Field | Meaning / guidance |
|---|---|
| **Name** | Short key, letters/numbers/`_`/`-`. Shown in every site dropdown. |
| **Site agent type** | `TTP` or `RELAY`. Affects the version-key column (`version` vs `api_version`), reports grouping, and site logic. |
| **Vendor** | `QT` (Quicktron) or `HAI`. Determines the maintenance command set on `/operation`. |
| **Host (IP/hostname)** | The machine running InfluxDB for this site. |
| **Port** | InfluxDB HTTP port (default `8086`). |
| **Database** | The InfluxDB database the site writes into (default `GreyOrange`). |
| **Main measurement** | The measurement loaded into the Viewer's main table (default `bot_firmware_version_details`). |
| **Compliance measurement** | Where the validation team's "expected" records live (default `compliance_details`). Drives Viewer statuses, Configs compliance, and reports. |
| **Alert recipients** | Comma-separated emails for this site. Falls back to `REPORT_RECIPIENT` from `.env` if blank. |
| **Automated alerts enabled** | If on, the scheduler e-mails the report on the cadence below. The "Send report now" button works regardless. |
| **Frequency** | Daily / Weekdays (Mon–Fri) / Weekly / Hourly. |
| **Time (24h)** | When the report fires. For Hourly, only the minute matters. |
| **Day of week** | Shown for Weekly only. |
| **Butler server IP** | First hop of the operations SSH chain (reached from the jumper with the `harshal.s` key). Enables Run alias / Deploy. |
| **Target server IP** | Final hop, reached from the butler as `gor@`. |
| **gor password** | SSH password for `gor@` on the site server and bots. Stored server-side. |
| **Bot sudo password (optional)** | Only if the bots' sudo password differs (e.g. `apj@0702`). Blank = reuse gor password. |

**Save** validates the fields and writes back to `sites.json`. **Cancel** or
**Esc** closes without saving. If all three SSH fields are blank, the
Operation page's Run-alias button is disabled for the site.

### 6.5 Alert recipients by agent type
Two fieldsets (**TTP** and **RELAY**), each with `To / CC / BCC` inputs.
Comma-separated addresses; leave blank to skip that header. These are an
aggregate list that applies to **every site of that agent type** in *addition*
to each site's own Alert recipients.

- **Save** — persists both lists to `agent-recipients.json`.
- **Send now for all TTP sites** / **... for all RELAY sites** — sends ONE
  combined email per click with all sites of that agent type aggregated, and a
  separate `.xlsx` attachment per site.
- If `To` is empty, the mail's To header shows only the sender (each recipient
  receives it privately).

### 6.6 Add compliance record — the validation data entry

This is how the validation team records the **expected** values that every
other page compares against. Each submission writes one point to the selected
site's compliance measurement (`compliance_details` by default).

Step-by-step:
1. **Site** — pick a site. The page then:
   - shows the write target (`→ host:port / db / compliance measurement`),
   - **discovers that site's columns from InfluxDB** (`SHOW FIELD/TAG KEYS`,
     up to 30s; cached for 1 minute),
   - and loads the list of **live** bots for the import picker (below).
2. **Import from current bot** *(optional add-on — you can also type everything
   manually)*:
   - The dropdown lists **only live bots** — any bot whose latest `bot_status`
     is `dead_bot`, or whose version key is `dead_bot`, is excluded.
   - Pick a bot and click **Import bot data**. The form is pre-filled with that
     bot's **latest non-dead snapshot** from the last 7 days — no copy-paste.
   - Every field stays fully editable, and **Clear all fields** blanks the form.
3. **Fields** — one input per discovered column. `api_version` (or `version`
   for TTP) is marked **required** when the site's schema has it. Empty fields
   are skipped on submit.
4. **Submit** — writes one line-protocol record. A toast confirms how many
   fields were written. The form then clears, ready for the next record.

Fallback: if the site has no data yet, the field set falls back to the default
compliance list (a banner tells you so).

> Records written here immediately change Viewer statuses, the Configs
> "Config compliance" column, and the e-mailed reports — the value must match
> what the bot actually reports, using the same `api_version`/`version` key a
> bot reports.

### 6.7 Lock button
Relocks admin actions instantly without logging out. The page stays open but
all write buttons are blocked until you enter the passphrase again.

---

## 7. Common workflow examples

- **"Set up a brand-new site"** → Admin → Add site → fill §6.4 fields → Save →
  it appears in Viewer/Configs/Operation dropdowns.
- **"Add the validation record for a new deployment"** → Admin → Add compliance
  record → Site → pick a live bot → Import bot data → tweak → Submit.
- **"Is my fleet compliant after a VDA update?"** → Viewer → site → Load data →
  check stat cards and the Non-compliant bots panel; click a row for details.
- **"Which bots differ from the validated config?"** → Configs → site → Load
  configs → look at per-cell green/red and the Config compliance pill.
- **"Email a snapshot now"** → Admin → Sites → Send report (per site), or
  §6.5 "Send now for all TTP/RELAY sites".
- **"Push a new tar to some bots"** → Operation → Deploy VDA (see §5).

---

## 8. Operational notes (these are manual, server-side)

- Configs page uses per-site databases beyond the main one; the current site
  form does not expose a **Config DB / measurement** field. To serve configs
  for a site, edit `/home/gor/3pvc-viewer/v2/sites.json` on the server and add
  `configDb` (and the config measurement) to that site, then
  `sudo systemctl restart influxdb-ui-v2`.
- All logs: `/home/gor/3pvc-viewer/v2/server.log`.
- `sites.json` and `.env` hold site-specific values — never `git push` from the
  server; keep those changes local.

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Admin page read-only, buttons 403 | Unlock passphrase expired → re-enter `product_validation`. |
| "Could not load columns: … InfluxDB timed out" | `SHOW FIELD/TAG KEYS` on that site took >30s. Network reachability from the v2 server to the site's InfluxDB, or the Influx is busy. Check `telnet <ip> 8086` from the server. |
| Configs page shows `SSH unreachable — no config` / Model `dead` | The bot's firmware config was never collected (SSH to the bot failed during ingestion). Not an app fault. |
| "Failed to load inventory: Permission denied" (Operation) | SSH key not authorised on that site's butler. |
| No maintenance commands in Operation dropdown | Site has no Vendor set → Admin → edit site → Vendor → Save. |
| Bots missing from Import picker | Only live (non-dead) bots are listed by design. |
| Site dropdown empty in Viewer | No sites configured → Admin → Add site. |

---

## 10. URLs

- Viewer:    http://192.168.6.34/
- Configs:   http://192.168.6.34/configs
- Operation: http://192.168.6.34/operation
- Admin:     http://192.168.6.34/admin