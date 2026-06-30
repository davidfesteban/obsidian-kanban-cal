# Task List Kanban Calendar

First implementation of an Obsidian plugin that turns notes with `type: task-list` frontmatter into a kanban view.

## Note format

```md
---
type: task-list
---

- Pay invoice #now #high @schedule(2026-07-04, monthly)
- Try new idea #maybe
- Later task #later
```

Accepted shorthand lines are normalized to Obsidian tasks when the board opens:

```md
- Element
- [] Element
Element
```

becomes:

```md
- [ ] Element
```

Use `@date` or `@schedule` in the editor to open the date/time/frequency picker. The picker replaces the trigger with `@schedule(YYYY-MM-DD, frequency)` or `@schedule(YYYY-MM-DD HH:mm, frequency)`.

The kanban board hides status/priority tags on cards, lets you complete tasks with a checkbox, and includes Default, 90s grey blue, modern pixel, and minimalist themes in plugin settings.

## Calendar

Plugin settings accepts public `.ics` calendar URLs, one per line. Apple `webcal://` links are accepted and fetched as `https://`. The schedule picker uses them read-only to show busy slots for the selected date.

On desktop, enable the local `.ics` feed and subscribe Apple Calendar to:

```text
http://127.0.0.1:8765/tasks.ics
```

The feed exports unchecked tasks with `@schedule(...)`; checked tasks are omitted.
