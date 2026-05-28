# 3PVC UI — User guide

A short walk-through of the three pages and what each does.

URL: **http://192.168.6.34/**

## Logging in

| Account | Username | Password | Can do |
|---|---|---|---|
| Viewer | `viewer` | `viewer` | read-only — viewer + operation pages |
| Admin  | `admin`  | `apj0702` | everything + admin page (with extra unlock) |

The admin login alone isn't enough to change settings. After logging in as admin you'll see one more prompt asking for the **admin unlock passphrase** = `product_validation`. Enter it once per session. You can lock again any time via the **Lock** button at the top right.

## The three pages

```
┌──────────────────┬──────────────────┬──────────────────┐
│   /              │   /operation     │   /admin         │
│   (viewer)       │   (operations)   │   (admin)        │
├──────────────────┼──────────────────┼──────────────────┤
│  inspect         │  run actions     │  configure       │
│  bot firmware    │  on bots         │  sites,          │
│  data per site   │                  │  recipients,     │
│                  │                  │  compliance      │
└──────────────────┴──────────────────┴──────────────────┘
```

All three share one login. Links across pages are in the top bar.

---

## 1) Viewer (`/`)

### Top-bar controls
- **Site** dropdown — which InfluxDB to read from
- **Bot** dropdown — narrow to one bot (or "All bots")
- **Lookback** — time window (`1d`, `6h`, custom `48h`, etc.)
- **Row limit** — cap the query result
- **Fields ▾** — toggle which firmware columns are pulled
- **Columns ▾** — toggle which columns are visible in the table
- **Load data** — runs the query
- **Export CSV** — downloads visible rows as CSV (enabled once data is loaded)
- **Filter (Cmd/Ctrl+K)** — global free-text filter

### Stat cards (under the toolbar)
- **Total bots / Unique VDA / Compliant / Mismatched** — click any card to filter the table to that subset.

### Table
- Each row is one bot snapshot. Columns include: `time`, `bot_id`, `ip`, version key (`api_version` for RELAY, `version` for TTP), `vda_version`, all `app_*` firmware fields, the synthetic **`released_version`** (the value compliance expects), the synthetic **`status`** pill (Compatible / Incompatible / Dead), and **`expected_values`** (compliance row).
- **`vda_version` cell colour** — green when it matches compliance, red when it differs. (`kubot_master_version` gets the same treatment for HAI bots.)
- **`status` pill**:
  - `✓ Compatible` (green) — every tracked field matches compliance
  - `✗ Incompatible (N)` (red) — N fields differ, hover for diff list
  - `Dead` (grey/red) — bot reported no version → no compliance match possible
- Click any row to open the detail popover (full per-bot field comparison).

### "Latest record per bot only" checkbox
Keeps just the **most recent non-dead row** for each bot. If a bot has only dead rows in the window, it's hidden. Press <kbd>U</kbd> to toggle.

### Non-compliant bots panel
Collapsible card under the toolbar. Lists every bot that is either:
- **mismatch** — compliance matched but some field differs (shows actual → expected for the first few fields)
- **dead** — no compliance row matched (shows "no version key reported")

Badge in the header = total count.

### Compliance details (lower table)
A second view of the per-site `compliance_details` measurement — the rows that drive the diff above. Has its own Export CSV button.

### TTP sites
TTP sites typically host both QT and HAI bots; this UI shows only **HAI bots** there (rows where `version` contains `hai`). RELAY sites show everything.

---

## 2) Operation (`/operation`)

Each card is independent — pick a site at the top, then use any combination.

### Site server operations
- **Run alias** — opens `gor`-on-bridge shell and runs `alias` (sanity check that the SSH chain is reachable).
- **Ping bot** — picks a bot ID, looks up its IP from InfluxDB, pings it from the bridge via the SSH chain.

Both buttons are disabled until the site has Butler IP / Target IP / gor password configured in the admin form.

### Deploy VDA to bots
1. **Load inventory** — reads the ansible inventory + group_vars from the bridge.
2. **Existing tar on bridge** dropdown OR **upload new tar** — pick one; the other clears.
3. **vda_remote_version** — auto-fills from the tar filename, editable.
4. **emqx_mqtt_host** — pre-filled from current group_vars, editable.
5. **Bot section** — pick an ansible group (`qt_htm_production`, `hai_vtm_production`, …).
6. **Basket** — check the bot IPs you want included; they go into the basket.
7. **Deploy** — runs the full sequence (read group_vars → upload tar → patch group_vars → patch inventory → `bash vda_deploy.sh`). Progress streams in real time, one step per line.

### Bot maintenance
- Pick site → command (the dropdown auto-populates based on the site's vendor — QT shows 4 commands, HAI shows 9).
- Pick the section / bot IPs.
- Run — fans out to 7 bots in parallel, results stream in as each finishes.

All operations log to `/home/gor/3pvc-viewer/v2/server.log` and to the per-site audit log.

---

## 3) Admin (`/admin`)

**Access**: login (`admin / apj0702`) **plus** unlock passphrase (`product_validation`).

### Sites table
Columns: `Name | Agent | Vendor | Host | Database | Main measurement | Compliance measurement | Alerts | actions`
- **Send report** (per row) — generates the per-site compliance email immediately.
- **Edit** — opens the modal.
- **Delete** — removes from `sites.json`. InfluxDB data is not touched.
- **Add site** (top right) — empty modal.

### Site modal fields
- **Name** — short key (no spaces).
- **Site agent type** — `TTP` or `RELAY` (affects per-site logic — version field, inventory path, etc.).
- **Vendor** — `QT` or `HAI` (affects the maintenance command set on `/operation`).
- **Host / Port / Database / Main measurement** — InfluxDB endpoint.
- **Compliance measurement** — where compliance reference rows live.
- **Alert recipients** — comma-separated emails (per-site overrides).
- **Frequency / Time / Day of week** — when the scheduler runs auto-reports for this site.
- **Operations SSH chain** — Butler IP, Target IP, gor password (and optional bot sudo password) — needed for `/operation` features.

### Alert recipients by agent type
Two fieldsets (TTP and RELAY), each with `To / CC / BCC` inputs.
- **Save** — persists both lists to `agent-recipients.json`.
- **Send now for all TTP sites** / **Send now for all RELAY sites** — ONE combined email per click, with all sites of that agent type aggregated in the body and a separate xlsx attached per site.

### Add compliance record
1. Pick a site — the form repopulates with **only the columns that exist in that site's bot data** (discovered from InfluxDB).
2. Fill any subset of fields. `api_version` (or `version` for TTP) is required if the site's schema has it.
3. **Submit** — writes one InfluxDB line to the site's compliance measurement.

### Lock button (top right)
Locks admin actions immediately. The page stays open but writes are blocked until you re-enter the passphrase.

---

## Common flows

**"My bot fleet looks unhealthy"**
- `/` → site → Load data → look at the **Non-compliant bots** panel for diffs and dead bots.
- For specifics, click a row to open the detail popover.

**"I deployed a new VDA version — does it cover the fleet?"**
- `/` → site → enable **Latest record per bot only** → look at Compliant vs Mismatched stat cards.
- `vda_version` cell tells you per-bot — green/red.

**"I want to email the team a snapshot"**
- `/admin` → Sites table → **Send report** on the site row.
- Or `/admin` → Alert recipients → **Send now for all <AGENT>** for a per-agent rollup.

**"I need to push a new tar to a subset of bots"**
- `/operation` → site → **Load inventory** → Deploy VDA → pick a tar → choose section → check bots in the basket → **Deploy**.

**"Some bots are stuck — I want to restart vda on them"**
- `/operation` → site → Bot maintenance → command `vdarestart` → pick the bots → **Run** (parallel 7 at a time).

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Failed to load inventory: Permission denied" | Your SSH key isn't authorised on that site's butler. See IT-108075 / IT-108550 for the pattern. |
| "No vendor set on this site" in `/operation` maintenance dropdown | Open `/admin`, edit the site, pick a Vendor, Save. |
| Admin save buttons return 403 with "Admin actions locked" | The unlock passphrase has been forgotten. Click anywhere — page will fall back to the unlock prompt. Re-enter `product_validation`. |
| Site dropdown empty in viewer | No sites configured. Admin → Sites → Add site. |
| InfluxDB query times out | Network reachability from the v2 server to that InfluxDB host. Try `telnet <ip> 8086` on the server, file an IT ticket if blocked. |

---

## URLs

- Viewer:    http://192.168.6.34/
- Operation: http://192.168.6.34/operation
- Admin:     http://192.168.6.34/admin

Source: https://github.com/Harshal-Sandhu/3pvc-viewer
