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

Use `@date` or `@schedule` in the editor to open the date/frequency picker. The picker replaces the trigger with `@schedule(YYYY-MM-DD, frequency)`.

The kanban board hides status/priority tags on cards, lets you complete tasks with a checkbox, and includes Default, 90s grey blue, modern pixel, and minimalist themes in plugin settings.
