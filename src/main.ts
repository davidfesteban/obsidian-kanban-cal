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
  Platform,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TFile,
  ViewStateResult,
  WorkspaceLeaf
} from "obsidian";

const VIEW_TYPE_TASK_KANBAN = "task-list-kanban";
const STATUS_TAGS = ["now", "maybe", "later"] as const;
const FREQUENCIES = ["once", "weekly", "2week", "monthly", "quarterly", "yearly"] as const;
const BOARD_THEMES = ["default", "90s", "pixel", "minimal"] as const;

type TaskStatus = (typeof STATUS_TAGS)[number];
type Frequency = (typeof FREQUENCIES)[number];
type BoardTheme = (typeof BOARD_THEMES)[number];

interface TaskKanbanSettings {
  theme: BoardTheme;
  calendarUrls: string;
  feedEnabled: boolean;
  feedPort: number;
  defaultDurationMinutes: number;
}

const DEFAULT_SETTINGS: TaskKanbanSettings = {
  theme: "default",
  calendarUrls: "",
  feedEnabled: false,
  feedPort: 8765,
  defaultDurationMinutes: 30
};

interface LocalHttpServer {
  close(callback?: () => void): void;
  listen(port: number, host: string, callback?: () => void): void;
  on(event: "error", listener: (error: Error & { code?: string }) => void): void;
}

interface TaskItem {
  line: number;
  text: string;
  status: TaskStatus;
  highPriority: boolean;
  checked: boolean;
}

interface CalendarEvent {
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
}

interface ScheduledTask {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  frequency: Frequency;
  filePath: string;
  line: number;
}

export default class TaskKanbanPlugin extends Plugin {
  settings: TaskKanbanSettings = DEFAULT_SETTINGS;
  private feedServer: LocalHttpServer | null = null;

  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE_TASK_KANBAN, (leaf) => new TaskKanbanView(leaf, this));
    this.registerEditorSuggest(new ScheduleSuggest(this.app, this));
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, view) => {
        if (view instanceof MarkdownView) this.normalizeCurrentEditorLine(editor, view);
      })
    );
    this.addSettingTab(new TaskKanbanSettingTab(this.app, this));

    this.addRibbonIcon("dice", "Open task kanban", () => this.openBoardForActiveFile());

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

    this.addCommand({
      id: "show-local-calendar-feed-url",
      name: "Show local calendar feed URL",
      callback: () => new Notice(this.getFeedUrl())
    });

    this.addCommand({
      id: "restart-local-calendar-feed",
      name: "Restart local calendar feed",
      callback: () => void this.restartFeedServer()
    });

    await this.restartFeedServer();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    await this.restartFeedServer();
    this.app.workspace.getLeavesOfType(VIEW_TYPE_TASK_KANBAN).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof TaskKanbanView) void view.render();
    });
  }

  onunload() {
    this.stopFeedServer();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASK_KANBAN);
  }

  getFeedUrl(): string {
    return `http://127.0.0.1:${this.settings.feedPort}/tasks.ics`;
  }

  getCalendarUrls(): string[] {
    return this.settings.calendarUrls
      .split(/\r?\n/)
      .map((url) => url.trim())
      .filter(Boolean);
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

  async fetchBusyEvents(date: string): Promise<CalendarEvent[]> {
    const urls = this.getCalendarUrls();
    if (urls.length === 0) return [];

    const eventGroups = await Promise.all(
      urls.map(async (url) => {
        try {
          const response = await requestUrl({ url });
          return parseCalendarEvents(response.text, date);
        } catch {
          new Notice(`Could not read calendar: ${url}`);
          return [];
        }
      })
    );

    return eventGroups.flat().sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  async generateCalendarFeed(): Promise<string> {
    const events: ScheduledTask[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!(await this.isTaskListFile(file))) continue;
      const content = await this.app.vault.cachedRead(file);
      events.push(...parseScheduledTasks(file, content, this.settings.defaultDurationMinutes));
    }

    return buildCalendarFeed(events);
  }

  private async restartFeedServer() {
    this.stopFeedServer();
    if (!this.settings.feedEnabled) return;

    if (!Platform.isDesktopApp) {
      new Notice("Local calendar feed is only available on desktop.");
      return;
    }

    try {
      const http = require("http") as typeof import("http");
      const server = http.createServer(async (request, response) => {
        if (request.url !== "/tasks.ics") {
          response.writeHead(404);
          response.end("Not found");
          return;
        }

        try {
          const feed = await this.generateCalendarFeed();
          response.writeHead(200, {
            "Content-Type": "text/calendar; charset=utf-8",
            "Cache-Control": "no-store"
          });
          response.end(feed);
        } catch (error) {
          response.writeHead(500);
          response.end(error instanceof Error ? error.message : "Could not build calendar feed");
        }
      });

      server.on("error", (error) => {
        new Notice(`Calendar feed failed: ${error.message}`);
      });
      server.listen(this.settings.feedPort, "127.0.0.1", () => {
        new Notice(`Calendar feed: ${this.getFeedUrl()}`);
      });
      this.feedServer = server;
    } catch {
      new Notice("Could not start local calendar feed.");
    }
  }

  private stopFeedServer() {
    if (!this.feedServer) return;
    this.feedServer.close();
    this.feedServer = null;
  }

  private normalizeCurrentEditorLine(editor: Editor, view: MarkdownView) {
    const file = view.file;
    if (!file) return;

    const cacheType = this.app.metadataCache.getFileCache(file)?.frontmatter?.type;
    if (cacheType !== "task-list") return;

    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    const normalized = normalizeLiveTaskLine(line);
    if (!normalized || normalized === line) return;

    editor.replaceRange(normalized, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
    editor.setCursor({ line: cursor.line, ch: normalized.length });
  }
}

class TaskKanbanSettingTab extends PluginSettingTab {
  plugin: TaskKanbanPlugin;

  constructor(app: App, plugin: TaskKanbanPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "Task List Kanban Calendar" });
    this.containerEl.createEl("p", {
      text: "Use frontmatter type: task-list to turn note tasks into #now, #maybe, and #later columns."
    });
    this.containerEl.createEl("p", {
      text: "Plain lines and bullets are normalized to - [ ] tasks, #high sorts first, and dragging cards updates status tags."
    });
    this.containerEl.createEl("p", {
      text: "Type @date or @schedule to pick a date/time, see public calendar busy slots, and insert @schedule(...)."
    });

    new Setting(this.containerEl)
      .setName("Board theme")
      .setDesc("Choose the visual style for the kanban board.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("default", "Default")
          .addOption("90s", "90s grey blue")
          .addOption("pixel", "Modern pixel")
          .addOption("minimal", "Minimal clean")
          .setValue(this.plugin.settings.theme)
          .onChange(async (value) => {
            this.plugin.settings.theme = value as BoardTheme;
            await this.plugin.saveSettings();
          });
      });

    new Setting(this.containerEl)
      .setName("Public calendar .ics URLs")
      .setDesc("One URL per line. These are read-only and used to show busy slots in the schedule picker.")
      .addTextArea((text) => {
        text
          .setPlaceholder("https://pXX-caldav.icloud.com/published/2/...")
          .setValue(this.plugin.settings.calendarUrls)
          .onChange(async (value) => {
            this.plugin.settings.calendarUrls = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.addClass("task-kanban-settings__calendar-urls");
      });

    new Setting(this.containerEl)
      .setName("Default event duration")
      .setDesc("Used when scheduled tasks include a time.")
      .addText((text) => {
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.defaultDurationMinutes))
          .onChange(async (value) => {
            const duration = Number(value);
            if (!Number.isFinite(duration) || duration < 1) return;
            this.plugin.settings.defaultDurationMinutes = Math.round(duration);
            await this.plugin.saveSettings();
          });
      });

    new Setting(this.containerEl)
      .setName("Local .ics feed")
      .setDesc(`Desktop only. Apple Calendar can try subscribing to ${this.plugin.getFeedUrl()}.`)
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.feedEnabled).onChange(async (value) => {
          this.plugin.settings.feedEnabled = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(this.containerEl)
      .setName("Local feed port")
      .setDesc("Change only if the port is already used.")
      .addText((text) => {
        text
          .setPlaceholder("8765")
          .setValue(String(this.plugin.settings.feedPort))
          .onChange(async (value) => {
            const port = Number(value);
            if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
            this.plugin.settings.feedPort = port;
            await this.plugin.saveSettings();
          });
      });
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
    container.removeClass("task-kanban--default");
    container.removeClass("task-kanban--90s");
    container.removeClass("task-kanban--pixel");
    container.removeClass("task-kanban--minimal");
    container.addClass("task-kanban");
    container.addClass(`task-kanban--${this.plugin.settings.theme}`);

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
    header.createSpan({ text: getStatusLabel(status) });
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

    const sortedTasks = [...tasks].sort(
      (a, b) => Number(a.checked) - Number(b.checked) || Number(b.highPriority) - Number(a.highPriority) || a.line - b.line
    );
    if (sortedTasks.length === 0) {
      cards.createDiv({ cls: "task-kanban__empty", text: "No tasks" });
      return;
    }

    for (const task of sortedTasks) {
      const card = cards.createDiv({
        cls: `task-kanban__card${task.highPriority ? " task-kanban__card--high" : ""}${task.checked ? " task-kanban__card--checked" : ""}`
      });
      card.draggable = true;
      card.dataset.line = String(task.line);
      card.ariaLabel = `${task.checked ? "Completed" : "Open"} task: ${task.text}`;
      const checkbox = card.createEl("input", { cls: "task-kanban__checkbox", attr: { type: "checkbox" } });
      checkbox.checked = task.checked;
      checkbox.addEventListener("change", () => void this.toggleTaskChecked(task.line, checkbox.checked));
      card.createDiv({ cls: "task-kanban__card-text", text: getCardDisplayText(task.text) });
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

  private async toggleTaskChecked(line: number, checked: boolean) {
    if (!this.sourceFile) return;

    const content = await this.app.vault.read(this.sourceFile);
    const lines = content.split("\n");
    const current = lines[line];
    if (!current) return;

    lines[line] = setTaskChecked(current, checked);
    await this.app.vault.modify(this.sourceFile, lines.join("\n"));
    await this.render();
  }
}

class ScheduleSuggest extends EditorSuggest<string> {
  private plugin: TaskKanbanPlugin;

  constructor(app: App, plugin: TaskKanbanPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line).slice(0, cursor.ch);
    const match = line.match(/@(date|schedule)$/);
    if (!match) return null;

    return {
      start: { line: cursor.line, ch: cursor.ch - match[0].length },
      end: cursor,
      query: match[0]
    };
  }

  getSuggestions(): string[] {
    return ["Insert schedule"];
  }

  renderSuggestion(value: string, el: HTMLElement) {
    el.setText(value);
  }

  selectSuggestion(_: string) {
    const context = this.context;
    if (!context) return;

    new ScheduleModal(this.app, this.plugin, (token) => {
      context.editor.replaceRange(token, context.start, context.end);
    }).open();
  }
}

class ScheduleModal extends Modal {
  private plugin: TaskKanbanPlugin;
  private onSubmit: (token: string) => void;
  private busyEl: HTMLElement | null = null;
  private dateInput: HTMLInputElement | null = null;
  private timeInput: HTMLInputElement | null = null;

  constructor(app: App, plugin: TaskKanbanPlugin, onSubmit: (token: string) => void) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Schedule" });

    const form = contentEl.createEl("form", { cls: "task-kanban-reminder" });
    const dateLabel = form.createEl("label", { text: "Date" });
    const dateInput = dateLabel.createEl("input", { attr: { type: "date" } });
    dateInput.value = todayIsoDate();
    this.dateInput = dateInput;

    const timeLabel = form.createEl("label", { text: "Time optional" });
    const timeInput = timeLabel.createEl("input", { attr: { type: "time" } });
    this.timeInput = timeInput;

    const frequencyLabel = form.createEl("label", { text: "Frequency" });
    const frequencySelect = frequencyLabel.createEl("select");
    for (const frequency of FREQUENCIES) {
      frequencySelect.createEl("option", {
        value: frequency,
        text: frequency
      });
    }

    this.busyEl = form.createDiv({ cls: "task-kanban-schedule__busy" });
    dateInput.addEventListener("change", () => void this.renderBusySlots());
    void this.renderBusySlots();

    const actions = form.createDiv({ cls: "task-kanban-reminder__actions" });
    const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
    const submit = actions.createEl("button", { text: "Insert", attr: { type: "submit" } });
    submit.addClass("mod-cta");

    cancel.addEventListener("click", () => this.close());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const frequency = frequencySelect.value as Frequency;
      const dateTime = timeInput.value ? `${dateInput.value} ${timeInput.value}` : dateInput.value;
      this.onSubmit(`@schedule(${dateTime}, ${frequency})`);
      this.close();
    });
  }

  private async renderBusySlots() {
    if (!this.busyEl || !this.dateInput) return;

    const date = this.dateInput.value;
    this.busyEl.empty();
    this.busyEl.createDiv({ cls: "task-kanban-schedule__busy-title", text: "Busy slots" });

    if (this.plugin.getCalendarUrls().length === 0) {
      this.busyEl.createDiv({ cls: "task-kanban-schedule__busy-empty", text: "Add public .ics calendar URLs in plugin settings." });
      return;
    }

    this.busyEl.createDiv({ cls: "task-kanban-schedule__busy-empty", text: "Loading..." });
    const events = await this.plugin.fetchBusyEvents(date);

    this.busyEl.empty();
    this.busyEl.createDiv({ cls: "task-kanban-schedule__busy-title", text: "Busy slots" });
    if (events.length === 0) {
      this.busyEl.createDiv({ cls: "task-kanban-schedule__busy-empty", text: "No busy slots for this day." });
      return;
    }

    for (const event of events) {
      const slot = this.busyEl.createEl("button", {
        cls: "task-kanban-schedule__busy-slot",
        attr: { type: "button" }
      });
      slot.createSpan({ text: formatBusySlot(event) });
      slot.createSpan({ text: event.title });
      slot.addEventListener("click", () => {
        if (!this.timeInput) return;
        this.timeInput.value = formatTime(event.end);
      });
    }
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

function getStatusLabel(status: TaskStatus): string {
  if (status === "now") return "Now";
  if (status === "later") return "Later";
  return "Maybe";
}

function setTaskStatusTag(line: string, status: TaskStatus): string {
  const withoutStatus = line.replace(/\s#(?:now|maybe|later)\b/g, "").trimEnd();
  return `${withoutStatus} #${status}`;
}

function setTaskChecked(line: string, checked: boolean): string {
  const marker = checked ? "x" : " ";
  const taskMatch = line.match(/^(\s*-\s*)\[[ xX]?\](.*)$/);
  if (taskMatch) return `${taskMatch[1]}[${marker}]${taskMatch[2]}`;

  const bulletMatch = line.match(/^(\s*-\s+)(.*)$/);
  if (bulletMatch) return `${bulletMatch[1]}[${marker}] ${bulletMatch[2]}`;

  return `- [${marker}] ${line.trim()}`;
}

function getCardDisplayText(text: string): string {
  return text.replace(/(^|\s)#(?:now|maybe|later|high)\b/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeLiveTaskLine(line: string): string | null {
  const shorthand = line.match(/^(\s*)-\s*\[\]\s+(.+)$/);
  if (shorthand) return `${shorthand[1]}- [ ] ${shorthand[2].trimStart()}`;

  const bullet = line.match(/^(\s*)-\s+(?!\[[ xX]?\]\s)(.+)$/);
  if (bullet) return `${bullet[1]}- [ ] ${bullet[2].trimStart()}`;

  return null;
}

function parseScheduledTasks(file: TFile, content: string, defaultDurationMinutes: number): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];
  const lines = content.split("\n");
  const frontmatter = getFrontmatterRange(lines);

  for (let index = 0; index < lines.length; index += 1) {
    if (isInRange(index, frontmatter) || /^\s*-\s*\[[xX]\]/.test(lines[index])) continue;

    const text = getTaskText(lines[index]);
    const schedule = text ? parseSchedule(text, defaultDurationMinutes) : null;
    if (!text || !schedule) continue;

    const title = getCardDisplayText(text.replace(/@schedule\([^)]+\)/g, "")).trim();
    tasks.push({
      uid: `${hashString(`${file.path}:${index}:${text}`)}@task-list-kanban-cal`,
      title: title || file.basename,
      start: schedule.start,
      end: schedule.end,
      allDay: schedule.allDay,
      frequency: schedule.frequency,
      filePath: file.path,
      line: index
    });
  }

  return tasks;
}

function parseSchedule(text: string, defaultDurationMinutes: number): { start: Date; end: Date; allDay: boolean; frequency: Frequency } | null {
  const match = text.match(/@schedule\((\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?\s*,\s*(once|weekly|2week|monthly|quarterly|yearly)\)/);
  if (!match) return null;

  const [, date, time, frequency] = match;
  if (time) {
    const start = new Date(`${date}T${time}:00`);
    const end = new Date(start.getTime() + defaultDurationMinutes * 60 * 1000);
    return { start, end, allDay: false, frequency: frequency as Frequency };
  }

  const start = parseLocalDate(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end, allDay: true, frequency: frequency as Frequency };
}

function parseCalendarEvents(ics: string, date: string): CalendarEvent[] {
  const targetStart = parseLocalDate(date);
  const targetEnd = new Date(targetStart);
  targetEnd.setDate(targetEnd.getDate() + 1);

  return readVEvents(ics)
    .flatMap((event) => expandCalendarEvent(event, targetStart, targetEnd))
    .filter((event) => event.end > targetStart && event.start < targetEnd);
}

function readVEvents(ics: string): Record<string, string>[] {
  const lines = unfoldIcsLines(ics);
  const events: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).split(";")[0];
    current[key] = line.slice(separator + 1);
  }

  return events;
}

function expandCalendarEvent(raw: Record<string, string>, rangeStart: Date, rangeEnd: Date): CalendarEvent[] {
  const startRaw = raw.DTSTART;
  if (!startRaw) return [];

  const start = parseIcsDate(startRaw);
  const end = raw.DTEND ? parseIcsDate(raw.DTEND) : new Date(start.getTime() + 60 * 60 * 1000);
  const allDay = /^\d{8}$/.test(startRaw);
  const title = unescapeIcsText(raw.SUMMARY || "Busy");
  const duration = end.getTime() - start.getTime();
  const rrule = parseRRule(raw.RRULE);

  if (!rrule) return [{ title, start, end, allDay }];

  const events: CalendarEvent[] = [];
  let cursor = new Date(start);
  let count = 0;
  const maxCount = rrule.count ?? 500;
  const until = rrule.until ?? rangeEnd;

  while (cursor <= rangeEnd && cursor <= until && count < maxCount) {
    const instanceEnd = new Date(cursor.getTime() + duration);
    if (instanceEnd > rangeStart && cursor < rangeEnd) {
      events.push({ title, start: new Date(cursor), end: instanceEnd, allDay });
    }
    cursor = addFrequency(cursor, rrule.frequency, rrule.interval);
    count += 1;
  }

  return events;
}

function buildCalendarFeed(tasks: ScheduledTask[]): string {
  const now = formatIcsDateTime(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Task List Kanban Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Obsidian Tasks"
  ];

  for (const task of tasks) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${task.uid}`,
      `DTSTAMP:${now}`,
      task.allDay ? `DTSTART;VALUE=DATE:${formatIcsDate(task.start)}` : `DTSTART:${formatIcsDateTime(task.start)}`,
      task.allDay ? `DTEND;VALUE=DATE:${formatIcsDate(task.end)}` : `DTEND:${formatIcsDateTime(task.end)}`,
      `SUMMARY:${escapeIcsText(task.title)}`,
      `DESCRIPTION:${escapeIcsText(`${task.filePath}:${task.line + 1}`)}`
    );

    const recurrence = toRRule(task.frequency);
    if (recurrence) lines.push(recurrence);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

function toRRule(frequency: Frequency): string | null {
  if (frequency === "once") return null;
  if (frequency === "weekly") return "RRULE:FREQ=WEEKLY";
  if (frequency === "2week") return "RRULE:FREQ=WEEKLY;INTERVAL=2";
  if (frequency === "monthly") return "RRULE:FREQ=MONTHLY";
  if (frequency === "quarterly") return "RRULE:FREQ=MONTHLY;INTERVAL=3";
  return "RRULE:FREQ=YEARLY";
}

function parseRRule(value?: string): { frequency: string; interval: number; count?: number; until?: Date } | null {
  if (!value) return null;
  const parts = Object.fromEntries(value.split(";").map((part) => part.split("=")));
  const frequency = parts.FREQ;
  if (!frequency) return null;

  return {
    frequency,
    interval: Number(parts.INTERVAL || 1),
    count: parts.COUNT ? Number(parts.COUNT) : undefined,
    until: parts.UNTIL ? parseIcsDate(parts.UNTIL) : undefined
  };
}

function addFrequency(date: Date, frequency: string, interval: number): Date {
  const next = new Date(date);
  if (frequency === "DAILY") next.setDate(next.getDate() + interval);
  else if (frequency === "WEEKLY") next.setDate(next.getDate() + 7 * interval);
  else if (frequency === "MONTHLY") next.setMonth(next.getMonth() + interval);
  else if (frequency === "YEARLY") next.setFullYear(next.getFullYear() + interval);
  else next.setDate(next.getDate() + 7 * interval);
  return next;
}

function unfoldIcsLines(ics: string): string[] {
  const rawLines = ics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of rawLines) {
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function parseIcsDate(value: string): Date {
  if (/^\d{8}$/.test(value)) {
    return parseLocalDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`);
  }

  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return new Date(value);

  const [, year, month, day, hour, minute, second, utc] = match;
  if (utc) return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

function parseLocalDate(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatBusySlot(event: CalendarEvent): string {
  if (event.allDay) return "All day";
  return `${formatTime(event.start)}-${formatTime(event.end)}`;
}

function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatIcsDate(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

function formatIcsDateTime(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}T${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}${String(date.getUTCSeconds()).padStart(2, "0")}Z`;
}

function escapeIcsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function unescapeIcsText(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 0) {
    chunks.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  return chunks.join("\r\n");
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
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
