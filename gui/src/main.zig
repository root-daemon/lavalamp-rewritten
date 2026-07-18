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
const command_fetch_key: u64 = 105;
const max_messages = 40;
const max_tools = 24;
const max_sessions = 16;
const max_models = 24;
const max_command_rows = 48;
const max_workspace_changes = 16;
const max_diff_stats = 10;
const max_subagents = 8;
const max_repo_worktrees = 8;
const max_repo_checks = 8;

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

pub const ModelOption = struct {
    key: u64 = 0,
    id_storage: [160]u8 = undefined,
    id_len: usize = 0,
    name_storage: [220]u8 = undefined,
    name_len: usize = 0,
    selected: bool = false,

    pub fn id(self: *const ModelOption) []const u8 {
        return self.id_storage[0..self.id_len];
    }

    pub fn displayName(self: *const ModelOption) []const u8 {
        if (self.name_len == 0) return self.id();
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

pub const WorkspaceChange = struct {
    id: u64 = 0,
    status_storage: [16]u8 = undefined,
    status_len: usize = 0,
    path_storage: [320]u8 = undefined,
    path_len: usize = 0,

    pub fn status(self: *const WorkspaceChange) []const u8 {
        return self.status_storage[0..self.status_len];
    }

    pub fn path(self: *const WorkspaceChange) []const u8 {
        return self.path_storage[0..self.path_len];
    }
};

pub const DiffStat = struct {
    id: u64 = 0,
    storage: [512]u8 = undefined,
    len: usize = 0,

    pub fn text(self: *const DiffStat) []const u8 {
        return self.storage[0..self.len];
    }
};

pub const Subagent = struct {
    id: u64 = 0,
    name_storage: [64]u8 = undefined,
    name_len: usize = 0,
    query_storage: [360]u8 = undefined,
    query_len: usize = 0,
    status_storage: [24]u8 = undefined,
    status_len: usize = 0,
    meta_storage: [96]u8 = undefined,
    meta_len: usize = 0,

    pub fn name(self: *const Subagent) []const u8 {
        return self.name_storage[0..self.name_len];
    }

    pub fn query(self: *const Subagent) []const u8 {
        return self.query_storage[0..self.query_len];
    }

    pub fn status(self: *const Subagent) []const u8 {
        return self.status_storage[0..self.status_len];
    }

    pub fn meta(self: *const Subagent) []const u8 {
        return self.meta_storage[0..self.meta_len];
    }
};

pub const RepoWorktree = struct {
    id: u64 = 0,
    branch_storage: [128]u8 = undefined,
    branch_len: usize = 0,
    path_storage: [360]u8 = undefined,
    path_len: usize = 0,
    head_storage: [32]u8 = undefined,
    head_len: usize = 0,
    current: bool = false,

    pub fn branch(self: *const RepoWorktree) []const u8 {
        if (self.branch_len == 0) return "detached";
        return self.branch_storage[0..self.branch_len];
    }

    pub fn path(self: *const RepoWorktree) []const u8 {
        return self.path_storage[0..self.path_len];
    }

    pub fn meta(self: *const RepoWorktree) []const u8 {
        if (self.current) return "current worktree";
        if (self.head_len > 0) return self.head_storage[0..self.head_len];
        return "linked worktree";
    }

    pub fn switchSelector(self: *const RepoWorktree) []const u8 {
        if (self.branch_len > 0) return self.branch_storage[0..self.branch_len];
        return self.path();
    }
};

pub const RepoCheck = struct {
    id: u64 = 0,
    name_storage: [160]u8 = undefined,
    name_len: usize = 0,
    state_storage: [64]u8 = undefined,
    state_len: usize = 0,

    pub fn name(self: *const RepoCheck) []const u8 {
        return self.name_storage[0..self.name_len];
    }

    pub fn state(self: *const RepoCheck) []const u8 {
        if (self.state_len == 0) return "unknown";
        return self.state_storage[0..self.state_len];
    }
};

pub const Model = struct {
    pub const view_unbound = .{
        "connected", "cursor", "queue_count", "host_port", "auth_token_storage", "auth_token_len",
        "draft", "assistant_storage", "assistant_len", "thinking_storage", "thinking_len",
        "terminal_storage", "terminal_len", "error_storage", "error_len",
        "workspace_storage", "workspace_len", "model_storage", "model_len",
        "workspace_branch_storage", "workspace_branch_len", "workspace_summary_storage", "workspace_summary_len", "workspace_git", "workspace_clean",
        "repo_git", "repo_storage", "repo_len", "repo_head_storage", "repo_head_len", "repo_remote_storage", "repo_remote_len", "repo_pr_storage", "repo_pr_len", "repo_pr_title_storage", "repo_pr_title_len", "repo_review_storage", "repo_review_len", "repo_check_summary_storage", "repo_check_summary_len", "repo_actions_storage", "repo_actions_len",
        "runtime_route_storage", "runtime_route_len", "runtime_auth_storage", "runtime_auth_len", "runtime_gateway_storage", "runtime_gateway_len", "runtime_auth_required",
        "provider_storage", "provider_len", "backend_storage", "backend_len", "mode_storage", "mode_len", "permission_id_storage", "permission_id_len",
        "permission_tool_storage", "permission_tool_len", "pending_question", "question_id_storage", "question_id_len", "question_text_storage", "question_text_len",
        "question_body_storage", "messages", "message_count",
        "tools", "tool_count", "sessions", "session_count", "models", "model_count", "selected_session_key", "command_title_storage", "command_title_len",
        "command_rows", "command_row_count", "workspace_changes", "workspace_change_count", "diff_stats", "diff_stat_count", "total_tokens", "total_cost", "assistantText", "authToken",
        "permissionId", "hasMessages", "subagents", "subagent_count", "repo_worktrees", "repo_worktree_count", "repo_checks", "repo_check_count",
    };

    connected: bool = false,
    processing: bool = false,
    cursor: u64 = 0,
    queue_count: u64 = 0,
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
    workspace_branch_storage: [160]u8 = undefined,
    workspace_branch_len: usize = 0,
    workspace_summary_storage: [256]u8 = undefined,
    workspace_summary_len: usize = 0,
    workspace_git: bool = false,
    workspace_clean: bool = true,
    repo_git: bool = false,
    repo_storage: [1024]u8 = undefined,
    repo_len: usize = 0,
    repo_head_storage: [160]u8 = undefined,
    repo_head_len: usize = 0,
    repo_remote_storage: [360]u8 = undefined,
    repo_remote_len: usize = 0,
    repo_pr_storage: [360]u8 = undefined,
    repo_pr_len: usize = 0,
    repo_pr_title_storage: [360]u8 = undefined,
    repo_pr_title_len: usize = 0,
    repo_review_storage: [160]u8 = undefined,
    repo_review_len: usize = 0,
    repo_check_summary_storage: [160]u8 = undefined,
    repo_check_summary_len: usize = 0,
    repo_actions_storage: [360]u8 = undefined,
    repo_actions_len: usize = 0,
    runtime_route_storage: [160]u8 = undefined,
    runtime_route_len: usize = 0,
    runtime_auth_storage: [160]u8 = undefined,
    runtime_auth_len: usize = 0,
    runtime_gateway_storage: [160]u8 = undefined,
    runtime_gateway_len: usize = 0,
    runtime_auth_required: bool = false,
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
    pending_question: bool = false,
    question_id_storage: [128]u8 = undefined,
    question_id_len: usize = 0,
    question_text_storage: [1024]u8 = undefined,
    question_text_len: usize = 0,
    question_body_storage: [8192]u8 = undefined,
    messages: [max_messages]Message = [_]Message{.{}} ** max_messages,
    message_count: usize = 0,
    tools: [max_tools]Tool = [_]Tool{.{}} ** max_tools,
    tool_count: usize = 0,
    sessions: [max_sessions]Session = [_]Session{.{}} ** max_sessions,
    session_count: usize = 0,
    models: [max_models]ModelOption = [_]ModelOption{.{}} ** max_models,
    model_count: usize = 0,
    selected_session_key: u64 = 0,
    command_title_storage: [96]u8 = undefined,
    command_title_len: usize = 0,
    command_rows: [max_command_rows]CommandRow = [_]CommandRow{.{}} ** max_command_rows,
    command_row_count: usize = 0,
    workspace_changes: [max_workspace_changes]WorkspaceChange = [_]WorkspaceChange{.{}} ** max_workspace_changes,
    workspace_change_count: usize = 0,
    diff_stats: [max_diff_stats]DiffStat = [_]DiffStat{.{}} ** max_diff_stats,
    diff_stat_count: usize = 0,
    subagents: [max_subagents]Subagent = [_]Subagent{.{}} ** max_subagents,
    subagent_count: usize = 0,
    repo_worktrees: [max_repo_worktrees]RepoWorktree = [_]RepoWorktree{.{}} ** max_repo_worktrees,
    repo_worktree_count: usize = 0,
    repo_checks: [max_repo_checks]RepoCheck = [_]RepoCheck{.{}} ** max_repo_checks,
    repo_check_count: usize = 0,
    total_tokens: u64 = 0,
    total_cost: f64 = 0,

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
        return self.workspace_storage[0..self.workspace_len];
    }
    pub fn workspaceBranch(self: *const Model) []const u8 {
        if (self.workspace_branch_len == 0) return "No branch";
        return self.workspace_branch_storage[0..self.workspace_branch_len];
    }
    pub fn workspaceSummary(self: *const Model) []const u8 {
        if (self.workspace_summary_len == 0) return "Workspace status unavailable";
        return self.workspace_summary_storage[0..self.workspace_summary_len];
    }
    pub fn repoLabel(self: *const Model) []const u8 {
        if (self.repo_len == 0) return "Repository unavailable";
        return self.repo_storage[0..self.repo_len];
    }
    pub fn repoHeadLabel(self: *const Model) []const u8 {
        if (self.repo_head_len == 0) return "No commits yet";
        return self.repo_head_storage[0..self.repo_head_len];
    }
    pub fn repoRemoteLabel(self: *const Model) []const u8 {
        if (self.repo_remote_len == 0) return "No GitHub remote";
        return self.repo_remote_storage[0..self.repo_remote_len];
    }
    pub fn repoPrLabel(self: *const Model) []const u8 {
        if (self.repo_pr_len == 0) return "PR link unavailable";
        return self.repo_pr_storage[0..self.repo_pr_len];
    }
    pub fn repoPrTitleLabel(self: *const Model) []const u8 {
        if (self.repo_pr_title_len == 0) return "No open PR for this branch";
        return self.repo_pr_title_storage[0..self.repo_pr_title_len];
    }
    pub fn repoReviewLabel(self: *const Model) []const u8 {
        if (self.repo_review_len == 0) return "review unavailable";
        return self.repo_review_storage[0..self.repo_review_len];
    }
    pub fn repoCheckSummaryLabel(self: *const Model) []const u8 {
        if (self.repo_check_summary_len == 0) return "checks unavailable";
        return self.repo_check_summary_storage[0..self.repo_check_summary_len];
    }
    pub fn repoActionsLabel(self: *const Model) []const u8 {
        if (self.repo_actions_len == 0) return "CI link unavailable";
        return self.repo_actions_storage[0..self.repo_actions_len];
    }
    pub fn runtimeRouteLabel(self: *const Model) []const u8 {
        if (self.runtime_route_len == 0) return "Route pending";
        return self.runtime_route_storage[0..self.runtime_route_len];
    }
    pub fn runtimeAuthLabel(self: *const Model) []const u8 {
        if (self.runtime_auth_len == 0) return "Auth pending";
        return self.runtime_auth_storage[0..self.runtime_auth_len];
    }
    pub fn runtimeGatewayLabel(self: *const Model) []const u8 {
        if (self.runtime_gateway_len == 0) return "Gateway unavailable";
        return self.runtime_gateway_storage[0..self.runtime_gateway_len];
    }
    pub fn modelLabel(self: *const Model) []const u8 {
        if (self.model_len == 0) return "Default model";
        return self.model_storage[0..self.model_len];
    }
    pub fn providerLabel(self: *const Model) []const u8 {
        if (self.provider_len == 0) return "Provider pending";
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
    fn questionId(self: *const Model) []const u8 {
        return self.question_id_storage[0..self.question_id_len];
    }
    pub fn questionText(self: *const Model) []const u8 {
        return self.question_text_storage[0..self.question_text_len];
    }
    pub fn commandTitle(self: *const Model) []const u8 {
        return self.command_title_storage[0..self.command_title_len];
    }
    pub fn commandRows(self: *const Model) []const CommandRow {
        return self.command_rows[0..self.command_row_count];
    }
    pub fn workspaceChanges(self: *const Model) []const WorkspaceChange {
        return self.workspace_changes[0..self.workspace_change_count];
    }
    pub fn diffStats(self: *const Model) []const DiffStat {
        return self.diff_stats[0..self.diff_stat_count];
    }
    pub fn subagentItems(self: *const Model) []const Subagent {
        return self.subagents[0..self.subagent_count];
    }
    pub fn repoWorktreeItems(self: *const Model) []const RepoWorktree {
        return self.repo_worktrees[0..self.repo_worktree_count];
    }
    pub fn repoCheckItems(self: *const Model) []const RepoCheck {
        return self.repo_checks[0..self.repo_check_count];
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
    pub fn modelItems(self: *const Model) []const ModelOption {
        return self.models[0..self.model_count];
    }
    fn selectedSessionId(self: *const Model) []const u8 {
        for (self.sessions[0..self.session_count]) |*session| {
            if (session.key == self.selected_session_key) return session.id();
        }
        return "";
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
    pub fn hasTools(self: *const Model) bool {
        return self.tool_count > 0;
    }
    pub fn hasModels(self: *const Model) bool {
        return self.model_count > 0;
    }
    pub fn hasCommandResult(self: *const Model) bool {
        return self.command_row_count > 0;
    }
    pub fn hasWorkspaceChanges(self: *const Model) bool {
        return self.workspace_change_count > 0;
    }
    pub fn hasDiffStats(self: *const Model) bool {
        return self.diff_stat_count > 0;
    }
    pub fn hasSubagents(self: *const Model) bool {
        return self.subagent_count > 0;
    }
    pub fn hasRepo(self: *const Model) bool {
        return self.repo_git;
    }
    pub fn hasRepoWorktrees(self: *const Model) bool {
        return self.repo_worktree_count > 0;
    }
    pub fn hasPullRequest(self: *const Model) bool {
        return self.repo_pr_title_len > 0;
    }
    pub fn hasRepoChecks(self: *const Model) bool {
        return self.repo_check_count > 0;
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
        if (!self.connected or self.draft.isEmpty()) return true;
        return false;
    }
    pub fn connectionLabel(self: *const Model) []const u8 {
        if (!self.connected) return "Connecting";
        if (self.processing) return "Running";
        return "Ready";
    }
    pub fn queueLabel(self: *const Model, arena: std.mem.Allocator) []const u8 {
        return std.fmt.allocPrint(arena, "{d} queued", .{self.queue_count}) catch "Queue unavailable";
    }
    pub fn hasQueuedPrompts(self: *const Model) bool {
        return self.queue_count > 0;
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
    send,
    cancel,
    new_chat,
    select_session: u64,
    select_model: u64,
    select_worktree: u64,
    command_help,
    command_sessions,
    command_models,
    command_permissions,
    command_tools,
    command_usage,
    command_clear,
    command_memory,
    command_mcp,
    command_subagents,
    command_gateway,
    command_rate_helpful,
    command_rate_unhelpful,
    command_repo,
    command_worktree,
    command_workspace,
    command_changes,
    command_diff,
    command_skills,
    command_sudo,
    command_analytics,
    command_benchmarks,
    command_compact,
    command_undo,
    command_copy,
    command_login,
    command_paste_image,
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
    command_response: native_sdk.EffectResponse,

    pub const view_unbound = .{ "host_line", "host_exit", "poll_tick", "snapshot_response", "action_response", "session_response", "command_response" };
};

pub const Effects = native_sdk.Effects(Msg);
pub const AppUi = canvas.Ui(Msg);
pub const AppMarkup = canvas.MarkupView(Model, Msg);
pub const app_markup = @embedFile("app.native");
const LavalampApp = native_sdk.UiApp(Model, Msg);

pub fn initialModel() Model {
    return .{};
}

fn hostBinary() []const u8 {
    if (std.c.getenv("LAVALAMP_CLI_BINARY")) |raw| {
        const value = std.mem.span(raw);
        if (value.len > 0) return value;
    }

    const cwd_candidates = [_][:0]const u8{
        "bin/lavalamp",
        "./bin/lavalamp",
        "../bin/lavalamp",
        "../../bin/lavalamp",
        "../../../bin/lavalamp",
        "../../../../bin/lavalamp",
        "../../../../../bin/lavalamp",
    };
    for (cwd_candidates) |candidate| {
        if (std.c.access(candidate, std.c.X_OK) == 0) return candidate;
    }

    return "lavalamp";
}

fn initEffects(_: *Model, fx: *Effects) void {
    const binary = hostBinary();
    fx.spawn(.{
        .key = host_process_key,
        .argv = &.{ binary, "gui-host" },
        .max_line_bytes = 16 * 1024,
        .on_line = Effects.lineMsg(.host_line),
        .on_exit = Effects.exitMsg(.host_exit),
    });
}

pub fn update(model: *Model, msg: Msg, fx: *Effects) void {
    switch (msg) {
        .draft_edit => |edit| model.draft.apply(edit),
        .send => sendPrompt(model, fx),
        .cancel => cancelTurn(model, fx),
        .new_chat => {
            model.message_count = 0;
            model.tool_count = 0;
            model.subagent_count = 0;
            model.assistant_len = 0;
            model.thinking_len = 0;
            model.terminal_len = 0;
            model.error_len = 0;
            model.pending_question = false;
            model.question_id_len = 0;
            model.question_text_len = 0;
            model.selected_session_key = 0;
            model.clearCommandResult();
            for (model.sessions[0..model.session_count]) |*session| session.selected = false;
        },
        .select_session => |key| selectSession(model, key, fx),
        .select_model => |key| selectModel(model, key, fx),
        .select_worktree => |key| selectWorktree(model, key, fx),
        .command_help => sendCommand(model, fx, "/help", false),
        .command_sessions => sendCommand(model, fx, "/sessions", false),
        .command_models => sendCommand(model, fx, "/models", false),
        .command_permissions => sendCommand(model, fx, "/permissions", false),
        .command_tools => sendCommand(model, fx, "/tools", false),
        .command_usage => sendCommand(model, fx, "/usage", false),
        .command_clear => sendCommand(model, fx, "/clear", false),
        .command_memory => sendCommand(model, fx, "/memory", false),
        .command_mcp => sendCommand(model, fx, "/mcp", false),
        .command_subagents => sendCommand(model, fx, "/subagents", false),
        .command_gateway => sendCommand(model, fx, "/gateway", false),
        .command_rate_helpful => sendCommand(model, fx, "/rate helpful", false),
        .command_rate_unhelpful => sendCommand(model, fx, "/rate unhelpful", false),
        .command_repo => sendCommand(model, fx, "/repo", false),
        .command_worktree => sendCommand(model, fx, "/worktree", false),
        .command_workspace => sendCommand(model, fx, "/workspace", false),
        .command_changes => sendCommand(model, fx, "/changes", false),
        .command_diff => sendCommand(model, fx, "/diff", false),
        .command_skills => sendCommand(model, fx, "/skills", false),
        .command_sudo => sendCommand(model, fx, "/sudo", false),
        .command_analytics => sendCommand(model, fx, "/analytics", false),
        .command_benchmarks => sendCommand(model, fx, "/benchmarks", false),
        .command_compact => sendCommand(model, fx, "/compact", false),
        .command_undo => sendCommand(model, fx, "/undo", false),
        .command_copy => sendCommand(model, fx, "/copy", false),
        .command_login => sendCommand(model, fx, "/login", false),
        .command_paste_image => sendCommand(model, fx, "/paste-image", false),
        .mode_build => sendCommand(model, fx, "/build", false),
        .mode_ask => sendCommand(model, fx, "/ask", false),
        .mode_plan => sendCommand(model, fx, "/plan", false),
        .backend_flue => sendCommand(model, fx, "/backend flue", false),
        .backend_codex => sendCommand(model, fx, "/backend codex", false),
        .allow_permission => resolvePermission(model, fx, "allow"),
        .always_allow_permission => resolvePermission(model, fx, "always_allow"),
        .deny_permission => resolvePermission(model, fx, "deny"),
        .host_line => |line| handleHostLine(model, line, fx),
        .host_exit => |exit| {
            model.connected = false;
            if (exit.reason == .spawn_failed) {
                setError(model, "Could not start Lavalamp host. Launch with ./bin/lavalamp gui or set LAVALAMP_CLI_BINARY.");
            } else if (exit.code != 0) {
                setError(model, "Lavalamp host exited unexpectedly");
            }
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
    if (model.pending_question) {
        sendQuestionAnswer(model, fx);
        return;
    }
    const draft_text = model.draft.text();
    if (std.mem.startsWith(u8, std.mem.trim(u8, draft_text, " \t\r\n"), "/")) {
        sendCommand(model, fx, draft_text, true);
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

fn sendQuestionAnswer(model: *Model, fx: *Effects) void {
    var path_buffer: [256]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buffer, "/v1/questions/{s}", .{model.questionId()}) catch return;
    var url_buffer: [320]u8 = undefined;
    var auth_buffer: [192]u8 = undefined;
    const body = buildQuestionAnswerBody(model) catch {
        setError(model, "Question answer is too long");
        return;
    };
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
        .timeout_ms = 10_000,
        .on_response = Effects.responseMsg(.action_response),
    });
    model.pending_question = false;
    model.question_id_len = 0;
    model.question_text_len = 0;
    model.draft.clear();
    model.error_len = 0;
}

fn sendCommand(model: *Model, fx: *Effects, command: []const u8, clear_draft: bool) void {
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
    if (clear_draft) model.draft.clear();
    model.error_len = 0;
}

fn appendDraftText(model: *Model, text: []const u8) void {
    var buffer: [8192]u8 = undefined;
    var index: usize = 0;
    const current = model.draft.text();
    if (current.len > 0) {
        const count = @min(current.len, buffer.len);
        @memcpy(buffer[0..count], current[0..count]);
        index = count;
        if (index < buffer.len and !std.ascii.isWhitespace(buffer[index - 1])) {
            buffer[index] = ' ';
            index += 1;
        }
    }
    if (index < buffer.len) {
        const count = @min(text.len, buffer.len - index);
        @memcpy(buffer[index .. index + count], text[0..count]);
        index += count;
    }
    model.draft.set(buffer[0..index]);
}

fn buildQuestionAnswerBody(model: *Model) ![]const u8 {
    var index: usize = 0;
    try appendBytes(model.question_body_storage[0..], &index, "{\"answers\":{");
    try appendJsonString(model.question_body_storage[0..], &index, model.questionId());
    try appendBytes(model.question_body_storage[0..], &index, ":");
    try appendJsonString(model.question_body_storage[0..], &index, model.draft.text());
    try appendBytes(model.question_body_storage[0..], &index, "}}");
    return model.question_body_storage[0..index];
}

fn appendBytes(buffer: []u8, index: *usize, text: []const u8) !void {
    if (index.* + text.len > buffer.len) return error.NoSpaceLeft;
    @memcpy(buffer[index.* .. index.* + text.len], text);
    index.* += text.len;
}

fn appendByte(buffer: []u8, index: *usize, byte: u8) !void {
    if (index.* >= buffer.len) return error.NoSpaceLeft;
    buffer[index.*] = byte;
    index.* += 1;
}

fn appendJsonString(buffer: []u8, index: *usize, text: []const u8) !void {
    try appendByte(buffer, index, '"');
    for (text) |byte| {
        switch (byte) {
            '"' => try appendBytes(buffer, index, "\\\""),
            '\\' => try appendBytes(buffer, index, "\\\\"),
            '\n' => try appendBytes(buffer, index, "\\n"),
            '\r' => try appendBytes(buffer, index, "\\r"),
            '\t' => try appendBytes(buffer, index, "\\t"),
            else => {
                if (byte < 0x20) {
                    var escape: [6]u8 = undefined;
                    const written = std.fmt.bufPrint(&escape, "\\u{X:0>4}", .{byte}) catch return error.NoSpaceLeft;
                    try appendBytes(buffer, index, written);
                } else {
                    try appendByte(buffer, index, byte);
                }
            },
        }
    }
    try appendByte(buffer, index, '"');
}

fn isPassingCheckState(state: []const u8) bool {
    return std.mem.eql(u8, state, "pass") or
        std.mem.eql(u8, state, "passing") or
        std.mem.eql(u8, state, "success") or
        std.mem.eql(u8, state, "completed");
}

fn isFailingCheckState(state: []const u8) bool {
    return std.mem.eql(u8, state, "fail") or
        std.mem.eql(u8, state, "failing") or
        std.mem.eql(u8, state, "failure") or
        std.mem.eql(u8, state, "cancelled");
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

fn selectModel(model: *Model, key: u64, fx: *Effects) void {
    var model_id: []const u8 = "";
    for (model.models[0..model.model_count]) |*option| {
        option.selected = option.key == key;
        if (option.selected) model_id = option.id();
    }
    if (model_id.len == 0) return;
    var command_buffer: [192]u8 = undefined;
    const command = std.fmt.bufPrint(&command_buffer, "/model {s}", .{model_id}) catch return;
    sendCommand(model, fx, command, false);
}

fn selectWorktree(model: *Model, key: u64, fx: *Effects) void {
    var selector: []const u8 = "";
    for (model.repo_worktrees[0..model.repo_worktree_count]) |*worktree| {
        if (worktree.id == key) {
            selector = worktree.switchSelector();
            break;
        }
    }
    if (selector.len == 0) return;
    var command_buffer: [440]u8 = undefined;
    const command = std.fmt.bufPrint(&command_buffer, "/worktree switch {s}", .{selector}) catch return;
    sendCommand(model, fx, command, false);
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
    query: []const u8 = "",
    status: []const u8 = "",
    pid: ?u64 = null,
    durationMs: u64 = 0,
    @"error": ?[]const u8 = null,
};
const PendingPermissionPayload = struct { requestId: []const u8 = "", toolName: []const u8 = "" };
const QuestionPayload = struct {
    id: []const u8 = "",
    question: []const u8 = "",
    type: []const u8 = "",
    options: ?[]const []const u8 = null,
};
const PendingQuestionPayload = struct {
    requestId: []const u8 = "",
    questions: []const QuestionPayload = &.{},
};
const SnapshotPayload = struct {
    cursor: u64 = 0,
    processing: bool = false,
    queueSize: u64 = 0,
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
const WorkspaceChangePayload = struct { path: []const u8 = "", status: []const u8 = "" };
const WorkspaceStatusPayload = struct {
    git: bool = false,
    branch: []const u8 = "",
    clean: bool = true,
    summary: []const u8 = "",
    changes: []const WorkspaceChangePayload = &.{},
    diffStat: []const []const u8 = &.{},
};
const RepoRemotePayload = struct {
    name: []const u8 = "",
    url: []const u8 = "",
    webUrl: ?[]const u8 = null,
};
const RepoWorktreePayload = struct {
    path: []const u8 = "",
    branch: ?[]const u8 = null,
    head: ?[]const u8 = null,
    current: bool = false,
};
const RepoPullRequestPayload = struct {
    number: u64 = 0,
    title: []const u8 = "",
    state: []const u8 = "",
    url: []const u8 = "",
    reviewDecision: ?[]const u8 = null,
    mergeStateStatus: ?[]const u8 = null,
    isDraft: bool = false,
};
const RepoCheckPayload = struct {
    name: []const u8 = "",
    state: []const u8 = "",
    bucket: ?[]const u8 = null,
    url: ?[]const u8 = null,
};
const RepoStatusPayload = struct {
    git: bool = false,
    repository: []const u8 = "",
    branch: []const u8 = "",
    head: ?[]const u8 = null,
    status: []const u8 = "",
    remotes: []const RepoRemotePayload = &.{},
    webUrl: ?[]const u8 = null,
    pullRequestUrl: ?[]const u8 = null,
    actionsUrl: ?[]const u8 = null,
    pullRequest: ?RepoPullRequestPayload = null,
    checks: []const RepoCheckPayload = &.{},
    worktrees: []const RepoWorktreePayload = &.{},
};
const RuntimeStatusPayload = struct {
    authLabel: []const u8 = "",
    authRequired: bool = false,
    backend: []const u8 = "",
    gatewayEnabled: bool = false,
    gatewayId: []const u8 = "",
    gatewaySupported: bool = false,
    model: []const u8 = "",
    provider: []const u8 = "",
    routeLabel: []const u8 = "",
    routeMode: []const u8 = "",
};
const NativeData = struct {
    snapshot: SnapshotPayload = .{},
    sessions: []const SessionPayload = &.{},
    models: []const ModelPayload = &.{},
    workspaceStatus: WorkspaceStatusPayload = .{},
    repoStatus: RepoStatusPayload = .{},
    runtimeStatus: ?RuntimeStatusPayload = null,
};
const NativeEnvelope = struct { ok: bool = false, data: ?NativeData = null };
const SessionData = struct {
    sessionId: []const u8 = "",
    messages: []const MessagePayload = &.{},
};
const SessionEnvelope = struct { ok: bool = false, data: ?SessionData = null };
const CommandData = struct {
    title: []const u8 = "",
    rows: []const []const u8 = &.{},
    insertText: ?[]const u8 = null,
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
    if (data.insertText) |text| appendDraftText(model, text);
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
    model.queue_count = snapshot.queueSize;
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

    if (data.runtimeStatus) |status| {
        model.runtime_route_len = copyText(&model.runtime_route_storage, status.routeLabel);
        model.runtime_auth_len = copyText(&model.runtime_auth_storage, status.authLabel);
        model.runtime_auth_required = status.authRequired;
        if (model.model_len == 0) model.model_len = copyText(&model.model_storage, status.model);
        if (model.provider_len == 0) model.provider_len = copyText(&model.provider_storage, status.provider);
        if (model.backend_len == 0) model.backend_len = copyText(&model.backend_storage, status.backend);
        var gateway_buffer: [160]u8 = undefined;
        const gateway_label = if (status.gatewayEnabled)
            std.fmt.bufPrint(&gateway_buffer, "Gateway {s} · {s}", .{ status.gatewayId, status.routeMode }) catch status.routeLabel
        else if (status.gatewaySupported)
            "Gateway available · direct"
        else
            "Gateway unavailable";
        model.runtime_gateway_len = copyText(&model.runtime_gateway_storage, gateway_label);
    } else {
        model.runtime_route_len = 0;
        model.runtime_auth_len = 0;
        model.runtime_gateway_len = 0;
        model.runtime_auth_required = false;
    }

    model.message_count = @min(snapshot.messages.len, max_messages);
    for (snapshot.messages[0..model.message_count], 0..) |message, index| {
        model.messages[index].set(index + 1, if (std.mem.eql(u8, message.role, "user")) .user else .assistant, message.content);
    }

    model.tool_count = @min(snapshot.tools.len, max_tools);
    for (snapshot.tools[0..model.tool_count], 0..) |tool, index| {
        const target = &model.tools[index];
        target.id = std.hash.Wyhash.hash(0, tool.id);
        target.name_len = copyText(&target.name_storage, tool.name);
        target.summary_len = copyText(&target.summary_storage, tool.summary);
        target.status_len = copyText(&target.status_storage, tool.status);
        target.failed = tool.isError;
        target.duration_ms = tool.durationMs orelse 0;
    }

    model.subagent_count = @min(snapshot.subagents.len, max_subagents);
    for (snapshot.subagents[0..model.subagent_count], 0..) |subagent, index| {
        const target = &model.subagents[index];
        target.id = std.hash.Wyhash.hash(0, subagent.id);
        target.name_len = copyText(&target.name_storage, subagent.id);
        target.query_len = copyText(&target.query_storage, subagent.query);
        target.status_len = copyText(&target.status_storage, subagent.status);
        var meta_buffer: [96]u8 = undefined;
        const seconds = subagent.durationMs / 1000;
        const meta = if (subagent.@"error") |error_text|
            std.fmt.bufPrint(&meta_buffer, "{s} · {d}s · {s}", .{ subagent.status, seconds, error_text }) catch subagent.status
        else if (subagent.pid) |pid|
            std.fmt.bufPrint(&meta_buffer, "{s} · {d}s · pid {d}", .{ subagent.status, seconds, pid }) catch subagent.status
        else
            std.fmt.bufPrint(&meta_buffer, "{s} · {d}s", .{ subagent.status, seconds }) catch subagent.status;
        target.meta_len = copyText(&target.meta_storage, meta);
    }

    model.session_count = @min(data.sessions.len, max_sessions);
    for (data.sessions[0..model.session_count], 0..) |session, index| {
        const target = &model.sessions[index];
        target.key = std.hash.Wyhash.hash(0, session.sessionId);
        target.id_len = copyText(&target.id_storage, session.sessionId);
        target.prompt_len = copyText(&target.prompt_storage, session.prompt);
        target.selected = target.key == model.selected_session_key;
    }

    model.model_count = @min(data.models.len, max_models);
    for (data.models[0..model.model_count], 0..) |runtime_model, index| {
        const target = &model.models[index];
        target.key = std.hash.Wyhash.hash(0, runtime_model.id);
        target.id_len = copyText(&target.id_storage, runtime_model.id);
        target.name_len = copyText(&target.name_storage, runtime_model.displayName);
        target.selected = model.model_len > 0 and std.mem.eql(u8, target.id(), model.modelLabel());
    }

    const workspace_status = data.workspaceStatus;
    model.workspace_git = workspace_status.git;
    model.workspace_clean = workspace_status.clean;
    model.workspace_branch_len = copyText(&model.workspace_branch_storage, workspace_status.branch);
    model.workspace_summary_len = copyText(&model.workspace_summary_storage, workspace_status.summary);
    model.workspace_change_count = @min(workspace_status.changes.len, max_workspace_changes);
    for (workspace_status.changes[0..model.workspace_change_count], 0..) |change, index| {
        const target = &model.workspace_changes[index];
        target.id = std.hash.Wyhash.hash(0, change.path);
        target.status_len = copyText(&target.status_storage, change.status);
        target.path_len = copyText(&target.path_storage, change.path);
    }
    model.diff_stat_count = @min(workspace_status.diffStat.len, max_diff_stats);
    for (workspace_status.diffStat[0..model.diff_stat_count], 0..) |row, index| {
        const target = &model.diff_stats[index];
        target.id = index + 1;
        target.len = copyText(&target.storage, row);
    }

    const repo_status = data.repoStatus;
    model.repo_git = repo_status.git;
    model.repo_len = copyText(&model.repo_storage, repo_status.repository);
    model.repo_head_len = copyText(&model.repo_head_storage, repo_status.head orelse "");
    model.repo_pr_len = copyText(&model.repo_pr_storage, repo_status.pullRequestUrl orelse "");
    model.repo_actions_len = copyText(&model.repo_actions_storage, repo_status.actionsUrl orelse "");
    model.repo_pr_title_len = 0;
    model.repo_review_len = 0;
    if (repo_status.pullRequest) |pr| {
        var title_buffer: [360]u8 = undefined;
        const title = std.fmt.bufPrint(&title_buffer, "#{d} {s}", .{ pr.number, pr.title }) catch pr.title;
        model.repo_pr_title_len = copyText(&model.repo_pr_title_storage, title);
        var review_buffer: [160]u8 = undefined;
        const review = std.fmt.bufPrint(&review_buffer, "{s} · review {s} · merge {s}", .{
            if (pr.isDraft) "draft" else pr.state,
            pr.reviewDecision orelse "pending",
            pr.mergeStateStatus orelse "unknown",
        }) catch pr.state;
        model.repo_review_len = copyText(&model.repo_review_storage, review);
    }
    model.repo_check_count = @min(repo_status.checks.len, max_repo_checks);
    var pass_count: u64 = 0;
    var fail_count: u64 = 0;
    var pending_count: u64 = 0;
    for (repo_status.checks[0..model.repo_check_count], 0..) |check, index| {
        const target = &model.repo_checks[index];
        target.id = std.hash.Wyhash.hash(0, check.name);
        target.name_len = copyText(&target.name_storage, check.name);
        const state = check.bucket orelse check.state;
        target.state_len = copyText(&target.state_storage, state);
        if (isPassingCheckState(state)) pass_count += 1 else if (isFailingCheckState(state)) fail_count += 1 else pending_count += 1;
    }
    if (model.repo_check_count > 0) {
        var check_summary_buffer: [160]u8 = undefined;
        const summary = std.fmt.bufPrint(&check_summary_buffer, "{d} passing · {d} failing · {d} pending", .{ pass_count, fail_count, pending_count }) catch "";
        model.repo_check_summary_len = copyText(&model.repo_check_summary_storage, summary);
    } else {
        model.repo_check_summary_len = 0;
    }
    model.repo_remote_len = 0;
    if (repo_status.webUrl) |web_url| {
        model.repo_remote_len = copyText(&model.repo_remote_storage, web_url);
    } else if (repo_status.remotes.len > 0) {
        model.repo_remote_len = copyText(&model.repo_remote_storage, repo_status.remotes[0].url);
    }
    model.repo_worktree_count = @min(repo_status.worktrees.len, max_repo_worktrees);
    for (repo_status.worktrees[0..model.repo_worktree_count], 0..) |worktree, index| {
        const target = &model.repo_worktrees[index];
        target.id = std.hash.Wyhash.hash(0, worktree.path);
        target.branch_len = copyText(&target.branch_storage, worktree.branch orelse "");
        target.path_len = copyText(&target.path_storage, worktree.path);
        target.head_len = copyText(&target.head_storage, worktree.head orelse "");
        target.current = worktree.current;
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
    if (snapshot.pendingQuestion) |pending| {
        model.pending_question = pending.questions.len > 0;
        model.question_id_len = copyText(&model.question_id_storage, if (pending.questions.len > 0) pending.questions[0].id else "");
        model.question_text_len = copyText(&model.question_text_storage, if (pending.questions.len > 0) pending.questions[0].question else "");
    } else {
        model.pending_question = false;
        model.question_id_len = 0;
        model.question_text_len = 0;
    }
    return true;
}

fn copyText(destination: anytype, source: []const u8) usize {
    const len = @min(destination.len, source.len);
    @memcpy(destination[0..len], source[0..len]);
    return len;
}

fn setError(model: *Model, message: []const u8) void {
    model.error_len = copyText(&model.error_storage, message);
}

pub fn main(init: std.process.Init) !void {
    const app_state = try LavalampApp.create(std.heap.page_allocator, .{
        .name = "lavalamp",
        .scene = shell_scene,
        .canvas_label = canvas_label,
        .update_fx = update,
        .init_fx = initEffects,
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

test "host binary resolves repo local launcher when available" {
    const binary = hostBinary();
    try std.testing.expect(!std.mem.eql(u8, binary, "lavalamp"));
    try std.testing.expect(std.mem.endsWith(u8, binary, "bin/lavalamp"));
}
