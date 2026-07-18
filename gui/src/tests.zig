const std = @import("std");
const native_sdk = @import("native_sdk");
const main = @import("main.zig");

const testing = std.testing;

test "snapshot JSON populates conversation, tools, sessions, and usage" {
    var model = main.initialModel();
    const body =
        \\{"ok":true,"data":{"snapshot":{"cursor":9,"processing":true,"assistantText":"Working","thinkingText":"Inspecting repo","terminalOutput":"3 pass\\n","workspace":"/repo","model":"model-a","provider":"cloudflare","usage":{"input":10,"output":5,"cacheRead":2,"cacheWrite":0,"totalTokens":17,"cost":0.03},"messages":[{"role":"user","content":"Fix tests"},{"role":"assistant","content":"Working"}],"tools":[{"id":"tool-1","name":"bash","summary":"bun test","status":"completed","isError":false,"durationMs":20}],"subagents":[{"id":"sub-1","query":"Audit auth parity","status":"running","pid":1234,"durationMs":2500}],"pendingPermission":{"requestId":"perm-1","toolName":"edit","args":{"path":"src/a.ts"}},"pendingQuestion":{"requestId":"question-1","questions":[{"id":"choice","question":"Ship with tests?","type":"input"}]}},"sessions":[{"sessionId":"session-a","prompt":"Fix tests","cwd":"/repo"}],"models":[{"id":"model-a","displayName":"Model A"}],"workspaceStatus":{"git":true,"branch":"main","clean":false,"summary":"2 changed · 1 unstaged · 1 untracked","changes":[{"status":"M","path":"src/main.ts"},{"status":"??","path":"notes.md"}],"diffStat":["src/main.ts | 2 +-","1 file changed, 1 insertion(+), 1 deletion(-)"]},"repoStatus":{"git":true,"repository":"/repo","branch":"main","head":"abc1234 initial","status":"2 changed","webUrl":"https://github.com/owner/repo","pullRequestUrl":"https://github.com/owner/repo/pulls?q=is%3Apr+head%3Amain","actionsUrl":"https://github.com/owner/repo/actions?query=branch%3Amain","pullRequest":{"number":42,"title":"Ship GUI","state":"OPEN","url":"https://github.com/owner/repo/pull/42","reviewDecision":"APPROVED","mergeStateStatus":"CLEAN","isDraft":false},"checks":[{"name":"test","state":"SUCCESS","bucket":"pass"},{"name":"lint","state":"PENDING","bucket":"pending"}],"remotes":[{"name":"origin","url":"git@github.com:owner/repo.git","webUrl":"https://github.com/owner/repo"}],"worktrees":[{"path":"/repo","branch":"main","head":"abc1234","current":true}]},"runtimeStatus":{"authLabel":"Cloudflare login required","authRequired":true,"backend":"flue","gatewayEnabled":true,"gatewayId":"team","gatewaySupported":true,"model":"model-a","provider":"cloudflare-workers-ai","routeLabel":"cloudflare-workers-ai gateway (team)","routeMode":"gateway"}}}
    ;

    try testing.expect(main.applySnapshotJson(&model, body));
    try testing.expectEqual(@as(u64, 9), model.cursor);
    try testing.expect(model.processing);
    try testing.expectEqualStrings("Working", model.assistantText());
    try testing.expectEqualStrings("Inspecting repo", model.thinkingText());
    try testing.expectEqualStrings("3 pass\\n", model.terminalText());
    try testing.expectEqual(@as(usize, 2), model.message_count);
    try testing.expectEqualStrings("Fix tests", model.messages[0].content());
    try testing.expectEqual(@as(usize, 1), model.tool_count);
    try testing.expectEqualStrings("bun test", model.tools[0].summary());
    try testing.expectEqual(@as(usize, 1), model.subagent_count);
    try testing.expectEqualStrings("sub-1", model.subagents[0].name());
    try testing.expectEqualStrings("Audit auth parity", model.subagents[0].query());
    try testing.expectEqualStrings("running", model.subagents[0].status());
    try testing.expectEqualStrings("running · 2s · pid 1234", model.subagents[0].meta());
    try testing.expectEqual(@as(usize, 1), model.session_count);
    try testing.expectEqualStrings("session-a", model.sessions[0].id());
    try testing.expectEqual(@as(usize, 1), model.model_count);
    try testing.expectEqualStrings("model-a", model.models[0].id());
    try testing.expectEqualStrings("Model A", model.models[0].displayName());
    try testing.expect(model.models[0].selected);
    try testing.expect(model.workspace_git);
    try testing.expect(!model.workspace_clean);
    try testing.expectEqualStrings("main", model.workspaceBranch());
    try testing.expectEqualStrings("2 changed · 1 unstaged · 1 untracked", model.workspaceSummary());
    try testing.expectEqual(@as(usize, 2), model.workspace_change_count);
    try testing.expectEqualStrings("src/main.ts", model.workspace_changes[0].path());
    try testing.expectEqualStrings("M", model.workspace_changes[0].status());
    try testing.expectEqual(@as(usize, 2), model.diff_stat_count);
    try testing.expectEqualStrings("src/main.ts | 2 +-", model.diff_stats[0].text());
    try testing.expect(model.hasRepo());
    try testing.expectEqualStrings("/repo", model.repoLabel());
    try testing.expectEqualStrings("abc1234 initial", model.repoHeadLabel());
    try testing.expectEqualStrings("https://github.com/owner/repo", model.repoRemoteLabel());
    try testing.expectEqualStrings("https://github.com/owner/repo/pulls?q=is%3Apr+head%3Amain", model.repoPrLabel());
    try testing.expectEqualStrings("#42 Ship GUI", model.repoPrTitleLabel());
    try testing.expectEqualStrings("OPEN · review APPROVED · merge CLEAN", model.repoReviewLabel());
    try testing.expectEqualStrings("1 passing · 0 failing · 1 pending", model.repoCheckSummaryLabel());
    try testing.expectEqual(@as(usize, 2), model.repo_check_count);
    try testing.expectEqualStrings("test", model.repo_checks[0].name());
    try testing.expectEqualStrings("pass", model.repo_checks[0].state());
    try testing.expectEqual(@as(usize, 1), model.repo_worktree_count);
    try testing.expectEqualStrings("main", model.repo_worktrees[0].branch());
    try testing.expectEqualStrings("current worktree", model.repo_worktrees[0].meta());
    try testing.expectEqualStrings("cloudflare-workers-ai gateway (team)", model.runtimeRouteLabel());
    try testing.expectEqualStrings("Cloudflare login required", model.runtimeAuthLabel());
    try testing.expectEqualStrings("Gateway team · gateway", model.runtimeGatewayLabel());
    try testing.expect(model.runtime_auth_required);
    try testing.expect(model.permission_pending);
    try testing.expectEqualStrings("perm-1", model.permissionId());
    try testing.expect(model.pending_question);
    try testing.expectEqualStrings("choice", model.question_id_storage[0..model.question_id_len]);
    try testing.expectEqualStrings("Ship with tests?", model.questionText());
    try testing.expectEqual(@as(u64, 17), model.total_tokens);
}

test "session response replaces conversation history" {
    var model = main.initialModel();
    const body =
        \\{"ok":true,"data":{"sessionId":"session-a","messages":[{"role":"user","content":"Original prompt"},{"role":"assistant","content":"Original answer"}]}}
    ;

    try testing.expect(main.applySessionJson(&model, body));
    try testing.expectEqual(@as(usize, 2), model.message_count);
    try testing.expectEqualStrings("Original prompt", model.messages[0].content());
    try testing.expectEqualStrings("Original answer", model.messages[1].content());
}

test "host ready line arms authenticated polling" {
    var model = main.initialModel();
    var fx = main.Effects.init(testing.allocator);
    defer fx.deinit();
    fx.executor = .fake;

    main.update(&model, .{ .host_line = .{
        .key = main.host_process_key,
        .line = "LAVALAMP_GUI_READY 34197 token-123",
    } }, &fx);

    try testing.expect(model.connected);
    try testing.expectEqual(@as(u16, 34197), model.host_port);
    try testing.expectEqualStrings("token-123", model.authToken());
    try testing.expectEqual(@as(usize, 1), fx.pendingTimerCount());
}

test "sending prompt records user message and emits raw HTTP request" {
    var model = main.initialModel();
    model.connected = true;
    model.host_port = 34197;
    model.setAuthToken("token-123");
    model.draft.set("Fix \"quoted\" test");
    var fx = main.Effects.init(testing.allocator);
    defer fx.deinit();
    fx.executor = .fake;

    main.update(&model, .send, &fx);

    try testing.expect(model.draft.isEmpty());
    try testing.expectEqual(@as(usize, 1), fx.pendingFetchCount());
    const request = fx.pendingFetchAt(0).?;
    try testing.expectEqual(std.http.Method.POST, request.method);
    try testing.expectEqualStrings("Fix \"quoted\" test", request.body);
    try testing.expect(std.mem.endsWith(u8, request.url, "/v1/native/prompts"));
}

test "sending while a question is pending answers the runtime question" {
    var model = main.initialModel();
    model.connected = true;
    model.processing = true;
    model.pending_question = true;
    model.host_port = 34197;
    model.setAuthToken("token-123");
    model.question_id_len = 6;
    @memcpy(model.question_id_storage[0..6], "choice");
    model.draft.set("yes \"ship\"\nnow");
    var fx = main.Effects.init(testing.allocator);
    defer fx.deinit();
    fx.executor = .fake;

    main.update(&model, .send, &fx);

    try testing.expect(model.draft.isEmpty());
    try testing.expect(!model.pending_question);
    try testing.expectEqual(@as(usize, 1), fx.pendingFetchCount());
    const request = fx.pendingFetchAt(0).?;
    try testing.expectEqual(std.http.Method.POST, request.method);
    try testing.expect(std.mem.endsWith(u8, request.url, "/v1/questions/choice"));
    try testing.expectEqualStrings("{\"answers\":{\"choice\":\"yes \\\"ship\\\"\\nnow\"}}", request.body);
}

test "selecting a worktree sends a switch command through native host" {
    var model = main.initialModel();
    model.connected = true;
    model.host_port = 34197;
    model.setAuthToken("token-123");
    model.repo_worktree_count = 1;
    model.repo_worktrees[0].id = 42;
    model.repo_worktrees[0].branch_len = 13;
    @memcpy(model.repo_worktrees[0].branch_storage[0..13], "task/gui-lane");
    model.repo_worktrees[0].path_len = 10;
    @memcpy(model.repo_worktrees[0].path_storage[0..10], "/tmp/lane1");

    var fx = main.Effects.init(testing.allocator);
    defer fx.deinit();
    fx.executor = .fake;

    main.update(&model, .{ .select_worktree = 42 }, &fx);

    try testing.expectEqual(@as(usize, 1), fx.pendingFetchCount());
    const request = fx.pendingFetchAt(0).?;
    try testing.expectEqual(std.http.Method.POST, request.method);
    try testing.expect(std.mem.endsWith(u8, request.url, "/v1/native/commands"));
    try testing.expectEqualStrings("/worktree switch task/gui-lane", request.body);
}

test "new chat resets view and clears the backend session" {
    var model = main.initialModel();
    model.connected = true;
    model.host_port = 34197;
    model.setAuthToken("token-123");
    try testing.expect(main.applySnapshotJson(&model,
        \\{"ok":true,"data":{"snapshot":{"messages":[{"role":"user","content":"Old task"},{"role":"assistant","content":"Old answer"}],"tools":[{"id":"tool-1","name":"bash","summary":"bun test","status":"completed","isError":false}],"subagents":[{"id":"sub-1","query":"Audit","status":"running","durationMs":1000}],"pendingQuestion":{"requestId":"question-1","questions":[{"id":"choice","question":"Choose"}]}}}}
    ));

    var fx = main.Effects.init(testing.allocator);
    defer fx.deinit();
    fx.executor = .fake;

    main.update(&model, .new_chat, &fx);

    try testing.expectEqual(@as(usize, 0), model.message_count);
    try testing.expectEqual(@as(usize, 0), model.tool_count);
    try testing.expectEqual(@as(usize, 0), model.subagent_count);
    try testing.expect(!model.pending_question);
    try testing.expectEqual(@as(usize, 1), fx.pendingFetchCount());
    const request = fx.pendingFetchAt(0).?;
    try testing.expect(std.mem.endsWith(u8, request.url, "/v1/native/commands"));
    try testing.expectEqualStrings("/clear", request.body);
}

test "composer edit and submit dispatch through native markup" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var model = main.initialModel();
    model.connected = true;
    try testing.expect(main.applySnapshotJson(&model,
        \\{"ok":true,"data":{"snapshot":{"messages":[{"role":"user","content":"Ship it"}]}}}
    ));

    var view = try main.AppMarkup.init(arena, main.app_markup);
    var ui = main.AppUi.init(arena);
    const root = view.build(&ui, &model) catch |err| {
        std.debug.print("app.native:{d}:{d}: {s}\n", .{ view.diagnostic.line, view.diagnostic.column, view.diagnostic.message });
        return err;
    };
    const tree = try ui.finalize(root);
    try testing.expect(findByKind(tree.root, .input_group) != null);
    try testing.expect(findByKind(tree.root, .bubble) != null);
    try testing.expect(findByKind(tree.root, .status_bar) != null);
    const composer = findByKind(tree.root, .textarea).?;
    const edit = tree.msgForTextEdit(composer.id, .{ .insert_text = "Ship it" }).?;
    try testing.expect(edit == .draft_edit);
}

fn findByKind(widget: native_sdk.canvas.Widget, kind: native_sdk.canvas.WidgetKind) ?native_sdk.canvas.Widget {
    if (widget.kind == kind) return widget;
    for (widget.children) |child| {
        if (findByKind(child, kind)) |found| return found;
    }
    return null;
}
