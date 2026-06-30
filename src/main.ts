import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestTriggerInfo,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  TFile,
  ViewStateResult,
  WorkspaceLeaf
} from "obsidian";

const VIEW_TYPE_TASK_KANBAN = "task-list-kanban";
const STATUS_TAGS = ["now", "maybe", "later"] as const;
const FREQUENCIES = ["once", "weekly", "2week", "monthly", "quarterly", "yearly"] as const;

type TaskStatus = (typeof STATUS_TAGS)[number];
type Frequency = (typeof FREQUENCIES)[number];

interface TaskItem {
  line: number;
  text: string;
  status: TaskStatus;
  highPriority: boolean;
  checked: boolean;
}

export default class TaskKanbanPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE_TASK_KANBAN, (leaf) => new TaskKanbanView(leaf, this));
    this.registerEditorSuggest(new ReminderSuggest(this.app));

    this.addRibbonIcon("layout-kanban", "Open task kanban", () => this.openBoardForActiveFile());

    this.addCommand({
      id: "open-task-kanban",
      name: "Open task kanban for current note",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) void this.openBoardForActiveFile();
        return true;
      }
    });

    this.addCommand({
      id: "normalize-task-list-note",
      name: "Normalize current task-list note",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) void this.normalizeTaskListFile(file, true);
        return true;
      }
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASK_KANBAN);
  }

  getActiveMarkdownFile(): TFile | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file ?? this.app.workspace.getActiveFile();
  }

  async openBoardForActiveFile() {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("Open a task-list note first.");
      return;
    }

    if (!(await this.isTaskListFile(file))) {
      new Notice("This note needs frontmatter: type: task-list");
      return;
    }

    await this.normalizeTaskListFile(file, false);

    const leaf = this.app.workspace.getLeaf("split");
    await leaf.setViewState({
      type: VIEW_TYPE_TASK_KANBAN,
      active: true,
      state: { file: file.path }
    });

    const view = leaf.view;
    if (view instanceof TaskKanbanView) {
      await view.setSourceFile(file);
    }
  }

  async isTaskListFile(file: TFile): Promise<boolean> {
    const cacheType = this.app.metadataCache.getFileCache(file)?.frontmatter?.type;
    if (cacheType === "task-list") return true;

    const content = await this.app.vault.cachedRead(file);
    return /^---\n[\s\S]*?\ntype:\s*task-list\s*(?:\n[\s\S]*?)?\n---/m.test(content);
  }

  async normalizeTaskListFile(file: TFile, showNotice: boolean) {
    if (!(await this.isTaskListFile(file))) {
      if (showNotice) new Notice("This note needs frontmatter: type: task-list");
      return;
    }

    const content = await this.app.vault.read(file);
    const normalized = normalizeTaskListContent(content);
    if (normalized !== content) {
      await this.app.vault.modify(file, normalized);
      if (showNotice) new Notice("Task-list note normalized.");
    } else if (showNotice) {
      new Notice("Nothing to normalize.");
    }
  }
}

class TaskKanbanView extends ItemView {
  private sourceFile: TFile | null = null;
  private plugin: TaskKanbanPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: TaskKanbanPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_TASK_KANBAN;
  }

  getDisplayText() {
    return "Task Kanban";
  }

  async setState(state: { file?: string }, result: ViewStateResult) {
    await super.setState(state, result);
    if (state.file) {
      const file = this.app.vault.getAbstractFileByPath(state.file);
      if (file instanceof TFile) {
        this.sourceFile = file;
      }
    }
  }

  getState() {
    return {
      ...super.getState(),
      file: this.sourceFile?.path
    };
  }

  async onOpen() {
    await this.render();
  }

  async setSourceFile(file: TFile) {
    this.sourceFile = file;
    await this.render();
  }

  async render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("task-kanban");

    const file = this.sourceFile ?? this.plugin.getActiveMarkdownFile();
    if (!file || !(await this.plugin.isTaskListFile(file))) {
      container.createEl("p", { text: "Open a note with frontmatter type: task-list." });
      return;
    }

    this.sourceFile = file;
    await this.plugin.normalizeTaskListFile(file, false);

    const content = await this.app.vault.read(file);
    const tasks = parseTasks(content);

    const header = container.createDiv({ cls: "task-kanban__header" });
    header.createDiv({ cls: "task-kanban__title", text: file.basename });
    const refreshButton = header.createEl("button", { text: "Refresh" });
    refreshButton.addEventListener("click", () => void this.render());

    const columns = container.createDiv({ cls: "task-kanban__columns" });
    for (const status of STATUS_TAGS) {
      this.renderColumn(columns, status, tasks.filter((task) => task.status === status));
    }
  }

  private renderColumn(parent: HTMLElement, status: TaskStatus, tasks: TaskItem[]) {
    const column = parent.createDiv({ cls: "task-kanban__column" });
    column.dataset.status = status;

    const header = column.createDiv({ cls: "task-kanban__column-header" });
    header.createSpan({ text: `#${status}` });
    header.createSpan({ text: String(tasks.length) });

    const cards = column.createDiv({ cls: "task-kanban__cards" });
    cards.addEventListener("dragover", (event) => event.preventDefault());
    cards.addEventListener("drop", (event) => {
      event.preventDefault();
      const line = Number(event.dataTransfer?.getData("text/plain"));
      if (Number.isInteger(line)) {
        void this.moveTaskToStatus(line, status);
      }
    });

    const sortedTasks = [...tasks].sort((a, b) => Number(b.highPriority) - Number(a.highPriority) || a.line - b.line);
    if (sortedTasks.length === 0) {
      cards.createDiv({ cls: "task-kanban__empty", text: "No tasks" });
      return;
    }

    for (const task of sortedTasks) {
      const card = cards.createDiv({
        cls: `task-kanban__card${task.highPriority ? " task-kanban__card--high" : ""}`
      });
      card.draggable = true;
      card.dataset.line = String(task.line);
      card.ariaLabel = `${task.checked ? "Completed" : "Open"} task: ${task.text}`;
      card.createDiv({ cls: "task-kanban__card-text", text: task.text });
      const statusSelect = card.createEl("select", { cls: "task-kanban__status-select" });
      for (const optionStatus of STATUS_TAGS) {
        statusSelect.createEl("option", {
          value: optionStatus,
          text: `#${optionStatus}`
        });
      }
      statusSelect.value = task.status;
      statusSelect.addEventListener("change", () => void this.moveTaskToStatus(task.line, statusSelect.value as TaskStatus));
      card.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData("text/plain", String(task.line));
      });
    }
  }

  private async moveTaskToStatus(line: number, status: TaskStatus) {
    if (!this.sourceFile) return;

    const content = await this.app.vault.read(this.sourceFile);
    const lines = content.split("\n");
    const current = lines[line];
    if (!current) return;

    lines[line] = setTaskStatusTag(current, status);
    await this.app.vault.modify(this.sourceFile, lines.join("\n"));
    await this.render();
  }
}

class ReminderSuggest extends EditorSuggest<string> {
  constructor(app: App) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line).slice(0, cursor.ch);
    const match = line.match(/@(date|reminder)$/);
    if (!match) return null;

    return {
      start: { line: cursor.line, ch: cursor.ch - match[0].length },
      end: cursor,
      query: match[0]
    };
  }

  getSuggestions(): string[] {
    return ["Insert reminder"];
  }

  renderSuggestion(value: string, el: HTMLElement) {
    el.setText(value);
  }

  selectSuggestion(_: string) {
    const context = this.context;
    if (!context) return;

    new ReminderModal(this.app, (token) => {
      context.editor.replaceRange(token, context.start, context.end);
    }).open();
  }
}

class ReminderModal extends Modal {
  private onSubmit: (token: string) => void;

  constructor(app: App, onSubmit: (token: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Reminder" });

    const form = contentEl.createEl("form", { cls: "task-kanban-reminder" });
    const dateLabel = form.createEl("label", { text: "Date" });
    const dateInput = dateLabel.createEl("input", { type: "date" });
    dateInput.value = todayIsoDate();

    const frequencyLabel = form.createEl("label", { text: "Frequency" });
    const frequencySelect = frequencyLabel.createEl("select");
    for (const frequency of FREQUENCIES) {
      frequencySelect.createEl("option", {
        value: frequency,
        text: frequency
      });
    }

    const actions = form.createDiv({ cls: "task-kanban-reminder__actions" });
    const cancel = actions.createEl("button", { text: "Cancel", type: "button" });
    const submit = actions.createEl("button", { text: "Insert", type: "submit" });
    submit.addClass("mod-cta");

    cancel.addEventListener("click", () => this.close());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const frequency = frequencySelect.value as Frequency;
      this.onSubmit(`@reminder(${dateInput.value}, ${frequency})`);
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

function parseTasks(content: string): TaskItem[] {
  const lines = content.split("\n");
  const frontmatter = getFrontmatterRange(lines);
  const tasks: TaskItem[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (isInRange(index, frontmatter)) continue;

    const text = getTaskText(lines[index]);
    if (!text) continue;

    const status = getStatus(text);
    tasks.push({
      line: index,
      text,
      status,
      highPriority: /(^|\s)#high\b/.test(text),
      checked: /^\s*-\s*\[[xX]\]/.test(lines[index])
    });
  }

  return tasks;
}

function normalizeTaskListContent(content: string): string {
  const lines = content.split("\n");
  const frontmatter = getFrontmatterRange(lines);
  let inCodeBlock = false;

  return lines
    .map((line, index) => {
      if (isInRange(index, frontmatter)) return line;
      if (/^\s*```/.test(line)) {
        inCodeBlock = !inCodeBlock;
        return line;
      }
      if (inCodeBlock || shouldSkipLine(line)) return line;
      return normalizeTaskLine(line);
    })
    .join("\n");
}

function normalizeTaskLine(line: string): string {
  const indentation = line.match(/^\s*/)?.[0] ?? "";
  const trimmed = line.trim();
  const checkedMatch = trimmed.match(/^-\s*\[[xX]\]\s+(.+)$/);
  if (checkedMatch) return `${indentation}- [x] ${checkedMatch[1]}`;

  const uncheckedMatch = trimmed.match(/^-\s*(?:\[\s?\]|\[ \])?\s*(.+)$/);
  if (uncheckedMatch) return `${indentation}- [ ] ${uncheckedMatch[1]}`;

  return `${indentation}- [ ] ${trimmed}`;
}

function getTaskText(line: string): string | null {
  const trimmed = line.trim();
  const taskMatch = trimmed.match(/^-\s*(?:\[[ xX]?\]|\[\])?\s*(.+)$/);
  if (taskMatch) return taskMatch[1].trim();
  if (shouldSkipLine(line)) return null;
  return trimmed;
}

function getStatus(text: string): TaskStatus {
  for (const status of STATUS_TAGS) {
    if (new RegExp(`(^|\\s)#${status}\\b`).test(text)) return status;
  }
  return "maybe";
}

function setTaskStatusTag(line: string, status: TaskStatus): string {
  const withoutStatus = line.replace(/\s#(?:now|maybe|later)\b/g, "").trimEnd();
  return `${withoutStatus} #${status}`;
}

function getFrontmatterRange(lines: string[]): { start: number; end: number } | null {
  if (lines[0] !== "---") return null;

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      return { start: 0, end: index };
    }
  }

  return null;
}

function isInRange(index: number, range: { start: number; end: number } | null): boolean {
  return range !== null && index >= range.start && index <= range.end;
}

function shouldSkipLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith(">") || trimmed.startsWith("|");
}

function todayIsoDate(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
