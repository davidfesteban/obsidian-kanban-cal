# Task List Kanban Calendar

Obsidian plugin for turning Markdown task-list notes into a kanban board with lightweight calendar scheduling.

## Features

- Notes with `type: task-list` become kanban boards with `Now`, `Maybe`, and `Later` columns.
- `#now`, `#maybe`, and `#later` control the column; dragging cards rewrites the tag in Markdown.
- `#high` moves a task to the top of its column, but metadata is hidden on cards.
- Plain lines and bullets normalize to Obsidian tasks, for example `-  Pay rent` becomes `- [ ] Pay rent`.
- Cards have checkboxes; completed cards are crossed out, moved to the bottom, and can be deleted in bulk.
- Type `@date` to open a date picker with optional time and recurrence.
- Public `.ics` / Apple `webcal://` calendars can be added to show busy slots in the picker.
- Desktop local `.ics` feed exports unchecked dated tasks for Apple Calendar subscription.
- `type: reminder-list` notes support dated reminders without converting bullets into checkbox tasks.
- Board themes: Default, 90s grey blue, Modern pixel, Minimal clean.

## Task Format

```md
---
type: task-list
---

- Pay invoice #now #high @date(2026-07-04 14:00, monthly)
- Try new idea #maybe
- Later task #later
```

Supported date formats:

```md
@date(2026-07-04, once)
@date(2026-07-04 14:00, weekly)
```

Frequencies:

```text
once, weekly, 2week, monthly, quarterly, yearly
```

Existing `@schedule(...)` tokens are still read for compatibility, but new inserts use `@date(...)`.

## Reminder Lists

Use `type: reminder-list` when you want calendar reminders without task checkboxes:

```md
---
type: reminder-list
---

- Dentist @date(2026-07-04 09:00, once)
- Renew insurance @date(2026-08-01, yearly)
```

Unlike `task-list`, reminder-list notes do not normalize `- Dentist` into `- [ ] Dentist`. They are included in the local `.ics` feed when they contain `@date(...)`.

## Calendar Setup

In plugin settings, paste public calendar URLs, one per line. Apple `webcal://` URLs are accepted and fetched as `https://`.

Enable the local feed on desktop and subscribe Apple Calendar to:

```text
http://127.0.0.1:8765/tasks.ics
```

The feed exports unchecked tasks with `@date(...)`. Checked tasks are omitted.

## Install From Clone

Clone this repo into your vault:

```bash
cd "/path/to/Vault/.obsidian/plugins"
git clone <repo-url> obsidian-kanban-cal
```

Then enable `Task List Kanban Calendar` in Obsidian community plugin settings. The repo tracks the built `main.js`, so cloning is enough.

## Development

```bash
npm install
npm run build
```

## Roadmap

- Smarter free-slot suggestions from calendar availability.
- Optional CalDAV push to create/update real Apple Calendar events.
- Recurring task rollover after completion.
- Better mobile drag gestures and calendar controls.
