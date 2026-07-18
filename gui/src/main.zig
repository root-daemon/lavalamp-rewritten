const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const canvas = native_sdk.canvas;
const geometry = native_sdk.geometry;
const canvas_label = "main-canvas";
const window_width: f32 = 1280;
const window_height: f32 = 820;

const app_permissions = [_][]const u8{ native_sdk.security.permission_command, native_sdk.security.permission_view };
const shell_views = [_]native_sdk.ShellView{.{
    .label = canvas_label,
    .kind = .gpu_surface,
    .fill = true,
    .role = "Lavalamp workspace",
    .accessibility_label = "Lavalamp",
    .gpu_backend = .metal,
    .gpu_pixel_format = .bgra8_unorm,
    .gpu_present_mode = .timer,
    .gpu_alpha_mode = .@"opaque",
    .gpu_color_space = .srgb,
    .gpu_vsync = true,
}};
const shell_windows = [_]native_sdk.ShellWindow{.{
    .label = "main",
    .title = "Lavalamp",
    .width = window_width,
    .height = window_height,
    .min_width = 920,
    .min_height = 640,
    .restore_state = true,
    .views = &shell_views,
}};
const shell_scene: native_sdk.ShellConfig = .{ .windows = &shell_windows };

pub const host_process_key: u64 = 100;
pub const poll_timer_key: u64 = 101;
const poll_fetch_key: u64 = 102;
const action_fetch_key: u64 = 103;
const session_fetch_key: u64 = 104;
const subagent_fetch_key: u64 = 105;
const command_fetch_key: u64 = 106;
const max_messages = 40;
const max_tools = 24;
const max_sessions = 16;
const max_subagents = 16;
const max_models = 16;
const max_command_rows = 48;
const max_questions = 8;
const max_question_options = 12;

const Role = enum { user, assistant };

pub const Message = struct {
    id: u64 = 0,
    role: Role = .assistant,
    storage: [4096]u8 = undefined,
    len: usize = 0,

    pub fn content(self: *const Message) []const u8 {
        return self.storage[0..self.len];
    }

    pub fn isUser(self: *const Message) bool {
        return self.role == .user;
    }

    fn set(self: *Message, id: u64, role: Role, text: []const u8) void {
        self.id = id;
        self.role = role;
        self.len = copyText(&self.storage, text);
    }
};

pub const Tool = struct {
    id: u64 = 0,
    name_storage: [96]u8 = undefined,
    name_len: usize = 0,
    summary_storage: [320]u8 = undefined,
    summary_len: usize = 0,
    status_storage: [24]u8 = undefined,
    status_len: usize = 0,
    failed: bool = false,
    duration_ms: u64 = 0,

    pub fn name(self: *const Tool) []const u8 {
        return self.name_storage[0..self.name_len];
    }
    pub fn summary(self: *const Tool) []const u8 {
        return self.summary_storage[0..self.summary_len];
    }
    pub fn status(self: *const Tool) []const u8 {
        return self.status_storage[0..self.status_len];
    }
};

pub const Session = struct {
    key: u64 = 0,
    id_storage: [128]u8 = undefined,
    id_len: usize = 0,
    prompt_storage: [320]u8 = undefined,
    prompt_len: usize = 0,
    selected: bool = false,

    pub fn id(self: *const Session) []const u8 {
        return self.id_storage[0..self.id_len];
    }
    pub fn prompt(self: *const Session) []const u8 {
        return self.prompt_storage[0..self.prompt_len];
    }
};

pub const Subagent = struct {
    key: u64 = 0,
    id_storage: [128]u8 = undefined,
    id_len: usize = 0,
    name_storage: [128]u8 = undefined,
    name_len: usize = 0,
    task_storage: [512]u8 = undefined,
    task_len: usize = 0,
    status_storage: [24]u8 = undefined,
    status_len: usize = 0,
    selected: bool = false,

    pub fn id(self: *const Subagent) []const u8 {
        return self.id_storage[0..self.id_len];
    }
    pub fn name(self: *const Subagent) []const u8 {
        return self.name_storage[0..self.name_len];
    }
    pub fn task(self: *const Subagent) []const u8 {
        return self.task_storage[0..self.task_len];
    }
    pub fn status(self: *const Subagent) []const u8 {
        return self.status_storage[0..self.status_len];
    }
    pub fn running(self: *const Subagent) bool {
        return std.mem.eql(u8, self.status(), "running") or std.mem.eql(u8, self.status(), "pending");
    }
};

pub const ModelChoice = struct {
    key: u64 = 0,
    id_storage: [256]u8 = undefined,
    id_len: usize = 0,
    name_storage: [256]u8 = undefined,
    name_len: usize = 0,
    selected: bool = false,

    pub fn id(self: *const ModelChoice) []const u8 {
        return self.id_storage[0..self.id_len];
    }

    pub fn name(self: *const ModelChoice) []const u8 {
        return self.name_storage[0..self.name_len];
    }
};

pub const CommandRow = struct {
    id: u64 = 0,
    storage: [512]u8 = undefined,
    len: usize = 0,

    pub fn text(self: *const CommandRow) []const u8 {
        return self.storage[0..self.len];
    }

    fn set(self: *CommandRow, id: u64, row_text: []const u8) void {
        self.id = id;
        self.len = copyText(&self.storage, row_text);
    }
};

const QuestionKind = enum { input, select, multiselect };

pub const QuestionOption = struct {
    key: u64 = 0,
    storage: [160]u8 = undefined,
    len: usize = 0,
    selected: bool = false,

    pub fn label(self: *const QuestionOption) []const u8 {
        return self.storage[0..self.len];
    }
};

pub const Question = struct {
    id_storage: [96]u8 = undefined,
    id_len: usize = 0,
    text_storage: [512]u8 = undefined,
    text_len: usize = 0,
    answer_storage: [2048]u8 = undefined,
    answer_len: usize = 0,
    kind: QuestionKind = .input,
    options: [max_question_options]QuestionOption = [_]QuestionOption{.{}} ** max_question_options,
    option_count: usize = 0,

    fn id(self: *const Question) []const u8 {
        return self.id_storage[0..self.id_len];
    }

    fn text(self: *const Question) []const u8 {
        return self.text_storage[0..self.text_len];
    }

    fn answer(self: *const Question) []const u8 {
        return self.answer_storage[0..self.answer_len];
    }
};

pub const Model = struct {
    pub const view_unbound = .{
        "connected", "cursor", "host_port", "auth_token_storage", "auth_token_len",
        "draft", "assistant_storage", "assistant_len", "thinking_storage", "thinking_len",
        "terminal_storage", "terminal_len", "error_storage", "error_len",
        "workspace_storage", "workspace_len", "model_storage", "model_len",
        "provider_storage", "provider_len", "backend_storage", "backend_len", "mode_storage", "mode_len", "permission_id_storage", "permission_id_len",
        "permission_tool_storage", "permission_tool_len", "messages", "message_count",
        "tools", "tool_count", "sessions", "session_count", "selected_session_key", "command_title_storage", "command_title_len",
        "command_rows", "command_row_count", "subagents", "subagent_count", "selected_subagent_key",
        "subagent_transcript_storage", "subagent_transcript_len", "model_choices", "model_choice_count",
        "total_tokens", "total_cost", "assistantText", "authToken",
        "permissionId", "hasMessages",
        "question_request_id_storage", "question_request_id_len", "questions", "question_count", "question_index",
        "question_answer", "question_error_storage", "question_error_len", "currentQuestion",
        "inspector_visible",
    };

    connected: bool = false,
    processing: bool = false,
    cursor: u64 = 0,
    host_port: u16 = 0,
    auth_token_storage: [128]u8 = undefined,
    auth_token_len: usize = 0,
    draft: canvas.TextBuffer(8192) = .{},
    assistant_storage: [65536]u8 = undefined,
    assistant_len: usize = 0,
    thinking_storage: [16384]u8 = undefined,
    thinking_len: usize = 0,
    terminal_storage: [16384]u8 = undefined,
    terminal_len: usize = 0,
    error_storage: [1024]u8 = undefined,
    error_len: usize = 0,
    workspace_storage: [1024]u8 = undefined,
    workspace_len: usize = 0,
    model_storage: [256]u8 = undefined,
    model_len: usize = 0,
    provider_storage: [96]u8 = undefined,
    provider_len: usize = 0,
    backend_storage: [24]u8 = undefined,
    backend_len: usize = 0,
    mode_storage: [24]u8 = undefined,
    mode_len: usize = 0,
    permission_pending: bool = false,
    permission_id_storage: [128]u8 = undefined,
    permission_id_len: usize = 0,
    permission_tool_storage: [96]u8 = undefined,
    permission_tool_len: usize = 0,
    question_request_id_storage: [128]u8 = undefined,
    question_request_id_len: usize = 0,
    questions: [max_questions]Question = [_]Question{.{}} ** max_questions,
    question_count: usize = 0,
    question_index: usize = 0,
    question_answer: canvas.TextBuffer(2048) = .{},
    question_error_storage: [256]u8 = undefined,
    question_error_len: usize = 0,
    messages: [max_messages]Message = [_]Message{.{}} ** max_messages,
    message_count: usize = 0,
    tools: [max_tools]Tool = [_]Tool{.{}} ** max_tools,
    tool_count: usize = 0,
    sessions: [max_sessions]Session = [_]Session{.{}} ** max_sessions,
    session_count: usize = 0,
    selected_session_key: u64 = 0,
    subagents: [max_subagents]Subagent = [_]Subagent{.{}} ** max_subagents,
    subagent_count: usize = 0,
    selected_subagent_key: u64 = 0,
    subagent_transcript_storage: [32768]u8 = undefined,
    subagent_transcript_len: usize = 0,
    model_choices: [max_models]ModelChoice = [_]ModelChoice{.{}} ** max_models,
    model_choice_count: usize = 0,
    command_title_storage: [96]u8 = undefined,
    command_title_len: usize = 0,
    command_rows: [max_command_rows]CommandRow = [_]CommandRow{.{}} ** max_command_rows,
    command_row_count: usize = 0,
    total_tokens: u64 = 0,
    total_cost: f64 = 0,
    inspector_visible: bool = true,

    pub fn assistantText(self: *const Model) []const u8 {
        return self.assistant_storage[0..self.assistant_len];
    }
    pub fn draftText(self: *const Model) []const u8 {
        return self.draft.text();
    }
    pub fn thinkingText(self: *const Model) []const u8 {
        return self.thinking_storage[0..self.thinking_len];
    }
    pub fn terminalText(self: *const Model) []const u8 {
        return self.terminal_storage[0..self.terminal_len];
    }
    pub fn errorText(self: *const Model) []const u8 {
        return self.error_storage[0..self.error_len];
    }
    pub fn workspaceLabel(self: *const Model) []const u8 {
        if (self.workspace_len == 0) return "Workspace unavailable";
        return std.fs.path.basename(self.workspace_storage[0..self.workspace_len]);
    }
    pub fn modelLabel(self: *const Model) []const u8 {
        if (self.model_len == 0) return "Default model";
        return self.model_storage[0..self.model_len];
    }
    pub fn providerLabel(self: *const Model) []const u8 {
        if (self.provider_len == 0) return if (self.backendIsCodex()) "Codex" else "Flue";
        return self.provider_storage[0..self.provider_len];
    }
    pub fn backendLabel(self: *const Model) []const u8 {
        if (self.backend_len == 0) return "flue";
        return self.backend_storage[0..self.backend_len];
    }
    pub fn modeLabel(self: *const Model) []const u8 {
        if (self.mode_len == 0) return "build";
        return self.mode_storage[0..self.mode_len];
    }
    pub fn authToken(self: *const Model) []const u8 {
        return self.auth_token_storage[0..self.auth_token_len];
    }
    pub fn permissionId(self: *const Model) []const u8 {
        return self.permission_id_storage[0..self.permission_id_len];
    }
    pub fn permissionTool(self: *const Model) []const u8 {
        return self.permission_tool_storage[0..self.permission_tool_len];
    }
    pub fn questionPending(self: *const Model) bool {
        return self.question_request_id_len > 0 and self.question_count > 0;
    }
    fn currentQuestion(self: *Model) ?*Question {
        if (!self.questionPending() or self.question_index >= self.question_count) return null;
        return &self.questions[self.question_index];
    }
    pub fn currentQuestionText(self: *const Model) []const u8 {
        if (!self.questionPending() or self.question_index >= self.question_count) return "";
        return self.questions[self.question_index].text();
    }
    pub fn questionAnswerText(self: *const Model) []const u8 {
        return self.question_answer.text();
    }
    pub fn questionIsInput(self: *const Model) bool {
        if (!self.questionPending() or self.question_index >= self.question_count) return false;
        return self.questions[self.question_index].kind == .input;
    }
    pub fn questionIsChoice(self: *const Model) bool {
        if (!self.questionPending() or self.question_index >= self.question_count) return false;
        return self.questions[self.question_index].kind != .input;
    }
    pub fn questionOptionItems(self: *const Model) []const QuestionOption {
        if (!self.questionPending() or self.question_index >= self.question_count) return &.{};
        const question = &self.questions[self.question_index];
        return question.options[0..question.option_count];
    }
    pub fn questionErrorText(self: *const Model) []const u8 {
        return self.question_error_storage[0..self.question_error_len];
    }
    pub fn hasQuestionError(self: *const Model) bool {
        return self.question_error_len > 0;
    }
    pub fn questionProgressLabel(self: *const Model, arena: std.mem.Allocator) []const u8 {
        return std.fmt.allocPrint(arena, "Question {d} of {d}", .{ self.question_index + 1, self.question_count }) catch "Question";
    }
    pub fn questionActionLabel(self: *const Model) []const u8 {
        return if (self.question_index + 1 >= self.question_count) "Submit answers" else "Next question";
    }
    pub fn questionHasPrevious(self: *const Model) bool {
        return self.questionPending() and self.question_index > 0;
    }
    pub fn commandTitle(self: *const Model) []const u8 {
        return self.command_title_storage[0..self.command_title_len];
    }
    pub fn commandRows(self: *const Model) []const CommandRow {
        return self.command_rows[0..self.command_row_count];
    }
    pub fn messageItems(self: *const Model) []const Message {
        return self.messages[0..self.message_count];
    }
    pub fn toolItems(self: *const Model) []const Tool {
        return self.tools[0..self.tool_count];
    }
    pub fn sessionItems(self: *const Model) []const Session {
        return self.sessions[0..self.session_count];
    }
    pub fn subagentItems(self: *const Model) []const Subagent {
        return self.subagents[0..self.subagent_count];
    }
    pub fn subagentTranscript(self: *const Model) []const u8 {
        return self.subagent_transcript_storage[0..self.subagent_transcript_len];
    }
    pub fn modelChoiceItems(self: *const Model) []const ModelChoice {
        return self.model_choices[0..self.model_choice_count];
    }
    fn selectedSessionId(self: *const Model) []const u8 {
        for (self.sessions[0..self.session_count]) |*session| {
            if (session.key == self.selected_session_key) return session.id();
        }
        return "";
    }
    fn selectedSubagentId(self: *const Model) []const u8 {
        for (self.subagents[0..self.subagent_count]) |*subagent| {
            if (subagent.key == self.selected_subagent_key) return subagent.id();
        }
        return "";
    }
    pub fn selectedSubagentRunning(self: *const Model) bool {
        for (self.subagents[0..self.subagent_count]) |*subagent| {
            if (subagent.key == self.selected_subagent_key) return subagent.running();
        }
        return false;
    }
    pub fn hasMessages(self: *const Model) bool {
        return self.message_count > 0;
    }
    pub fn hasAssistantText(self: *const Model) bool {
        return self.assistant_len > 0;
    }
    pub fn hasSessions(self: *const Model) bool {
        return self.session_count > 0;
    }
    pub fn hasModels(self: *const Model) bool {
        return self.model_choice_count > 0;
    }
    pub fn hasTools(self: *const Model) bool {
        return self.tool_count > 0;
    }
    pub fn hasSubagents(self: *const Model) bool {
        return self.subagent_count > 0;
    }
    pub fn hasSubagentTranscript(self: *const Model) bool {
        return self.subagent_transcript_len > 0;
    }
    pub fn hasCommandResult(self: *const Model) bool {
        return self.command_row_count > 0;
    }
    pub fn usageLabel(self: *const Model, arena: std.mem.Allocator) []const u8 {
        return std.fmt.allocPrint(arena, "{d} tokens · ${d:.4}", .{ self.total_tokens, self.total_cost }) catch "Usage unavailable";
    }
    pub fn emptyState(self: *const Model) bool {
        return self.message_count == 0;
    }
    pub fn hasError(self: *const Model) bool {
        return self.error_len > 0;
    }
    pub fn hasThinking(self: *const Model) bool {
        return self.thinking_len > 0;
    }
    pub fn hasTerminal(self: *const Model) bool {
        return self.terminal_len > 0;
    }
    pub fn sendDisabled(self: *const Model) bool {
        return !self.connected or self.processing or self.draft.isEmpty();
    }
    pub fn queueDisabled(self: *const Model) bool {
        return !self.connected or !self.processing or self.draft.isEmpty();
    }
    pub fn inspectorVisible(self: *const Model) bool {
        return self.inspector_visible;
    }
    pub fn connectionLabel(self: *const Model) []const u8 {
        if (!self.connected) return "Connecting";
        if (self.processing) return "Running";
        return "Ready";
    }
    pub fn modeIsBuild(self: *const Model) bool {
        return std.mem.eql(u8, self.modeLabel(), "build");
    }
    pub fn modeIsAsk(self: *const Model) bool {
        return std.mem.eql(u8, self.modeLabel(), "ask");
    }
    pub fn modeIsPlan(self: *const Model) bool {
        return std.mem.eql(u8, self.modeLabel(), "plan");
    }
    pub fn backendIsFlue(self: *const Model) bool {
        return std.mem.eql(u8, self.backendLabel(), "flue");
    }
    pub fn backendIsCodex(self: *const Model) bool {
        return std.mem.eql(u8, self.backendLabel(), "codex");
    }
    pub fn setAuthToken(self: *Model, text: []const u8) void {
        self.auth_token_len = copyText(&self.auth_token_storage, text);
    }
    pub fn clearCommandResult(self: *Model) void {
        self.command_title_len = 0;
        self.command_row_count = 0;
    }
};

pub const Msg = union(enum) {
    draft_edit: canvas.TextInputEvent,
    question_edit: canvas.TextInputEvent,
    question_option: u64,
    question_back,
    question_next,
    send,
    queue_prompt,
    cancel,
    new_chat,
    select_session: u64,
    select_subagent: u64,
    stop_subagent,
    command_help,
    select_model: u64,
    command_sessions,
    command_permissions,
    command_tools,
    command_usage,
    command_analytics,
    command_benchmarks,
    command_memory,
    command_workspace,
    command_skills,
    command_mcp,
    command_paste_image,
    dismiss_command,
    command_compact,
    command_undo,
    command_copy,
    starter_explain,
    starter_tests,
    starter_review,
    toggle_inspector,
    retry_connection,
    dismiss_error,
    mode_build,
    mode_ask,
    mode_plan,
    backend_flue,
    backend_codex,
    allow_permission,
    always_allow_permission,
    deny_permission,
    host_line: native_sdk.EffectLine,
    host_exit: native_sdk.EffectExit,
    poll_tick: native_sdk.EffectTimer,
    snapshot_response: native_sdk.EffectResponse,
    action_response: native_sdk.EffectResponse,
    session_response: native_sdk.EffectResponse,
    subagent_response: native_sdk.EffectResponse,
    command_response: native_sdk.EffectResponse,

    pub const view_unbound = .{ "host_line", "host_exit", "poll_tick", "snapshot_response", "action_response", "session_response", "subagent_response", "command_response" };
};

pub const Effects = native_sdk.Effects(Msg);
pub const AppUi = canvas.Ui(Msg);
pub const AppMarkup = canvas.MarkupView(Model, Msg);
pub const app_markup = @embedFile("app.native");
const LavalampApp = native_sdk.UiApp(Model, Msg);

pub fn initialModel() Model {
    return .{};
}

fn initEffects(_: *Model, fx: *Effects) void {
    spawnHost(fx);
}

fn spawnHost(fx: *Effects) void {
    fx.spawn(.{
        .key = host_process_key,
        .argv = &.{ "lavalamp", "gui-host" },
        .max_line_bytes = 16 * 1024,
        .on_line = Effects.lineMsg(.host_line),
        .on_exit = Effects.exitMsg(.host_exit),
    });
}

pub fn update(model: *Model, msg: Msg, fx: *Effects) void {
    switch (msg) {
        .draft_edit => |edit| model.draft.apply(edit),
        .question_edit => |edit| {
            model.question_answer.apply(edit);
            if (model.currentQuestion()) |question| {
                question.answer_len = copyText(&question.answer_storage, model.question_answer.text());
            }
            model.question_error_len = 0;
        },
        .question_option => |key| selectQuestionOption(model, key),
        .question_back => previousQuestion(model),
        .question_next => advanceQuestion(model, fx),
        .send => sendPrompt(model, fx),
        .queue_prompt => queuePrompt(model, fx),
        .cancel => cancelTurn(model, fx),
        .new_chat => newSession(model, fx),
        .select_session => |key| selectSession(model, key, fx),
        .select_subagent => |key| selectSubagent(model, key, fx),
        .stop_subagent => stopSubagent(model, fx),
        .command_help => sendCommand(model, fx, "/help"),
        .command_sessions => sendCommand(model, fx, "/sessions"),
        .command_permissions => sendCommand(model, fx, "/permissions"),
        .command_tools => sendCommand(model, fx, "/tools"),
        .command_usage => sendCommand(model, fx, "/usage"),
        .command_analytics => sendCommand(model, fx, "/analytics"),
        .command_benchmarks => sendCommand(model, fx, "/benchmarks"),
        .command_memory => sendCommand(model, fx, "/memory"),
        .command_workspace => sendCommand(model, fx, "/workspace"),
        .command_skills => sendCommand(model, fx, "/skills"),
        .command_mcp => sendCommand(model, fx, "/mcp"),
        .command_paste_image => sendCommand(model, fx, "/paste-image"),
        .dismiss_command => model.clearCommandResult(),
        .command_compact => sendCommand(model, fx, "/compact"),
        .command_undo => sendCommand(model, fx, "/undo"),
        .command_copy => sendCommand(model, fx, "/copy"),
        .starter_explain => setStarterDraft(model, "Explain this codebase and identify the best place to start."),
        .starter_tests => setStarterDraft(model, "Run the test suite, diagnose any failures, and fix them."),
        .starter_review => setStarterDraft(model, "Review the current changes for bugs, regressions, and missing polish."),
        .toggle_inspector => model.inspector_visible = !model.inspector_visible,
        .retry_connection => retryConnection(model, fx),
        .dismiss_error => model.error_len = 0,
        .mode_build => sendControl(model, fx, "{\"action\":\"mode\",\"mode\":\"build\"}"),
        .mode_ask => sendControl(model, fx, "{\"action\":\"mode\",\"mode\":\"ask\"}"),
        .mode_plan => sendControl(model, fx, "{\"action\":\"mode\",\"mode\":\"plan\"}"),
        .backend_flue => sendControl(model, fx, "{\"action\":\"backend\",\"backend\":\"flue\"}"),
        .backend_codex => sendControl(model, fx, "{\"action\":\"backend\",\"backend\":\"codex\"}"),
        .select_model => |key| selectModel(model, key, fx),
        .allow_permission => resolvePermission(model, fx, "allow"),
        .always_allow_permission => resolvePermission(model, fx, "always_allow"),
        .deny_permission => resolvePermission(model, fx, "deny"),
        .host_line => |line| handleHostLine(model, line, fx),
        .host_exit => |exit| {
            model.connected = false;
            if (exit.code != 0) setError(model, "Lavalamp host exited unexpectedly");
        },
        .poll_tick => |timer| {
            if (timer.outcome == .fired and model.connected) fetchSnapshot(model, fx);
        },
        .snapshot_response => |response| {
            if (response.outcome != .ok or response.status < 200 or response.status >= 300) {
                setError(model, "Could not read Lavalamp state");
                return;
            }
            if (!applySnapshotJson(model, response.body)) setError(model, "Invalid Lavalamp state response");
        },
        .action_response => |response| {
            if (response.outcome != .ok or response.status < 200 or response.status >= 300) {
                model.processing = false;
                setError(model, "Lavalamp action failed");
            }
        },
        .session_response => |response| {
            if (response.outcome != .ok or response.status < 200 or response.status >= 300) {
                setError(model, "Could not load selected session");
                return;
            }
            if (!applySessionJson(model, response.body)) setError(model, "Invalid session response");
        },
        .subagent_response => |response| {
            if (response.outcome != .ok or response.status < 200 or response.status >= 300) {
                setError(model, "Could not inspect selected subagent");
                return;
            }
            if (!applySubagentInspectionJson(model, response.body)) setError(model, "Invalid subagent response");
        },
        .command_response => |response| {
            if (response.outcome != .ok or response.status < 200 or response.status >= 300) {
                setError(model, "Lavalamp command failed");
                return;
            }
            if (!applyCommandJson(model, response.body)) setError(model, "Invalid command response");
        },
    }
}

fn handleHostLine(model: *Model, line: native_sdk.EffectLine, fx: *Effects) void {
    const prefix = "LAVALAMP_GUI_READY ";
    if (!std.mem.startsWith(u8, line.line, prefix)) return;
    var parts = std.mem.tokenizeScalar(u8, line.line[prefix.len..], ' ');
    const port_text = parts.next() orelse return;
    const token = parts.next() orelse return;
    const port = std.fmt.parseInt(u16, port_text, 10) catch return;
    model.host_port = port;
    model.setAuthToken(token);
    model.connected = true;
    model.error_len = 0;
    fx.startTimer(.{
        .key = poll_timer_key,
        .interval_ms = 350,
        .mode = .repeating,
        .on_fire = Effects.timerMsg(.poll_tick),
    });
    fetchSnapshot(model, fx);
}

fn retryConnection(model: *Model, fx: *Effects) void {
    model.error_len = 0;
    if (model.connected) {
        fetchSnapshot(model, fx);
    } else {
        spawnHost(fx);
    }
}

fn setStarterDraft(model: *Model, text: []const u8) void {
    model.draft.set(text);
}

fn authHeader(model: *const Model, buffer: []u8) []const u8 {
    return std.fmt.bufPrint(buffer, "Bearer {s}", .{model.authToken()}) catch "";
}

fn endpoint(model: *const Model, buffer: []u8, path: []const u8) []const u8 {
    return std.fmt.bufPrint(buffer, "http://127.0.0.1:{d}{s}", .{ model.host_port, path }) catch "";
}

fn fetchSnapshot(model: *const Model, fx: *Effects) void {
    var url_buffer: [160]u8 = undefined;
    var auth_buffer: [192]u8 = undefined;
    const headers = [_]std.http.Header{.{ .name = "authorization", .value = authHeader(model, &auth_buffer) }};
    fx.fetch(.{
        .key = poll_fetch_key,
        .url = endpoint(model, &url_buffer, "/v1/native/snapshot"),
        .headers = &headers,
        .timeout_ms = 4_000,
        .on_response = Effects.responseMsg(.snapshot_response),
    });
}

fn sendPrompt(model: *Model, fx: *Effects) void {
    if (model.sendDisabled()) return;
    const draft_text = model.draft.text();
    if (std.mem.startsWith(u8, std.mem.trim(u8, draft_text, " \t\r\n"), "/")) {
        sendCommand(model, fx, draft_text);
        return;
    }
    var url_buffer: [160]u8 = undefined;
    var auth_buffer: [192]u8 = undefined;
    var headers: [3]std.http.Header = undefined;
    headers[0] = .{ .name = "authorization", .value = authHeader(model, &auth_buffer) };
    headers[1] = .{ .name = "content-type", .value = "text/plain; charset=utf-8" };
    var header_count: usize = 2;
    const session_id = model.selectedSessionId();
    if (session_id.len > 0) {
        headers[header_count] = .{ .name = "x-lavalamp-session", .value = session_id };
        header_count += 1;
    }
    fx.fetch(.{
        .key = action_fetch_key,
        .method = .POST,
        .url = endpoint(model, &url_buffer, "/v1/native/prompts"),
        .headers = headers[0..header_count],
        .body = model.draft.text(),
        .timeout_ms = 10_000,
        .on_response = Effects.responseMsg(.action_response),
    });
    model.processing = true;
    model.draft.clear();
    model.clearCommandResult();
    model.error_len = 0;
}

fn queuePrompt(model: *Model, fx: *Effects) void {
    if (model.queueDisabled()) return;
    var url_buffer: [160]u8 = undefined;
    var auth_buffer: [192]u8 = undefined;
    var headers: [3]std.http.Header = undefined;
    headers[0] = .{ .name = "authorization", .value = authHeader(model, &auth_buffer) };
    headers[1] = .{ .name = "content-type", .value = "text/plain; charset=utf-8" };
    var header_count: usize = 2;
    const session_id = model.selectedSessionId();
    if (session_id.len > 0) {
        headers[header_count] = .{ .name = "x-lavalamp-session", .value = session_id };
        header_count += 1;
    }
    fx.fetch(.{
        .key = action_fetch_key,
        .method = .POST,
        .url = endpoint(model, &url_buffer, "/v1/native/queue"),
        .headers = headers[0..header_count],
        .body = model.draft.text(),
        .timeout_ms = 10_000,
        .on_response = Effects.responseMsg(.action_response),
    });
    model.draft.clear();
    model.error_len = 0;
}

fn sendCommand(model: *Model, fx: *Effects, command: []const u8) void {
    var url_buffer: [160]u8 = undefined;
    var auth_buffer: [192]u8 = undefined;
    const headers = [_]std.http.Header{
        .{ .name = "authorization", .value = authHeader(model, &auth_buffer) },
        .{ .name = "content-type", .value = "text/plain; charset=utf-8" },
    };
    fx.fetch(.{
        .key = command_fetch_key,
        .method = .POST,
        .url = endpoint(model, &url_buffer, "/v1/native/commands"),
        .headers = &headers,
        .body = command,
        .timeout_ms = 10_000,
        .on_response = Effects.responseMsg(.command_response),
    });
    model.draft.clear();
    model.error_len = 0;
}

fn sendControl(model: *Model, fx: *Effects, body: []const u8) void {
    if (!model.connected or model.processing) return;
    var url_buffer: [160]u8 = undefined;
    var auth_buffer: [192]u8 = undefined;
    const headers = [_]std.http.Header{
        .{ .name = "authorization", .value = authHeader(model, &auth_buffer) },
        .{ .name = "content-type", .value = "application/json" },
    };
    fx.fetch(.{
        .key = action_fetch_key,
        .method = .POST,
        .url = endpoint(model, &url_buffer, "/v1/native/control"),
        .headers = &headers,
        .body = body,
        .timeout_ms = 10_000,
        .on_response = Effects.responseMsg(.action_response),
    });
    model.error_len = 0;
}

fn selectModel(model: *Model, key: u64, fx: *Effects) void {
    var selected: ?*ModelChoice = null;
    for (model.model_choices[0..model.model_choice_count]) |*choice| {
        choice.selected = choice.key == key;
        if (choice.selected) selected = choice;
    }
    const choice = selected orelse return;
    var body_buffer: [768]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&body_buffer);
    std.json.Stringify.value(.{ .action = "model", .model = choice.id() }, .{}, &writer) catch return;
    sendControl(model, fx, writer.buffered());
    model.model_len = copyText(&model.model_storage, choice.id());
}

fn cancelTurn(model: *Model, fx: *Effects) void {
    if (!model.processing) return;
    var url_buffer: [160]u8 = undefined;
    var auth_buffer: [192]u8 = undefined;
    const headers = [_]std.http.Header{.{ .name = "authorization", .value = authHeader(model, &auth_buffer) }};
    fx.fetch(.{
        .key = action_fetch_key,
        .method = .POST,
        .url = endpoint(model, &url_buffer, "/v1/cancel"),
        .headers = &headers,
        .on_response = Effects.responseMsg(.action_response),
    });
    model.processing = false;
}

fn clearConversationLocal(model: *Model) void {
    model.message_count = 0;
    model.tool_count = 0;
    model.assistant_len = 0;
    model.thinking_len = 0;
    model.terminal_len = 0;
    model.error_len = 0;
    model.permission_pending = false;
    model.question_request_id_len = 0;
    model.question_count = 0;
    model.question_index = 0;
    model.question_answer.clear();
    model.question_error_len = 0;
    model.selected_session_key = 0;
    model.total_tokens = 0;
    model.total_cost = 0;
    model.clearCommandResult();
    for (model.sessions[0..model.session_count]) |*session| session.selected = false;
}

fn newSession(model: *Model, fx: *Effects) void {
    if (!model.connected) return;
    if (model.processing) cancelTurn(model, fx);
    var url_buffer: [160]u8 = undefined;
    var auth_buffer: [192]u8 = undefined;
    const headers = [_]std.http.Header{
        .{ .name = "authorization", .value = authHeader(model, &auth_buffer) },
        .{ .name = "content-type", .value = "application/json" },
    };
    fx.fetch(.{
        .key = session_fetch_key,
        .method = .POST,
        .url = endpoint(model, &url_buffer, "/v1/session"),
        .headers = &headers,
        .body = "{}",
        .on_response = Effects.responseMsg(.session_response),
    });
    clearConversationLocal(model);
}

fn selectSession(model: *Model, key: u64, fx: *Effects) void {
    model.selected_session_key = key;
    var session_id: []const u8 = "";
    for (model.sessions[0..model.session_count]) |*session| {
        session.selected = session.key == key;
        if (session.selected) session_id = session.id();
    }
    if (session_id.len == 0) return;
    model.message_count = 0;
    model.tool_count = 0;
    model.assistant_len = 0;
    model.thinking_len = 0;
    model.terminal_len = 0;
    model.error_len = 0;

    var url_buffer: [160]u8 = undefined;
    var auth_buffer: [192]u8 = undefined;
    var body_buffer: [192]u8 = undefined;
    const body = std.fmt.bufPrint(&body_buffer, "{{\"sessionId\":\"{s}\"}}", .{session_id}) catch return;
    const headers = [_]std.http.Header{
        .{ .name = "authorization", .value = authHeader(model, &auth_buffer) },
        .{ .name = "content-type", .value = "application/json" },
    };
    fx.fetch(.{
        .key = session_fetch_key,
        .method = .POST,
        .url = endpoint(model, &url_buffer, "/v1/session"),
        .headers = &headers,
        .body = body,
        .on_response = Effects.responseMsg(.session_response),
    });
}

fn selectSubagent(model: *Model, key: u64, fx: *Effects) void {
    model.selected_subagent_key = key;
    var subagent_id: []const u8 = "";
    for (model.subagents[0..model.subagent_count]) |*subagent| {
        subagent.selected = subagent.key == key;
        if (subagent.selected) subagent_id = subagent.id();
    }
    model.subagent_transcript_len = 0;
    if (subagent_id.len == 0) return;

    var path_buffer: [256]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buffer, "/v1/subagents/{s}", .{subagent_id}) catch return;
    var url_buffer: [320]u8 = undefined;
    var auth_buffer: [192]u8 = undefined;
    const headers = [_]std.http.Header{.{ .name = "authorization", .value = authHeader(model, &auth_buffer) }};
    fx.fetch(.{
        .key = subagent_fetch_key,
        .url = endpoint(model, &url_buffer, path),
        .headers = &headers,
        .timeout_ms = 4_000,
        .on_response = Effects.responseMsg(.subagent_response),
    });
}

fn stopSubagent(model: *Model, fx: *Effects) void {
    const subagent_id = model.selectedSubagentId();
    if (subagent_id.len == 0 or !model.selectedSubagentRunning()) return;
    var path_buffer: [272]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buffer, "/v1/subagents/{s}/stop", .{subagent_id}) catch return;
    var url_buffer: [336]u8 = undefined;
    var auth_buffer: [192]u8 = undefined;
    const headers = [_]std.http.Header{.{ .name = "authorization", .value = authHeader(model, &auth_buffer) }};
    fx.fetch(.{
        .key = action_fetch_key,
        .method = .POST,
        .url = endpoint(model, &url_buffer, path),
        .headers = &headers,
        .on_response = Effects.responseMsg(.action_response),
    });
}

fn selectQuestionOption(model: *Model, key: u64) void {
    const question = model.currentQuestion() orelse return;
    if (question.kind == .input) return;
    for (question.options[0..question.option_count]) |*option| {
        if (option.key != key) {
            if (question.kind == .select) option.selected = false;
            continue;
        }
        option.selected = if (question.kind == .select) true else !option.selected;
        if (question.kind == .select) {
            question.answer_len = copyText(&question.answer_storage, option.label());
            model.question_answer.set(option.label());
        }
    }
    model.question_error_len = 0;
}

fn previousQuestion(model: *Model) void {
    if (!model.questionPending() or model.question_index == 0) return;
    model.question_index -= 1;
    const question = model.currentQuestion() orelse return;
    model.question_answer.set(question.answer());
    model.question_error_len = 0;
}

fn questionAnswered(question: *const Question) bool {
    if (question.kind == .multiselect) {
        for (question.options[0..question.option_count]) |option| {
            if (option.selected) return true;
        }
        return false;
    }
    return std.mem.trim(u8, question.answer(), " \t\r\n").len > 0;
}

fn advanceQuestion(model: *Model, fx: *Effects) void {
    const question = model.currentQuestion() orelse return;
    if (question.kind == .input) {
        question.answer_len = copyText(&question.answer_storage, model.question_answer.text());
    }
    if (!questionAnswered(question)) {
        model.question_error_len = copyText(&model.question_error_storage, "Choose or enter an answer to continue.");
        return;
    }
    if (model.question_index + 1 < model.question_count) {
        model.question_index += 1;
        const next = model.currentQuestion() orelse return;
        model.question_answer.set(next.answer());
        model.question_error_len = 0;
        return;
    }
    submitQuestionAnswers(model, fx);
}

fn submitQuestionAnswers(model: *Model, fx: *Effects) void {
    if (!model.questionPending()) return;
    var body_buffer: [16 * 1024]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&body_buffer);
    var json: std.json.Stringify = .{ .writer = &writer };
    json.beginObject() catch return;
    json.objectField("answers") catch return;
    json.beginObject() catch return;
    for (model.questions[0..model.question_count]) |*question| {
        json.objectField(question.id()) catch return;
        if (question.kind == .multiselect) {
            json.beginArray() catch return;
            for (question.options[0..question.option_count]) |*option| {
                if (option.selected) json.write(option.label()) catch return;
            }
            json.endArray() catch return;
        } else {
            json.write(question.answer()) catch return;
        }
    }
    json.endObject() catch return;
    json.endObject() catch return;

    var path_buffer: [256]u8 = undefined;
    const request_id = model.question_request_id_storage[0..model.question_request_id_len];
    const path = std.fmt.bufPrint(&path_buffer, "/v1/questions/{s}", .{request_id}) catch return;
    var url_buffer: [320]u8 = undefined;
    var auth_buffer: [192]u8 = undefined;
    const headers = [_]std.http.Header{
        .{ .name = "authorization", .value = authHeader(model, &auth_buffer) },
        .{ .name = "content-type", .value = "application/json" },
    };
    fx.fetch(.{
        .key = action_fetch_key,
        .method = .POST,
        .url = endpoint(model, &url_buffer, path),
        .headers = &headers,
        .body = writer.buffered(),
        .on_response = Effects.responseMsg(.action_response),
    });
    model.question_request_id_len = 0;
    model.question_count = 0;
    model.question_index = 0;
    model.question_answer.clear();
    model.question_error_len = 0;
}

fn resolvePermission(model: *Model, fx: *Effects, decision: []const u8) void {
    if (!model.permission_pending) return;
    var path_buffer: [256]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buffer, "/v1/permissions/{s}", .{model.permissionId()}) catch return;
    var url_buffer: [320]u8 = undefined;
    var auth_buffer: [192]u8 = undefined;
    var body_buffer: [96]u8 = undefined;
    const body = std.fmt.bufPrint(&body_buffer, "{{\"decision\":\"{s}\"}}", .{decision}) catch return;
    const headers = [_]std.http.Header{
        .{ .name = "authorization", .value = authHeader(model, &auth_buffer) },
        .{ .name = "content-type", .value = "application/json" },
    };
    fx.fetch(.{
        .key = action_fetch_key,
        .method = .POST,
        .url = endpoint(model, &url_buffer, path),
        .headers = &headers,
        .body = body,
        .on_response = Effects.responseMsg(.action_response),
    });
    model.permission_pending = false;
}

const UsagePayload = struct {
    input: u64 = 0,
    output: u64 = 0,
    cacheRead: u64 = 0,
    cacheWrite: u64 = 0,
    totalTokens: u64 = 0,
    cost: f64 = 0,
};
const MessagePayload = struct { role: []const u8 = "assistant", content: []const u8 = "" };
const ToolPayload = struct {
    id: []const u8 = "",
    name: []const u8 = "",
    summary: []const u8 = "",
    status: []const u8 = "",
    isError: bool = false,
    durationMs: ?u64 = null,
};
const SubagentPayload = struct {
    id: []const u8 = "",
    name: []const u8 = "",
    task: []const u8 = "",
    status: []const u8 = "pending",
};
const PendingPermissionPayload = struct { requestId: []const u8 = "", toolName: []const u8 = "" };
const QuestionPayload = struct {
    id: []const u8 = "",
    question: []const u8 = "",
    type: []const u8 = "input",
    options: []const []const u8 = &.{},
};
const PendingQuestionPayload = struct {
    requestId: []const u8 = "",
    questions: []const QuestionPayload = &.{},
};
const SnapshotPayload = struct {
    cursor: u64 = 0,
    processing: bool = false,
    assistantText: []const u8 = "",
    thinkingText: []const u8 = "",
    terminalOutput: []const u8 = "",
    workspace: ?[]const u8 = null,
    model: ?[]const u8 = null,
    provider: ?[]const u8 = null,
    backend: ?[]const u8 = null,
    mode: ?[]const u8 = null,
    @"error": ?[]const u8 = null,
    pendingPermission: ?PendingPermissionPayload = null,
    pendingQuestion: ?PendingQuestionPayload = null,
    usage: UsagePayload = .{},
    messages: []const MessagePayload = &.{},
    tools: []const ToolPayload = &.{},
    subagents: []const SubagentPayload = &.{},
};
const SessionPayload = struct { sessionId: []const u8 = "", prompt: []const u8 = "" };
const ModelPayload = struct { id: []const u8 = "", displayName: []const u8 = "" };
const NativeData = struct {
    snapshot: SnapshotPayload = .{},
    sessions: []const SessionPayload = &.{},
    models: []const ModelPayload = &.{},
};
const NativeEnvelope = struct { ok: bool = false, data: ?NativeData = null };
const SessionData = struct {
    sessionId: []const u8 = "",
    messages: []const MessagePayload = &.{},
};
const SessionEnvelope = struct { ok: bool = false, data: ?SessionData = null };
const SubagentInspectionData = struct {
    subagent: SubagentPayload = .{},
    messages: []const MessagePayload = &.{},
};
const SubagentInspectionEnvelope = struct { ok: bool = false, data: ?SubagentInspectionData = null };

pub fn applySubagentInspectionJson(model: *Model, body: []const u8) bool {
    var parse_storage: [128 * 1024]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&parse_storage);
    const envelope = std.json.parseFromSliceLeaky(
        SubagentInspectionEnvelope,
        fba.allocator(),
        body,
        .{ .ignore_unknown_fields = true },
    ) catch return false;
    if (!envelope.ok) return false;
    const data = envelope.data orelse return false;
    model.subagent_transcript_len = 0;
    for (data.messages, 0..) |message, index| {
        if (index > 0) appendText(&model.subagent_transcript_storage, &model.subagent_transcript_len, "\n\n");
        appendText(&model.subagent_transcript_storage, &model.subagent_transcript_len, if (std.mem.eql(u8, message.role, "user")) "## User\n\n" else "## Assistant\n\n");
        appendText(&model.subagent_transcript_storage, &model.subagent_transcript_len, message.content);
    }
    return true;
}

const CommandData = struct {
    title: []const u8 = "",
    rows: []const []const u8 = &.{},
};
const CommandEnvelope = struct { ok: bool = false, data: ?CommandData = null };

pub fn applySessionJson(model: *Model, body: []const u8) bool {
    var parse_storage: [128 * 1024]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&parse_storage);
    const envelope = std.json.parseFromSliceLeaky(
        SessionEnvelope,
        fba.allocator(),
        body,
        .{ .ignore_unknown_fields = true },
    ) catch return false;
    if (!envelope.ok) return false;
    const data = envelope.data orelse return false;
    model.message_count = @min(data.messages.len, max_messages);
    for (data.messages[0..model.message_count], 0..) |message, index| {
        model.messages[index].set(index + 1, if (std.mem.eql(u8, message.role, "user")) .user else .assistant, message.content);
    }
    return true;
}

pub fn applyCommandJson(model: *Model, body: []const u8) bool {
    var parse_storage: [128 * 1024]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&parse_storage);
    const envelope = std.json.parseFromSliceLeaky(
        CommandEnvelope,
        fba.allocator(),
        body,
        .{ .ignore_unknown_fields = true },
    ) catch return false;
    if (!envelope.ok) return false;
    const data = envelope.data orelse return false;
    model.command_title_len = copyText(&model.command_title_storage, data.title);
    model.command_row_count = @min(data.rows.len, max_command_rows);
    for (data.rows[0..model.command_row_count], 0..) |row, index| {
        model.command_rows[index].set(index + 1, row);
    }
    return true;
}

pub fn applySnapshotJson(model: *Model, body: []const u8) bool {
    var parse_storage: [256 * 1024]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&parse_storage);
    const envelope = std.json.parseFromSliceLeaky(
        NativeEnvelope,
        fba.allocator(),
        body,
        .{ .ignore_unknown_fields = true },
    ) catch return false;
    if (!envelope.ok) return false;
    const data = envelope.data orelse return false;
    const snapshot = data.snapshot;
    model.cursor = snapshot.cursor;
    model.processing = snapshot.processing;
    model.assistant_len = copyText(&model.assistant_storage, snapshot.assistantText);
    model.thinking_len = copyText(&model.thinking_storage, snapshot.thinkingText);
    model.terminal_len = copyText(&model.terminal_storage, snapshot.terminalOutput);
    model.workspace_len = copyText(&model.workspace_storage, snapshot.workspace orelse "");
    model.model_len = copyText(&model.model_storage, snapshot.model orelse "");
    model.provider_len = copyText(&model.provider_storage, snapshot.provider orelse "");
    model.backend_len = copyText(&model.backend_storage, snapshot.backend orelse "");
    model.mode_len = copyText(&model.mode_storage, snapshot.mode orelse "");
    model.error_len = copyText(&model.error_storage, snapshot.@"error" orelse "");
    model.total_tokens = snapshot.usage.totalTokens;
    model.total_cost = snapshot.usage.cost;

    model.message_count = @min(snapshot.messages.len, max_messages);
    for (snapshot.messages[0..model.message_count], 0..) |message, index| {
        model.messages[index].set(index + 1, if (std.mem.eql(u8, message.role, "user")) .user else .assistant, message.content);
    }

    model.tool_count = @min(snapshot.tools.len, max_tools);
    for (snapshot.tools[0..model.tool_count], 0..) |tool, index| {
        const target = &model.tools[index];
        target.id = std.hash.Wyhash.hash(0, tool.id) & std.math.maxInt(i64);
        target.name_len = copyText(&target.name_storage, tool.name);
        target.summary_len = copyText(&target.summary_storage, tool.summary);
        target.status_len = copyText(&target.status_storage, tool.status);
        target.failed = tool.isError;
        target.duration_ms = tool.durationMs orelse 0;
    }

    model.subagent_count = @min(snapshot.subagents.len, max_subagents);
    for (snapshot.subagents[0..model.subagent_count], 0..) |subagent, index| {
        const target = &model.subagents[index];
        target.key = std.hash.Wyhash.hash(0, subagent.id);
        target.id_len = copyText(&target.id_storage, subagent.id);
        target.name_len = copyText(&target.name_storage, subagent.name);
        target.task_len = copyText(&target.task_storage, subagent.task);
        target.status_len = copyText(&target.status_storage, subagent.status);
        target.selected = target.key == model.selected_subagent_key;
    }

    model.session_count = @min(data.sessions.len, max_sessions);
    for (data.sessions[0..model.session_count], 0..) |session, index| {
        const target = &model.sessions[index];
        target.key = std.hash.Wyhash.hash(0, session.sessionId) & std.math.maxInt(i64);
        target.id_len = copyText(&target.id_storage, session.sessionId);
        target.prompt_len = copyText(&target.prompt_storage, session.prompt);
        target.selected = target.key == model.selected_session_key;
    }

    model.model_choice_count = @min(data.models.len, max_models);
    for (data.models[0..model.model_choice_count], 0..) |choice, index| {
        const target = &model.model_choices[index];
        target.key = (index + 1) + 10_000;
        target.id_len = copyText(&target.id_storage, choice.id);
        target.name_len = copyText(&target.name_storage, if (choice.displayName.len > 0) choice.displayName else choice.id);
        target.selected = std.mem.eql(u8, choice.id, model.modelLabel());
    }

    if (snapshot.pendingPermission) |permission| {
        model.permission_pending = true;
        model.permission_id_len = copyText(&model.permission_id_storage, permission.requestId);
        model.permission_tool_len = copyText(&model.permission_tool_storage, permission.toolName);
    } else {
        model.permission_pending = false;
        model.permission_id_len = 0;
        model.permission_tool_len = 0;
    }

    if (snapshot.pendingQuestion) |pending_question| {
        const current_request = model.question_request_id_storage[0..model.question_request_id_len];
        if (!std.mem.eql(u8, current_request, pending_question.requestId)) {
            model.question_request_id_len = copyText(&model.question_request_id_storage, pending_question.requestId);
            model.question_count = @min(pending_question.questions.len, max_questions);
            model.question_index = 0;
            model.question_error_len = 0;
            model.question_answer.clear();
            for (pending_question.questions[0..model.question_count], 0..) |payload, question_index| {
                const question = &model.questions[question_index];
                question.id_len = copyText(&question.id_storage, payload.id);
                question.text_len = copyText(&question.text_storage, payload.question);
                question.answer_len = 0;
                question.kind = if (std.mem.eql(u8, payload.type, "select"))
                    .select
                else if (std.mem.eql(u8, payload.type, "multiselect"))
                    .multiselect
                else
                    .input;
                question.option_count = @min(payload.options.len, max_question_options);
                for (payload.options[0..question.option_count], 0..) |label, option_index| {
                    const option = &question.options[option_index];
                    option.key = option_index + 1;
                    option.len = copyText(&option.storage, label);
                    option.selected = false;
                }
            }
        }
    } else {
        model.question_request_id_len = 0;
        model.question_count = 0;
        model.question_index = 0;
        model.question_answer.clear();
        model.question_error_len = 0;
    }
    return true;
}

fn copyText(destination: anytype, source: []const u8) usize {
    const len = @min(destination.len, source.len);
    @memcpy(destination[0..len], source[0..len]);
    return len;
}

fn appendText(destination: anytype, offset: *usize, source: []const u8) void {
    if (offset.* >= destination.len) return;
    const len = @min(destination.len - offset.*, source.len);
    @memcpy(destination[offset.*..][0..len], source[0..len]);
    offset.* += len;
}

fn setError(model: *Model, message: []const u8) void {
    model.error_len = copyText(&model.error_storage, message);
}

fn lavaTokens() canvas.DesignTokens {
    var tokens = canvas.DesignTokens.theme(.{ .color_scheme = .dark });
    tokens.colors.background = canvas.Color.rgb8(16, 14, 13);
    tokens.colors.surface = canvas.Color.rgb8(23, 20, 17);
    tokens.colors.surface_subtle = canvas.Color.rgb8(33, 27, 22);
    tokens.colors.surface_pressed = canvas.Color.rgb8(45, 35, 26);
    tokens.colors.border = canvas.Color.rgba8(255, 166, 92, 38);
    tokens.colors.accent = canvas.Color.rgb8(255, 122, 24);
    tokens.colors.accent_text = canvas.Color.rgb8(20, 12, 7);
    tokens.colors.focus_ring = canvas.Color.rgb8(255, 153, 64);
    tokens.colors.info = canvas.Color.rgb8(255, 153, 64);
    tokens.pixel_snap = .{ .geometry = true, .text = true };
    return tokens;
}

pub fn main(init: std.process.Init) !void {
    const app_state = try LavalampApp.create(std.heap.page_allocator, .{
        .name = "lavalamp",
        .scene = shell_scene,
        .canvas_label = canvas_label,
        .update_fx = update,
        .init_fx = initEffects,
        .tokens = lavaTokens(),
        .markup = .{ .source = app_markup, .watch_path = "src/app.native", .io = init.io },
    });
    defer app_state.destroy();
    app_state.model = initialModel();

    try runner.runWithOptions(app_state.app(), .{
        .app_name = "lavalamp",
        .window_title = "Lavalamp",
        .bundle_id = "lol.marban.lavalamp",
        .icon_path = "assets/icon.png",
        .default_frame = geometry.RectF.init(0, 0, window_width, window_height),
        .restore_state = true,
        .js_window_api = false,
        .security = .{
            .permissions = &app_permissions,
            .navigation = .{ .allowed_origins = &.{ "zero://inline", "zero://app" } },
        },
    }, init);
}

test {
    _ = @import("tests.zig");
}
