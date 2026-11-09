# Reports Studio

**Reports** (sidebar, under Insights; owner only) builds watch reports for a day, a week, a month or any range of dates, lets you save the ones you use, and hands them over as CSV, JSON or a printable page you can save as PDF.

## The numbers

Reports use the same engine as the **Analytics** page, so the two never disagree. Only real playback counts (paused time does not), and playback that overlapped on one device (two tabs, or the same viewing uploaded twice) is counted once. While two videos played at once, the time is shared equally between them, so video and channel totals add up to the device total. Different devices add up.

Times are stored on the server in UTC. Every date, day, week, month and hour in a report is **Sri Lanka time (Asia/Colombo, SLST, UTC+05:30)**, whatever zone your browser or the server is set to. A viewing that runs across midnight is split between the two days.

| Report | Covers |
|---|---|
| **Daily** | one day, 00:00 to 24:00 SLST; drawn by hour |
| **Weekly** | Monday to Sunday; drawn by day |
| **Monthly** | the calendar month; drawn by day |
| **Custom** | from one date to another, both included, up to 366 days; by day up to about two months, then by week, then by month |

Use **‹** and **›** to step to the previous or next period, the date box to jump, and **Current** to return to today. Each report compares itself with the period just before it (for example, this week with last week).

## Filters

- **Device**: one of your paired devices, or all of them.
- **Channel** and **Video**: the menus list what was played in the chosen period. Choosing a channel or a video counts only its **fair share** of overlapping playback. A channel's filtered total is therefore exactly the figure that channel shows in the unfiltered report, and the channels add up to the whole. You can also click a channel in the Channels list to filter to it.
- **Clear filters** goes back to everything.

Playback whose channel was never recorded appears as **(unknown)**.

The report you are looking at is part of the page address (for example `#/reports?period=week&date=2026-11-02&channel=...`), so the browser's back button and bookmarks return to it.

## Saved reports

**Save this report** stores the period type and the filters under a name (1 to 80 characters, unique). Saved **daily, weekly and monthly** reports always open on the **current** day, week or month; a saved **custom** report keeps its dates. With a saved report open, changing it offers **Update**. You can rename or delete a saved report. Deleting only removes the saved settings, never any watch data. You can keep up to 50.

Saved reports are stored encrypted, like the rest of the data (a filter can name a channel or a video).

## Download and print

**Download** offers:

| File | Contents |
|---|---|
| By day (CSV) | one row per day (or week / month for long custom ranges) |
| Viewing sessions (CSV) | every viewing in the report: device, video, channel, first and last played (UTC and SLST), watch time |
| Videos / Channels / Devices (CSV) | the totals of each |
| By hour (CSV) | 24 rows, SLST hours |
| Everything (JSON) | the whole report, with UTC millisecond timestamps |

CSV watch time is in seconds, exact to the millisecond, so the rows add up to the total. Text from YouTube (titles, channel names) that starts with `=`, `+`, `-` or `@` is prefixed with `'` so a spreadsheet never runs it as a formula. Files are UTF-8 with a byte-order mark, so Excel shows non-English titles correctly.

**Print / Save as PDF** opens a clean, light page with the summary, the day-by-day table, hours, devices, channels, videos and up to 1,000 viewings. Choose **Save as PDF** as the destination in the browser's print dialog. If your sign-in has expired while the dashboard was open, it is renewed before the page opens.

Every download and print is written to the audit log (`export_report`, with the format, the period and whether a channel or video filter was used; never the channel or title itself).

## API (owner session required)

| Method and path | Purpose |
|---|---|
| `GET /api/reports?period=day\|week\|month\|custom&date=YYYY-MM-DD&from=&to=&device=&channel=&video=` | the report as JSON |
| `GET /api/reports/export?…&format=csv\|json\|print&scope=days\|viewings\|videos\|channels\|devices\|hours` | a download, or the print page |
| `GET /api/reports/saved` | saved reports |
| `POST /api/reports/saved` `{ name, spec }` | save (201); `409 name_taken` / `too_many` |
| `PUT /api/reports/saved/:id` `{ name?, spec? }` | rename or change |
| `DELETE /api/reports/saved/:id` | delete |

Invalid input answers `400` with `error` and `field` (`bad_period`, `bad_date`, `bad_range`, `range_too_long`, `bad_device`, `bad_channel`, `bad_video`, `bad_format`, `bad_scope`, `bad_name`, `unknown_field`). A device that is not yours, or a saved report id that does not exist, answers `404` without saying which. Writes from another site are refused (`403 bad_origin`).
