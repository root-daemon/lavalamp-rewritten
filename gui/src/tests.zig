const std = @import("std");
const native_sdk = @import("native_sdk");
const main = @import("main.zig");

const testing = std.testing;

test "snapshot JSON populates conversation, tools, subagents, sessions, and usage" {
    var model = main.initialModel();
    const body =
        \\{"ok":true,"data":{"snapshot":{"cursor":9,"processing":true,"assistantText":"Working","thinkingText":"Inspecting repo","terminalOutput":"3 pass\\n","workspace":"/repo","model":"model-a","provider":"cloudflare","usage":{"input":10,"output":5,"cacheRead":2,"cacheWrite":0,"totalTokens":17,"cost":0.03},"messages":[{"role":"user","content":"Fix tests"},{"role":"assistant","content":"Working"}],"tools":[{"id":"tool-1","name":"bash","summary":"bun test","status":"completed","isError":false,"durationMs":20}],"subagents":[{"id":"child-1","name":"Atlas","task":"Inspect auth","status":"running","startedAt":1}],"pendingPermission":{"requestId":"perm-1","toolName":"edit","args":{"path":"src/a.ts"}},"pendingQuestion":{"requestId":"question-1","questions":[{"id":"choice","question":"Which interface?","type":"select","options":["Native","TUI"]}]}},"sessions":[{"sessionId":"session-a","prompt":"Fix tests","cwd":"/repo"}],"models":[{"id":"model-a","displayName":"Model A"}]}}
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
    try testing.expectEqualStrings("Atlas", model.subagents[0].name());
    try testing.expectEqualStrings("Inspect auth", model.subagents[0].task());
    try testing.expectEqual(@as(usize, 1), model.session_count);
    try testing.expectEqualStrings("session-a", model.sessions[0].id());
    try testing.expect(model.permission_pending);
    try testing.expectEqualStrings("perm-1", model.permissionId());
    try testing.expect(model.questionPending());
    try testing.expectEqualStrings("Which interface?", model.currentQuestionText());
    try testing.expectEqual(@as(usize, 2), model.questionOptionItems().len);
    try testing.expectEqual(@as(u64, 17), model.total_tokens);
}

test "subagent inspection response populates a separate read-only transcript" {
    var model = main.initialModel();
    const body =
        \\{"ok":true,"data":{"subagent":{"id":"child-1","name":"Atlas","task":"Inspect auth","status":"completed","startedAt":1},"messages":[{"role":"user","content":"Inspect auth"},{"role":"assistant","content":"No regression found."}]}}
    ;

    try testing.expect(main.applySubagentInspectionJson(&model, body));
    try testing.expectEqualStrings("## User\n\nInspect auth\n\n## Assistant\n\nNo regression found.", model.subagentTranscript());
}

test "selecting and stopping a subagent emits authenticated read-only requests" {
    var model = main.initialModel();
    model.connected = true;
    model.host_port = 34197;
    model.setAuthToken("token-123");
    try testing.expect(main.applySnapshotJson(&model,
        \\{"ok":true,"data":{"snapshot":{"subagents":[{"id":"child-1","name":"Atlas","task":"Inspect auth","status":"running","startedAt":1}]}}}
    ));
    var fx = main.Effects.init(testing.allocator);
    defer fx.deinit();
    fx.executor = .fake;

    const key = std.hash.Wyhash.hash(0, "child-1");
    main.update(&model, .{ .select_subagent = key }, &fx);
    try testing.expectEqual(@as(usize, 1), fx.pendingFetchCount());
    const inspection = fx.pendingFetchAt(0).?;
    try testing.expectEqual(std.http.Method.GET, inspection.method);
    try testing.expect(std.mem.endsWith(u8, inspection.url, "/v1/subagents/child-1"));

    main.update(&model, .stop_subagent, &fx);
    try testing.expectEqual(@as(usize, 2), fx.pendingFetchCount());
    const stop = fx.pendingFetchAt(1).?;
    try testing.expectEqual(std.http.Method.POST, stop.method);
    try testing.expect(std.mem.endsWith(u8, stop.url, "/v1/subagents/child-1/stop"));
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

test "active turn can queue a follow-up prompt" {
    var model = main.initialModel();
    model.connected = true;
    model.processing = true;
    model.host_port = 34197;
    model.setAuthToken("token-123");
    model.draft.set("Then run the full suite");
    var fx = main.Effects.init(testing.allocator);
    defer fx.deinit();
    fx.executor = .fake;

    main.update(&model, .queue_prompt, &fx);

    try testing.expect(model.draft.isEmpty());
    const request = fx.pendingFetchAt(0).?;
    try testing.expectEqualStrings("Then run the full suite", request.body);
    try testing.expect(std.mem.endsWith(u8, request.url, "/v1/native/queue"));
}

test "starter actions prepare editable prompts" {
    var model = main.initialModel();
    var fx = main.Effects.init(testing.allocator);
    defer fx.deinit();
    fx.executor = .fake;

    main.update(&model, .starter_tests, &fx);

    try testing.expect(std.mem.indexOf(u8, model.draftText(), "test suite") != null);
    try testing.expectEqual(@as(usize, 0), fx.pendingFetchCount());
}

test "question answer posts structured response" {
    var model = main.initialModel();
    model.connected = true;
    model.host_port = 34197;
    model.setAuthToken("token-123");
    try testing.expect(main.applySnapshotJson(&model,
        \\{"ok":true,"data":{"snapshot":{"pendingQuestion":{"requestId":"question-1","questions":[{"id":"name","question":"What should this be called?","type":"input","options":[]}]}}}}
    ));
    model.question_answer.set("Lavalamp");
    var fx = main.Effects.init(testing.allocator);
    defer fx.deinit();
    fx.executor = .fake;

    main.update(&model, .question_next, &fx);

    try testing.expectEqual(@as(usize, 1), fx.pendingFetchCount());
    const request = fx.pendingFetchAt(0).?;
    try testing.expect(std.mem.endsWith(u8, request.url, "/v1/questions/question-1"));
    try testing.expect(std.mem.indexOf(u8, request.body, "\"name\":\"Lavalamp\"") != null);
}

test "model selection posts typed control action" {
    var model = main.initialModel();
    model.connected = true;
    model.host_port = 34197;
    model.setAuthToken("token-123");
    try testing.expect(main.applySnapshotJson(&model,
        \\{"ok":true,"data":{"snapshot":{"model":"model-a"},"models":[{"id":"model-a","displayName":"Model A"},{"id":"model-b","displayName":"Model B"}]}}
    ));
    try testing.expectEqual(@as(usize, 2), model.modelChoiceItems().len);
    var fx = main.Effects.init(testing.allocator);
    defer fx.deinit();
    fx.executor = .fake;

    main.update(&model, .{ .select_model = model.modelChoiceItems()[1].key }, &fx);

    const request = fx.pendingFetchAt(0).?;
    try testing.expect(std.mem.endsWith(u8, request.url, "/v1/native/control"));
    try testing.expect(std.mem.indexOf(u8, request.body, "\"action\":\"model\"") != null);
    try testing.expect(std.mem.indexOf(u8, request.body, "\"model\":\"model-b\"") != null);
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

test "error permission terminal and command branches build together" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var model = main.initialModel();
    model.connected = true;
    try testing.expect(main.applySnapshotJson(&model,
        \\{"ok":true,"data":{"snapshot":{"processing":true,"assistantText":"Working","thinkingText":"Inspecting","terminalOutput":"bun test","error":"Provider unavailable","messages":[{"role":"user","content":"Fix UI"}],"tools":[{"id":"tool-1","name":"bash","summary":"bun test","status":"running"}],"pendingPermission":{"requestId":"perm-1","toolName":"edit"}},"sessions":[{"sessionId":"session-a","prompt":"Fix UI"}]}}
    ));
    try testing.expect(main.applyCommandJson(&model,
        \\{"ok":true,"data":{"title":"/usage","rows":["12 tokens"]}}
    ));

    var view = try main.AppMarkup.init(arena, main.app_markup);
    var ui = main.AppUi.init(arena);
    const root = view.build(&ui, &model) catch |err| {
        std.debug.print("app.native:{d}:{d}: {s}\n", .{ view.diagnostic.line, view.diagnostic.column, view.diagnostic.message });
        return err;
    };
    const tree = try ui.finalize(root);
    try testing.expect(findByKind(tree.root, .alert) != null);
    try testing.expect(findByKind(tree.root, .accordion) != null);
}

fn findByKind(widget: native_sdk.canvas.Widget, kind: native_sdk.canvas.WidgetKind) ?native_sdk.canvas.Widget {
    if (widget.kind == kind) return widget;
    for (widget.children) |child| {
        if (findByKind(child, kind)) |found| return found;
    }
    return null;
}
