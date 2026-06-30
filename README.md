# Task List Kanban Calendar

First implementation of an Obsidian plugin that turns notes with `type: task-list` frontmatter into a kanban view.

## Note format

```md
---
type: task-list
---

- Pay invoice #now #high @reminder(2026-07-04, monthly)
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

Use `@date` or `@reminder` in the editor to open the date/frequency picker. The picker replaces the trigger with `@reminder(YYYY-MM-DD, frequency)`.
