import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  ScrollBoxRenderable,
  MarkdownRenderable,
  TextAttributes,
  defaultTextareaKeyBindings,
} from '@opentui/core';
import type { KeyEvent, CliRenderer } from '@opentui/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  PermissionRequestMsg,
  PromptImage,
  QuestionRequestMsg,
} from './ipc';
import { SubAgentManager } from './subs';
import { COLORS } from './theme';
import type { Message } from './state';
import { AppStateStore } from './storage/Store';
import { handleKeyPress } from './events/Keybindings';
import { ConfirmBoxManager } from './components/ConfirmBox';
import { PermissionBoxManager } from './components/PermissionBox';
import { QuestionBoxManager } from './components/QuestionBox';
import { ResultPanelManager } from './components/ResultPanel';
import { CompletionManager } from './components/CompletionManager';
import { QueuePanelManager, SubPanelManager } from './components/QueueSubPanel';
import { TaskPanelManager } from './components/TaskPanel';
import { MessageRenderer } from './components/Messages';
import { ToolUiManager, type ToolGroupEntry } from './components/ToolUi';
import { LAVA_LAMP_FRAMES, syntaxStyle } from './art';
import { discoverSkills } from './discover';
import {
  nameSession,
  saveSession,
  saveCodexSession,
  listSessions,
  loadSession,
  loadCodexSession,
} from './sessions';
import {
  stripCwd,
  summarizeToolArgs,
  extractResultText,
  extractFilePaths,
} from './tools';
import {
  autorunPattern,
  isAllowAll,
  loadAutorun,
  setAllowAll,
  setAutorun,
} from '../permissions/autorun';
import { getDefaultRules, loadRules } from '../permissions/rules';
import { BackupEngine } from '../storage/backups';
import { planMutationBackup } from '../storage/mutation-backups';
import { steerPrompt } from '../storage/steering';
import {
  copyTextToClipboard,
  pasteImageFromClipboard,
} from '../storage/clipboard';
import { describeImageWithSpectacle } from '../storage/spectacle';
import { openCodeViewer, openDiffViewer } from './viewers';
import { configPath, resolveConfig, updateConfig } from '../config/user-config';
import { BUILD_MODEL, getModelEntry } from '../config/models';
import { resolveRuntimeRoute, routeSummary } from '../config/runtime-route';
import { HELP_COMMANDS, HELP_KEYS } from './slash-data';
import {
  createTuiLifetime,
  formatExitSummary,
  startRuntimeWithTuiCleanup,
} from './lifecycle';
import {
  createModelPickerState,
  loadModelPickerModels,
  moveModelPickerSelection,
  selectedModelId,
  type ModelPickerEntry,
  type ModelPickerState,
} from './model-picker';
import { mountInputStack } from './input-stack';
import { attachmentsForPrompt, type AttachedImage } from './attachments';
import { formatTuiError } from './errors';
import { truncateToolResult } from '../tools/result-budget';
import { parseBackend, type AgentBackend } from '../runtime/backend';
import { createRuntimeProcess } from '../runtime/process';
import type { RuntimeEvent, RuntimeResult } from '../runtime/types';
import { reconstructCodexMessages } from '../runtime/codex/history';
import { isCodexLoginRequired } from '../runtime/codex/runtime';
import { AnalyticsRecorder, formatAnalyticsRows } from '../analytics';
import { login as cloudflareLogin } from '../auth/login';
import { openBrowser } from '../auth/browser';
import { loginFromTui } from './login';

export interface TuiOptions {
  backend: AgentBackend;
  allowModelFallback?: boolean;
  serverPath: string;
  cwd: string;
  agentName?: string;
  model?: string;
  resumeSession?: boolean;
  resumeSessionId?: string;
}

function shortenPath(p: string): string {
  const home = process.env.HOME ?? '';
  if (home && p.startsWith(home)) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}

function visiblePrompt(prompt: string): string {
  return prompt.replace(/^<<(?:PLAN|BUILD)_MODE>>\s*/, '');
}

function isAuthError(err: Error): boolean {
  return /\b401\b/.test(err.message);
}

function hexToAnsi(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `\u001B[38;2;${r};${g};${b}m`;
}

function formatAge(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) {
    return 'just now';
  }
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}m`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

export async function startTui(options: TuiOptions): Promise<void> {
  const store = new AppStateStore(options.cwd, options.model);
  const state = store.getState();
  const lifetime = createTuiLifetime();
  const backupEngine = new BackupEngine(options.cwd);
  const backupHistory: string[] = [];
  let turnBackupId: string | null = null;
  const attachedImages: AttachedImage[] = [];
  let imageCounter = 0;

  function accent(): string {
    return state.planMode ? COLORS.planAccent : COLORS.accent;
  }

  const { cwd } = options;
  let idCounter = 0;
  function nextId(): string {
    return `el-${++idCounter}`;
  }
  let destroyed = false;
  let root: CliRenderer['root'];
  const boxCtx = {
    nextId,
    get renderer() {
      return renderer;
    },
    get root() {
      return renderer.root;
    },
  };

  let currentSessionId = options.resumeSessionId ?? `session_${Date.now()}`;
  const baseAgentName = options.agentName ?? 'build';
  const initialCodexRecord = options.backend === 'codex' && options.resumeSessionId !== undefined
    ? loadCodexSession(options.resumeSessionId)
    : null;
  const initialAgentName = initialCodexRecord?.mode === 'plan'
    ? 'plan'
    : initialCodexRecord?.mode === 'ask' ? 'explore' : baseAgentName;
  state.planMode = initialCodexRecord?.mode === 'plan';
  let activeBackend = options.backend;
  let flue = createRuntimeProcess({
    agentName: initialAgentName,
    allowModelFallback: options.allowModelFallback,
    backend: activeBackend,
    cwd: options.cwd,
    model: options.model,
    serverPath: options.serverPath,
    sessionId: currentSessionId,
  });
  let analytics = AnalyticsRecorder.create({
    agent: baseAgentName,
    conversationSessionId: currentSessionId,
    mode: 'tui',
    workspaceRoot: cwd,
  });
  let activeAnalyticsTurn: string | undefined;
  let activeStopReason: string | undefined;
  loadAutorun(cwd);
  const permissionRules = loadRules(cwd);
  const subManager = new SubAgentManager(
    options.serverPath,
    options.cwd,
    options.agentName ?? 'build',
    analytics,
    () => activeAnalyticsTurn,
  );
  let contextTransferPending = false;

  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [
      'SIGTERM',
      'SIGQUIT',
      'SIGABRT',
      'SIGHUP',
      'SIGBREAK',
      'SIGPIPE',
      'SIGBUS',
    ],
    onDestroy: () => {
      saveSessionSnapshot();
      if (!exiting) {
        analytics.finishTurn(activeAnalyticsTurn, 'interrupted');
        activeAnalyticsTurn = undefined;
        analytics.finish('interrupted');
      }
      analytics.close();
      destroyed = true;
      lifetime.markDestroyed();
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
      }
      clearInterval(lavaLampTimer);
      subManager.killAll();
      flue.shutdown().catch(() => {});
    },
    screenMode: 'alternate-screen',
    useMouse: true,
  });

  ({ root } = renderer);

  const confirmBoxMgr = new ConfirmBoxManager(boxCtx);
  const permissionBoxMgr = new PermissionBoxManager({
    cwd: options.cwd,
    nextId: boxCtx.nextId,
    get renderer() {
      return boxCtx.renderer;
    },
    get root() {
      return boxCtx.root;
    },
  });
  const questionBoxMgr = new QuestionBoxManager({
    nextId: boxCtx.nextId,
    get renderer() {
      return boxCtx.renderer;
    },
    get root() {
      return boxCtx.root;
    },
  });

  function wireRuntime(): void {
    flue.onPermissionRequest = (request: PermissionRequestMsg) => {
      (async () => {
        const choice = await permissionBoxMgr.show(request);
        analytics.event(
          'permission',
          choice === 'allow' || choice === 'always' ? 'allowed' : 'denied',
          activeAnalyticsTurn,
        );
        if (choice === 'always') {
          if (activeBackend === 'flue') {
            setAutorun(
              cwd,
              request.toolName,
              'allow',
              autorunPattern(request.args),
            );
          }
          flue.sendPermissionResponse(
            request.requestId,
            'allow',
            request.allowSession !== false,
          );
          updateStatus();
        } else {
          flue.sendPermissionResponse(
            request.requestId,
            choice === 'allow' ? 'allow' : 'deny',
          );
        }
      })().catch(() => {});
    };
    flue.onQuestionRequest = (request: QuestionRequestMsg) => {
      (async () => {
        const answers = await questionBoxMgr.show(request.questions);
        flue.sendQuestionResponse(request.requestId, answers);
      })().catch(() => {});
    };
    flue.onBashStream = (chunk: string, stream: 'stdout' | 'stderr') => {
      if (streamingBashEntry !== null) {
        toolUiMgr.streamToEntry(streamingBashEntry, chunk, stream);
      }
    };
    flue.onServerRequestResolved = () => {
      if (permissionBoxMgr.isVisible()) permissionBoxMgr.hide('deny');
      if (questionBoxMgr.isVisible()) questionBoxMgr.hide({});
    };
  }
  wireRuntime();
  root.flexDirection = 'column';
  root.width = '100%';
  root.height = '100%';

  let scrollPending = false;
  let userHasScrolledUp = false;
  let lastScrollTop = 0;

  function requestScroll() {
    if (destroyed) {
      return;
    }
    if (userHasScrolledUp) {
      return;
    }
    if (scrollPending) {
      return;
    }
    scrollPending = true;
    queueMicrotask(() => {
      if (!destroyed) {
        messagesScroll.scrollBy(1000);
      }
      scrollPending = false;
    });
  }

  const header = new BoxRenderable(renderer, {
    flexDirection: 'row',
    height: 2,
    id: 'header',
    paddingBottom: 1,
    paddingLeft: 1,
    paddingRight: 1,
    width: '100%',
  });
  const headerTitle = new TextRenderable(renderer, {
    attributes: TextAttributes.BOLD,
    content: 'lavalamp',
    fg: COLORS.accent,
    id: 'header-title',
    selectable: false,
  });
  header.add(headerTitle);
  root.add(header);

  const messagesScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    id: 'messages',
    paddingLeft: 1,
    paddingRight: 1,
    scrollY: true,
    stickyScroll: false,
    width: '100%',
  });
  root.add(messagesScroll);

  messagesScroll.on('scroll', () => {
    const currentScrollTop = messagesScroll.scrollTop;
    if (currentScrollTop < lastScrollTop) {
      userHasScrolledUp = true;
    } else {
      const { scrollHeight } = messagesScroll;
      const atBottom = scrollHeight - currentScrollTop < 50;
      if (atBottom) {
        userHasScrolledUp = false;
      }
    }
    lastScrollTop = currentScrollTop;
  });

  const completionBox = new BoxRenderable(renderer, {
    border: true,
    borderColor: COLORS.border,
    borderStyle: 'single',
    flexDirection: 'column',
    flexShrink: 0,
    id: 'completion-box',
    maxHeight: 10,
    paddingLeft: 1,
    paddingRight: 1,
    visible: false,
    width: '100%',
  });
  const completionScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    id: 'completion-scroll',
    maxHeight: 10,
    scrollY: true,
    width: '100%',
  });
  completionBox.add(completionScroll);

  const lavaLampBox = new BoxRenderable(renderer, {
    alignItems: 'center',
    flexDirection: 'column',
    flexGrow: 1,
    id: 'lava-lamp-box',
    justifyContent: 'center',
    visible: true,
    width: '100%',
  });
  const lavaLampText = new TextRenderable(renderer, {
    content: (LAVA_LAMP_FRAMES[0] ?? []).join('\n'),
    fg: COLORS.accent,
    id: 'lava-lamp-text',
    selectable: false,
  });
  lavaLampBox.add(lavaLampText);
  messagesScroll.add(lavaLampBox);

  let lavaLampFrame = 0;
  const lavaLampTimer = setInterval(() => {
    if (destroyed) {
      return;
    }
    lavaLampFrame = (lavaLampFrame + 1) % LAVA_LAMP_FRAMES.length;
    lavaLampText.content = (LAVA_LAMP_FRAMES[lavaLampFrame] ?? []).join('\n');
  }, 600);

  const taskStatusBar = new BoxRenderable(renderer, {
    flexDirection: 'row',
    height: 1,
    id: 'task-status-bar',
    paddingLeft: 1,
    visible: false,
    width: '100%',
  });
  const taskStatusText = new TextRenderable(renderer, {
    content: '',
    fg: COLORS.green,
    id: 'task-status-text',
  });
  taskStatusBar.add(taskStatusText);
  root.add(taskStatusBar);

  const SPINNER_FRAMES = [
    '▓░░░░░',
    '▒▓░░░░',
    '░▒▓░░░',
    '░░▒▓░░',
    '░░░▒▓░',
    '░░░░▒▓',
    '░░░░░▒',
  ];
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;

  function startSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
    }
    spinnerFrame = 0;
    updateStatus();
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      updateStatus();
      renderer.requestRender();
    }, 80);
  }

  function stopSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    updateStatus();
  }

  const resultTitle = new TextRenderable(renderer, {
    attributes: TextAttributes.BOLD,
    content: '',
    fg: COLORS.white,
    height: 1,
    id: nextId(),
    width: '100%',
  });
  const resultScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    id: 'result-scroll',
    maxHeight: 18,
    scrollY: true,
    width: '100%',
  });
  const resultBox = new BoxRenderable(renderer, {
    flexDirection: 'column',
    flexShrink: 0,
    id: 'result-box',
    maxHeight: 20,
    visible: false,
    width: '100%',
  });
  resultBox.add(resultTitle);
  resultBox.add(resultScroll);
  root.add(resultBox);

  const resultPanelMgr = new ResultPanelManager({
    inputField: { focus: () => inputField.focus() },
    messagesScroll,
    nextId,
    renderer,
    resultBox,
    resultScroll,
    resultTitle,
  });

  function showResultPanel(
    title: string,
    rows: { content: string; fg?: string; bold?: boolean }[],
  ) {
    resultPanelMgr.show(title, rows);
  }

  function hideResultPanel() {
    resultPanelMgr.hide();
  }

  // Let confirmBoxMgr and permissionBoxMgr reuse confirmBox/permissionBox from root
  const confirmBox = confirmBoxMgr.box;
  const permissionBox = permissionBoxMgr.box;
  const questionBox = questionBoxMgr.box;

  function showConfirm(
    title: string,
    rows: { content: string; fg?: string }[],
    resolve: (choice: boolean) => void,
    timeoutMs = 2000,
    acceptReturn = false,
    acceptCtrlC = true,
  ) {
    confirmBoxMgr.show(
      title,
      rows,
      resolve,
      timeoutMs,
      acceptReturn,
      acceptCtrlC,
    );
  }

  function hideConfirm(choice: boolean) {
    confirmBoxMgr.hide(choice);
  }

  // ── SpecApprovalBox ────────────────────────────────────────────────
  const specApprovalBox = new BoxRenderable(renderer, {
    borderColor: COLORS.planAccent,
    borderStyle: 'single',
    flexDirection: 'column',
    flexShrink: 0,
    id: 'spec-approval-box',
    paddingBottom: 0,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 0,
    visible: false,
    width: '100%',
  });
  const specApprovalTitle = new TextRenderable(renderer, {
    attributes: TextAttributes.BOLD,
    content: ' Approve Plan?',
    fg: COLORS.planAccent,
    height: 1,
    id: 'spec-approval-title',
    width: '100%',
  });
  const specApprovalBody = new BoxRenderable(renderer, {
    flexDirection: 'column',
    id: 'spec-approval-body',
    width: '100%',
  });
  specApprovalBox.add(specApprovalTitle);
  specApprovalBox.add(specApprovalBody);
  root.add(specApprovalBox);

  let specApprovalResolve: ((choice: boolean) => void) | null = null;

  function showSpecApprovalBox(resolve: (choice: boolean) => void) {
    for (const child of specApprovalBody.getChildren()) {
      child.destroy();
    }
    specApprovalBody.add(
      new TextRenderable(renderer, {
        content:
          '  Press [y] to Approve & switch to Build Mode, or [n] to continue planning.',
        fg: COLORS.gray,
        id: nextId(),
        width: '100%',
      }),
    );
    specApprovalBox.visible = true;
    specApprovalResolve = resolve;
    requestScroll();
    renderer.requestRender();
  }

  function hideSpecApprovalBox(choice: boolean) {
    specApprovalBox.visible = false;
    for (const child of specApprovalBody.getChildren()) {
      child.destroy();
    }
    if (specApprovalResolve) {
      const resolve = specApprovalResolve;
      specApprovalResolve = null;
      resolve(choice);
    }
    requestScroll();
    renderer.requestRender();
  }

  const queuePanelMgr = new QueuePanelManager(boxCtx);
  const subPanelMgr = new SubPanelManager(boxCtx);
  const subBox = subPanelMgr.box;

  function withModeTag(prompt: string, overridePlanMode?: boolean): string {
    const planMode = overridePlanMode ?? state.planMode;
    if (
      prompt.startsWith('<<PLAN_MODE>>') ||
      prompt.startsWith('<<BUILD_MODE>>')
    ) {
      return prompt;
    }
    return `${planMode ? '<<PLAN_MODE>>' : '<<BUILD_MODE>>'} ${prompt}`;
  }

  function refreshQueuePanel() {
    queuePanelMgr.refresh(
      state.steerPending,
      state.queuePending,
      visiblePrompt,
    );
  }

  function refreshSubPanel() {
    subPanelMgr.refresh(state.subAgents, SPINNER_FRAMES, spinnerFrame);
  }

  subManager.onUpdate = (subs) => {
    state.subAgents = subs;
    refreshSubPanel();
    updateStatus();
  };

  subManager.onAllComplete = (summary) => {
    refreshSubPanel();
    const followUp = `The parallel research has completed. Here are the findings:\n\n${summary}\n\nPlease analyze these results and continue with your task.`;
    if (state.processing) {
      state.queuePending.push(withModeTag(followUp));
    } else {
      _sendPrompt(followUp).catch((error: unknown) => {
        addInfoLine(
          `  subagent follow-up failed: ${error instanceof Error ? error.message : String(error)}`,
          COLORS.red,
        );
      });
    }
    refreshQueuePanel();
  };

  const taskPanelMgr = new TaskPanelManager(boxCtx);
  const taskBox = taskPanelMgr.box;

  function refreshTaskPanel() {
    taskPanelMgr.refresh(state.tasks);
  }

  function handleTaskToolStart(args: Record<string, unknown>) {
    const action = typeof args.action === 'string' ? args.action : '';
    const id = typeof args.id === 'number' ? args.id : 0;
    const title = typeof args.title === 'string' ? args.title : '';

    if (action === 'create' && title) {
      const newId =
        state.tasks.length > 0
          ? Math.max(...state.tasks.map((task) => task.id)) + 1
          : 1;
      state.tasks.push({ id: newId, status: 'pending', title });
    } else if (action === 'complete') {
      const task = state.tasks.find((tk) => tk.id === id);
      if (task) {
        task.status = 'completed';
      }
    } else if (action === 'skip') {
      const task = state.tasks.find((tk) => tk.id === id);
      if (task) {
        task.status = 'skipped';
      }
    } else if (action === 'edit') {
      const task = state.tasks.find((tk) => tk.id === id);
      if (task && title) {
        task.title = title;
      }
    } else if (action === 'delete') {
      state.tasks = state.tasks.filter((tk) => tk.id !== id);
    } else if (action === 'start' || action === 'in_progress') {
      const task = state.tasks.find((tk) => tk.id === id);
      if (task) {
        task.status = 'in_progress';
      }
    }
    refreshTaskPanel();
  }

  const MAX_INPUT_HEIGHT = 6;
  const inputSeparatorTop = new TextRenderable(renderer, {
    content: '─'.repeat(500),
    fg: COLORS.border,
    height: 1,
    id: 'input-separator-top',
    selectable: false,
    width: '100%',
  });

  const inputRow = new BoxRenderable(renderer, {
    flexDirection: 'row',
    height: 1,
    id: 'input-row',
    paddingBottom: 0,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 0,
    width: '100%',
  });

  const inputPrefixBox = new BoxRenderable(renderer, {
    flexDirection: 'column',
    height: 1,
    id: 'input-prefix',
    width: 2,
  });

  function createPrefixLine(): TextRenderable {
    return new TextRenderable(renderer, {
      attributes: TextAttributes.BOLD,
      content: '┃',
      fg: accent(),
      height: 1,
      id: nextId(),
      selectable: false,
      width: 2,
    });
  }

  inputPrefixBox.add(createPrefixLine());

  const inputField = new TextareaRenderable(renderer, {
    cursorColor: COLORS.accent,
    flexGrow: 1,
    height: 1,
    id: 'input',
    keyBindings: [
      ...defaultTextareaKeyBindings.filter(
        (b) =>
          b.name !== 'return' && b.name !== 'kpenter' && b.name !== 'linefeed',
      ),
      { action: 'submit', name: 'return' },
      { action: 'newline', name: 'return', shift: true },
    ],
    onContentChange: () => {
      const text = inputField.plainText;
      const lines = text.split('\n');
      const termWidth = renderer.terminalWidth ?? 80;
      const availWidth = Math.max(20, termWidth - 5);

      let visualLines = 0;
      for (const line of lines) {
        visualLines += Math.max(1, Math.ceil(line.length / availWidth));
      }
      visualLines = Math.max(1, visualLines);
      const targetHeight = Math.min(visualLines, MAX_INPUT_HEIGHT);

      const prefixCount = inputPrefixBox.getChildren().length;
      if (targetHeight > prefixCount) {
        for (let i = prefixCount; i < targetHeight; i++) {
          inputPrefixBox.add(createPrefixLine());
        }
      } else if (targetHeight < prefixCount) {
        const kids = inputPrefixBox.getChildren();
        while (kids.length > targetHeight) {
          const last = kids.pop();
          if (last) {
            last.destroy();
          }
        }
      }

      if (inputRow.height !== targetHeight) {
        inputRow.height = targetHeight;
        inputField.height = targetHeight;
        inputPrefixBox.height = targetHeight;
      }
    },
    onSubmit: () => {},
    placeholder: 'Type your message...',
    textColor: COLORS.white,
    wrapMode: 'word',
  });
  inputRow.add(inputPrefixBox);
  inputRow.add(inputField);
  mountInputStack(root, {
    completionBox,
    confirmBox: confirmBoxMgr.box,
    inputRow,
    inputSeparatorTop,
    permissionBox: permissionBoxMgr.box,
  });

  const completion = new CompletionManager({
    accent: (): string => accent(),
    completionBox,
    completionScroll,
    cwd,
    inputField,
    inputSeparatorTop,
    nextId,
    renderer,
  });

  const inputSeparatorBottom = new TextRenderable(renderer, {
    content: '─'.repeat(500),
    fg: COLORS.border,
    height: 1,
    id: 'input-separator-bottom',
    selectable: false,
    width: '100%',
  });
  root.add(inputSeparatorBottom);

  const statusBar = new BoxRenderable(renderer, {
    flexDirection: 'row',
    height: 1,
    id: 'status-bar',
    paddingLeft: 1,
    paddingRight: 1,
    width: '100%',
  });
  const statusSpinner = new TextRenderable(renderer, {
    content: '',
    fg: COLORS.accent,
    id: 'status-spinner',
    selectable: false,
  });
  const statusText = new TextRenderable(renderer, {
    content: '',
    fg: COLORS.gray,
    flexGrow: 1,
    id: 'status-text',
    selectable: false,
  });
  const statusMode = new TextRenderable(renderer, {
    content: '',
    fg: COLORS.planAccent,
    id: 'status-mode',
    selectable: false,
  });
  const statusPath = new TextRenderable(renderer, {
    content: '',
    fg: COLORS.gray,
    id: 'status-path',
    selectable: false,
  });
  statusBar.add(statusSpinner);
  statusBar.add(statusMode);
  statusBar.add(statusText);
  statusBar.add(statusPath);
  root.add(statusBar);

  const viewerOverlay = new BoxRenderable(renderer, {
    flexDirection: 'column',
    height: '100%',
    id: 'viewer-overlay',
    visible: false,
    width: '100%',
  });

  const mainTuiChildren = [
    header,
    messagesScroll,
    completionBox,
    taskStatusBar,
    resultBox,
    confirmBox,
    permissionBox,
    questionBox,
    specApprovalBox,
    queuePanelMgr.box,
    taskBox,
    subBox,
    inputSeparatorTop,
    inputRow,
    inputSeparatorBottom,
    statusBar,
  ];

  function hideMainTui() {
    for (const child of mainTuiChildren) {
      root.remove(child.id);
    }
    if (viewerOverlay.parent === null) {
      root.add(viewerOverlay);
    }
    viewerOverlay.visible = true;
  }

  function showMainTui() {
    viewerOverlay.visible = false;
    root.remove(viewerOverlay.id);
    for (const child of mainTuiChildren) {
      root.add(child);
    }
  }

  const planStatusLine = new TextRenderable(renderer, {
    content: '',
    fg: COLORS.planAccent,
    id: 'plan-status',
    visible: false,
  });
  messagesScroll.add(planStatusLine);

  function updateHeader() {
    headerTitle.content = state.planMode
      ? 'lavalamp [PLAN]'
      : options.agentName === 'explore'
        ? 'lavalamp [ASK]'
        : 'lavalamp';
    headerTitle.fg = accent();
    statusPath.content = shortenPath(cwd);
  }

  function updatePromptChar() {
    inputField.cursorColor = accent();
    for (const child of inputPrefixBox.getChildren()) {
      if (child instanceof TextRenderable) {
        child.fg = accent();
      }
    }
  }

  function updateStatus() {
    refreshSubPanel();
    const subCount = state.subAgents.filter(
      (sub) => sub.status === 'running',
    ).length;
    const sudo = isAllowAll() ? ' | ░▒▓ SUDO ▓▒░' : '';

    if (state.planMode) {
      statusMode.content = 'PLAN ';
      statusMode.fg = COLORS.planAccent;
      statusMode.visible = true;
    } else {
      statusMode.content = '';
      statusMode.visible = false;
    }

    if (state.processing) {
      statusSpinner.content = `${SPINNER_FRAMES[spinnerFrame]} `;
      statusSpinner.fg = accent();
      statusSpinner.visible = true;
      statusText.content = 'waiting for model...';
      statusText.fg = COLORS.dim;
    } else if (state.queuePending.length > 0) {
      statusSpinner.content = '';
      statusSpinner.visible = false;
      statusText.content = `queued: ${state.queuePending.length} messages${subCount ? ` | ${subCount} subagents running` : ''}${sudo}`;
      statusText.fg = COLORS.yellow;
    } else {
      const isSubsRunning = subCount > 0;
      if (isSubsRunning) {
        statusSpinner.content = `${SPINNER_FRAMES[spinnerFrame]} `;
        statusSpinner.fg = accent();
        statusSpinner.visible = true;
        statusText.content = `${subCount} subagents running${sudo}`;
      } else {
        statusSpinner.content = '';
        statusSpinner.visible = false;
        statusText.content = sudo ? sudo.replace(' | ', '') : '';
      }
      statusText.fg = sudo ? COLORS.pink : COLORS.gray;
    }
  }

  function applyModeVisuals() {
    updatePromptChar();
    updateHeader();
    updateStatus();
    inputField.focus();
    renderer.requestRender();
  }

  let modeSwitching = false;

  async function setPlanMode(enabled: boolean) {
    if (enabled === state.planMode || modeSwitching) {
      return;
    }
    if (state.processing) {
      addInfoLine(
        '  finish or interrupt the current turn before switching modes',
        COLORS.yellow,
      );
      return;
    }

    const previousAgentName = state.planMode ? 'plan' : baseAgentName;
    const nextAgentName = enabled ? 'plan' : baseAgentName;
    modeSwitching = true;
    state.processing = true;
    updateStatus();

    try {
      if (activeBackend === 'codex' && flue.switchMode !== undefined) {
        await flue.switchMode(enabled ? 'plan' : baseAgentName === 'explore' ? 'ask' : 'build');
      } else {
        flue.setAgentName(nextAgentName);
        await flue.restart();
      }
      state.planMode = enabled;
      contextTransferPending = true;
      applyModeVisuals();
    } catch (error) {
      try {
        if (activeBackend === 'codex' && flue.switchMode !== undefined) {
          await flue.switchMode(state.planMode ? 'plan' : baseAgentName === 'explore' ? 'ask' : 'build');
        } else {
          flue.setAgentName(previousAgentName);
          await flue.restart();
        }
      } catch {}
      addInfoLine(
        `  could not switch mode: ${error instanceof Error ? error.message : String(error)}`,
        COLORS.red,
      );
    } finally {
      modeSwitching = false;
      state.processing = false;
      updateStatus();
      drainPending();
    }
  }

  function hideLavaLamp() {
    if (lavaLampBox.visible) {
      lavaLampBox.visible = false;
    }
  }

  function summarizeToolArgsShort(
    name: string,
    args: Record<string, unknown>,
  ): string {
    switch (name) {
      case 'bash': {
        const cmd =
          typeof args.command === 'string'
            ? args.command
            : typeof args.cmd === 'string'
              ? args.cmd
              : '';
        return cmd.length > 50 ? `${cmd.slice(0, 47)}...` : cmd;
      }
      case 'read':
      case 'write':
      case 'edit': {
        const fp =
          typeof args.file_path === 'string'
            ? args.file_path
            : typeof args.path === 'string'
              ? args.path
              : '';
        return stripCwd(fp, cwd);
      }
      case 'fetch_url':
      case 'web_search': {
        const url =
          typeof args.url === 'string'
            ? args.url
            : typeof args.query === 'string'
              ? args.query
              : '';
        return url.length > 50 ? `${url.slice(0, 47)}...` : url;
      }
      case 'ripgrep':
      case 'grep':
      case 'codebase_search': {
        const q =
          typeof args.pattern === 'string'
            ? args.pattern
            : typeof args.query === 'string'
              ? args.query
              : '';
        return q.length > 50 ? `${q.slice(0, 47)}...` : q;
      }
      default: {
        const entries = Object.entries(args);
        if (entries.length === 0) {
          return '';
        }
        const parts: string[] = [];
        for (const [, v] of entries.slice(0, 2)) {
          if (typeof v === 'string') {
            parts.push(v.length > 30 ? `${v.slice(0, 27)}...` : v);
          } else if (typeof v === 'number' || typeof v === 'boolean') {
            parts.push(String(v));
          }
        }
        return parts.join(' ');
      }
    }
  }

  const storedDiffs = new Map<string, { diff: string; filePath: string }>();

  const messageRenderer = new MessageRenderer({
    hideLavaLamp,
    messagesScroll,
    nextId,
    renderer,
  });

  const toolUiCtx = {
    cwd,
    hideLavaLamp,
    messagesScroll,
    nextId,
    renderer,
    requestScroll,
    storedDiffs,
  };
  const toolUiMgr = new ToolUiManager(toolUiCtx);

  function updateTaskStatus(name: string, args: Record<string, unknown>) {
    const summary = summarizeToolArgsShort(name, args);
    taskStatusText.content = `  ${name} ${summary}`;
    taskStatusText.fg = COLORS.green;
    taskStatusBar.visible = true;
  }

  function clearTaskStatus() {
    taskStatusBar.visible = false;
    taskStatusText.content = '';
  }

  function addUserLine(content: string) {
    messageRenderer.addUser(content);
  }

  function addAssistantMarkdown(content: string) {
    messageRenderer.addAssistantMarkdown(content);
  }

  function addInfoLine(content: string, color?: string) {
    messageRenderer.addInfo(content, color);
  }

  function populateToolEntryContent(
    entry: ToolGroupEntry,
    toolName: string,
    args: Record<string, unknown>,
    resultStr: string,
    isError: boolean,
    durationMs?: number,
  ) {
    toolUiMgr.populateToolEntryContent(
      entry,
      toolName,
      args,
      resultStr,
      isError,
      durationMs,
    );
  }

  function closeViewer(offKey: () => void) {
    offKey();
    for (const child of viewerOverlay.getChildren()) {
      child.destroy();
    }
    showMainTui();
    inputField.focus();
  }

  function finalizeToolGroup() {
    toolUiMgr.finalizeToolGroup();
  }

  function getOrCreateToolGroup(name: string) {
    return toolUiMgr.getOrCreateToolGroup(name);
  }

  function addToolGroupEntry(
    name: string,
    summary: string,
    args: Record<string, unknown>,
  ): ToolGroupEntry {
    return toolUiMgr.addToolGroupEntry(name, summary, args);
  }

  let currentThinkingBlock: BoxRenderable | null = null;

  function createThinkingBlock(): BoxRenderable {
    return messageRenderer.createThinkingBlock();
  }

  function finalizeThinkingBlock() {
    if (currentThinkingBlock) {
      const kept = messageRenderer.finalizeThinkingBlock(
        currentThinkingBlock,
        currentThinkingText,
      );
      if (!kept) {
        currentThinkingBlock = null;
      }
    }
    currentThinkingText = '';
    streamingThinking = false;
  }

  let currentAssistantMd: MarkdownRenderable | null = null;

  function finalizeAssistantStream() {
    if (currentAssistantMd) {
      currentAssistantMd.streaming = false;
      currentAssistantMd = null;
    }
  }

  let currentThinkingText = '';
  let streamingThinking = false;
  let streamedAnyText = false;
  const pendingToolEntries = new Map<string, number>();
  let currentAssistantText = '';
  let accThinking = '';
  let accToolCalls: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
    durationMs?: number;
  }[] = [];
  let accCurrentTool: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  } | null = null;
  let streamingBashEntry: ToolGroupEntry | null = null;

  function handleEvent(event: RuntimeEvent) {
    switch (event.type) {
      case 'text_delta': {
        const delta = event.text ?? event.delta ?? '';

        if (streamingThinking && currentThinkingBlock) {
          finalizeThinkingBlock();
        }

        if (!currentAssistantMd) {
          hideLavaLamp();
          currentAssistantMd = new MarkdownRenderable(renderer, {
            conceal: true,
            content: '',
            id: nextId(),
            streaming: true,
            syntaxStyle,
            width: '100%',
          });
          messagesScroll.add(currentAssistantMd);
        }

        currentAssistantMd.content += delta;
        streamedAnyText = true;
        break;
      }

      case 'thinking_delta': {
        finalizeAssistantStream();
        const delta = event.delta ?? event.content ?? '';
        const noisyFlueLog =
          /\[flue:|submission-processing|FlueError|throwIfError|normalizeLogAttributes|OperationFailedError|operation_failed|CallOverrides|persisted-image|direct\([^)]*\) failed:/.test(
            delta,
          ) ||
          /^\}\s*\d+\s*\|/m.test(delta) ||
          /^\d+\s*\|/m.test(delta);
        if (noisyFlueLog) {
          break;
        }
        if (!streamingThinking) {
          streamingThinking = true;
          hideLavaLamp();
          const children = messagesScroll.getChildren();
          const last = children.at(-1);
          if (last && last instanceof BoxRenderable) {
            const hasThinking = last.getRenderable('thinking-content');
            if (hasThinking) {
              currentThinkingBlock = last;
              currentThinkingText = '';
              const contentEl =
                currentThinkingBlock.getRenderable('thinking-content');
              if (contentEl && contentEl instanceof TextRenderable) {
                contentEl.visible = true;
              }
              const hdr = currentThinkingBlock
                .getChildren()
                .find((c) => c instanceof BoxRenderable);
              if (hdr) {
                const label = hdr
                  .getChildren()
                  .find((c) => c instanceof TextRenderable);
                if (label && label instanceof TextRenderable) {
                  label.content = 'Reasoning... \u25BC';
                  label.fg = COLORS.link;
                }
              }
            } else {
              currentThinkingBlock = createThinkingBlock();
              messagesScroll.add(currentThinkingBlock);
              currentThinkingText = '';
            }
          } else {
            currentThinkingBlock = createThinkingBlock();
            messagesScroll.add(currentThinkingBlock);
            currentThinkingText = '';
          }
        }
        currentThinkingText += delta;
        accThinking += delta;
        if (currentThinkingBlock) {
          const contentEl =
            currentThinkingBlock.getRenderable('thinking-content');
          if (contentEl && contentEl instanceof TextRenderable) {
            contentEl.content = currentThinkingText;
          }
        }
        break;
      }

      case 'tool_start': {
        finalizeAssistantStream();
        if (streamingThinking && currentThinkingBlock) {
          finalizeThinkingBlock();
        }
        const name = event.toolName ?? 'unknown';
        const args = event.args ?? {};
        analytics.toolStarted(
          activeAnalyticsTurn,
          event.toolCallId,
          name,
          args,
        );

        createMutationBackup(name, args);

        if (
          name === 'create_task' ||
          name === 'complete_task' ||
          name === 'start_task' ||
          name === 'edit_task' ||
          name === 'delete_task' ||
          name === 'skip_task'
        ) {
          const action = name.replace('_task', '');
          handleTaskToolStart({ ...args, action });
        }

        const summary = summarizeToolArgs(name, args, cwd);

        addToolGroupEntry(name, summary, args);

        state.currentTool = { args, id: `tool-${Date.now()}`, name };
        const grp = toolUiMgr.getActiveGroup();
        if (typeof event.toolCallId === 'string' && grp !== null) {
          pendingToolEntries.set(event.toolCallId, grp.entries.length - 1);
          accCurrentTool = { args, id: event.toolCallId, name };
          if (name === 'bash' && grp.entries.length > 0) {
            streamingBashEntry = grp.entries[grp.entries.length - 1] ?? null;
          }
        }
        updateTaskStatus(name, args);
        requestScroll();
        break;
      }

      case 'tool': {
        analytics.toolFinished(
          activeAnalyticsTurn,
          event.toolCallId,
          event.toolName ?? 'unknown',
          event.durationMs,
          Boolean(event.isError),
        );
        if (event.toolName === 'deploy_parallel_subs') {
          const marker =
            typeof event.result === 'string'
              ? (() => {
                  try {
                    return JSON.parse(event.result) as unknown;
                  } catch {
                    return null;
                  }
                })()
              : event.result;
          if (marker !== null && typeof marker === 'object') {
            const deployMarker = marker as { type: string; queries: string[] };
            if (
              deployMarker.type === 'parallel_deploy' &&
              Array.isArray(deployMarker.queries)
            ) {
              subManager
                .deploy(deployMarker.queries)
                .catch((error: unknown) =>
                  addInfoLine(
                    `  subagents failed: ${error instanceof Error ? error.message : String(error)}`,
                    COLORS.red,
                  ),
                );
            }
          }
        }
        const activeGrp = toolUiMgr.getActiveGroup();
        if (
          activeGrp !== null &&
          typeof event.toolCallId === 'string' &&
          pendingToolEntries.has(event.toolCallId)
        ) {
          const idx = pendingToolEntries.get(event.toolCallId) ?? -1;
          if (idx < 0) {
            break;
          }
          const entry = activeGrp.entries[idx];
          if (entry !== undefined) {
            const resultStr = extractResultText(event.result);
            entry.result = resultStr;
            entry.isError = Boolean(event.isError);
            entry.durationMs = event.durationMs;
            populateToolEntryContent(
              entry,
              entry.toolName,
              entry.args,
              resultStr,
              Boolean(event.isError),
              event.durationMs,
            );
          }
          if (accCurrentTool && accCurrentTool.id === event.toolCallId) {
            accToolCalls.push({
              args: accCurrentTool.args,
              durationMs: event.durationMs,
              id: accCurrentTool.id,
              isError: Boolean(event.isError),
              name: accCurrentTool.name,
              result: event.result,
            });
            accCurrentTool = null;
          }
        }
        if (streamingBashEntry !== null) {
          streamingBashEntry = null;
        }
        state.currentTool = null;
        clearTaskStatus();
        requestScroll();
        break;
      }

      case 'compaction_start': {
        analytics.event('compaction', 'started', activeAnalyticsTurn);
        addInfoLine('  compacting context...', COLORS.dim);
        requestScroll();
        break;
      }
      case 'compaction': {
        addInfoLine(
          `  compacted: ${event.messagesBefore} -> ${event.messagesAfter} messages`,
          COLORS.dim,
        );
        requestScroll();
        break;
      }
      case 'log': {
        break;
      }
      case 'error': {
        const errMsg = event.error ?? event.message ?? 'unknown';
        const cleanMsg =
          typeof errMsg === 'string'
            ? errMsg.replaceAll(/\s+/g, ' ').slice(0, 200)
            : 'unknown error';
        showResultPanel('error', [
          { content: `  ${cleanMsg}`, fg: COLORS.red },
        ]);
        break;
      }
      default: {
        // unhandled event types are silently ignored
        break;
      }
    }
  }

  function finalizeStream() {
    stopSpinner();
    finalizeToolGroup();
    if (currentThinkingBlock && currentThinkingText) {
      const contentEl = currentThinkingBlock.getRenderable('thinking-content');
      if (contentEl && contentEl instanceof TextRenderable) {
        contentEl.content = currentThinkingText;
        contentEl.visible = false;
      }
      const hdr = currentThinkingBlock
        .getChildren()
        .find((c) => c instanceof BoxRenderable);
      if (hdr) {
        const label = hdr
          .getChildren()
          .find((c) => c instanceof TextRenderable);
        if (label && label instanceof TextRenderable) {
          label.content = '\u25B8 Reasoning...';
          label.fg = COLORS.link;
        }
      }
    }
    currentThinkingBlock = null;
    currentThinkingText = '';
    streamingThinking = false;

    clearTaskStatus();

    finalizeAssistantStream();
    state.currentTool = null;
    pendingToolEntries.clear();
    streamedAnyText = false;
    requestScroll();
  }

  function clearResponseAccumulators() {
    currentAssistantText = '';
    accThinking = '';
    accToolCalls = [];
    accCurrentTool = null;
  }

  function formatErrorMessage(err: Error): string {
    if (isAuthError(err)) {
      return 'authentication failed (401). Run /login to re-authenticate.';
    }
    return formatTuiError(err);
  }

  function printUsage(result: RuntimeResult) {
    const u = result.usage;
    if (u == null) {
      return;
    }
    state.usageTotals.input += u.input;
    state.usageTotals.output += u.output;
    state.usageTotals.cacheRead += u.cacheRead;
    state.usageTotals.cacheWrite += u.cacheWrite;
    state.usageTotals.totalTokens += u.totalTokens;
    state.usageTotals.cost += u.cost?.total ?? 0;
    const m =
      result.model != null ? `${result.model.provider}/${result.model.id}` : '';
    const config = resolveConfig();
    const label = config.usageDisplayMode === 'neurons' ? 'neurons' : 'usage';
    const turnCost = u.cost === null ? '' : ` (${formatCost(u.cost.total)})`;
    const sessionCost = u.cost === null ? '' : ` (${formatCost(state.usageTotals.cost)})`;
    addInfoLine(
      `  ${label}: ${formatTokenCount(u.totalTokens)} tok${turnCost} | session ${formatTokenCount(state.usageTotals.totalTokens)} tok${sessionCost} | ${m}`,
      COLORS.dim,
    );
  }

  function createMutationBackup(
    name: string,
    args: Record<string, unknown>,
  ): void {
    const plan = planMutationBackup(name, args);
    if (plan === null) {
      return;
    }

    try {
      if (turnBackupId === null) {
        turnBackupId = backupEngine.createBackup(plan.paths);
        backupHistory.push(turnBackupId);
      } else {
        backupEngine.extendBackup(turnBackupId, plan.paths);
      }
    } catch {}
  }

  async function _sendPrompt(prompt: string) {
    activeAnalyticsTurn = analytics.startTurn();
    activeStopReason = undefined;
    state.processing = true;
    turnBackupId = null;
    state.historyIndex = -1;
    prompt = activeBackend === 'codex'
      ? visiblePrompt(prompt)
      : withModeTag(visiblePrompt(prompt));
    state.commandHistory.push(visiblePrompt(prompt));
    hideResultPanel();
    hideConfirm(false);
    startSpinner();

    hideLavaLamp();
    addUserLine(visiblePrompt(prompt));
    state.messages.push({
      content: visiblePrompt(prompt),
      id: nextId(),
      role: 'user',
      timestamp: Date.now(),
    });
    updateStatus();

    clearResponseAccumulators();

    let imageDescriptionContext = '';
    const promptImages: PromptImage[] = [];
    const promptAttachments = attachmentsForPrompt(prompt, attachedImages);
    attachedImages.length = 0;
    if (promptAttachments.length > 0) {
      const modelId = currentModelId();
      const modelEntry = getModelEntry(modelId);
      const modelHasVision = activeBackend === 'codex' || (modelEntry?.vision ?? false);

      for (const img of promptAttachments) {
        if (modelHasVision) {
          // Vision-capable model: pass the image directly as a PromptImage
          try {
            const buffer = activeBackend === 'codex'
              ? null
              : fs.readFileSync(img.path);
            promptImages.push({
              data: buffer?.toString('base64') ?? '',
              mimeType: 'image/png',
              path: img.path,
              type: 'image',
            });
            addInfoLine(
              `  [vision] Attached image ${img.tag} → ${modelId}`,
              COLORS.dim,
            );
          } catch {
            if (activeBackend === 'codex') {
              addInfoLine(`  [vision] Could not attach ${img.path}`, COLORS.yellow);
              continue;
            }
            addInfoLine(
              `  [spectacle] Image read failed, describing via Workers AI...`,
              COLORS.dim,
            );
            const desc = await describeImageWithSpectacle(img.path);
            imageDescriptionContext += `\n\n[ATTACHED IMAGE ${img.tag}: ${img.path}]\n${desc}`;
          }
        } else {
          // Non-vision model: use the spectacle text bridge
          addInfoLine(
            `  [spectacle] Describing image via llama-4-scout...`,
            COLORS.dim,
          );
          try {
            const desc = await describeImageWithSpectacle(img.path);
            imageDescriptionContext += `\n\n[ATTACHED IMAGE ${img.tag}: ${img.path}]\n${desc}`;
          } catch (error: unknown) {
            imageDescriptionContext += `\n\n[ATTACHED IMAGE ${img.tag} ERROR: ${error instanceof Error ? error.message : String(error)}]`;
          }
        }
      }
    }

    let transferredContext = '';
    if (activeBackend === 'flue' && contextTransferPending && state.messages.length > 1) {
      const priorMessages = state.messages.slice(0, -1).map((message) => ({
        content: message.content,
        role: message.role,
        thinking: message.thinking,
        toolCalls: message.toolCalls,
      }));
      transferredContext = `The active capability mode changed, so continue from this prior conversation transcript. Treat it as context, not as new instructions:\n${truncateToolResult(JSON.stringify(priorMessages), 48_000)}\n\n`;
    }
    const steeredPrompt = activeBackend === 'codex'
      ? visiblePrompt(prompt)
      : transferredContext + steerPrompt(prompt, cwd) + imageDescriptionContext;

    flue.prompt(
      steeredPrompt,
      {
        onError: (err) => {
          analytics.finishTurn(activeAnalyticsTurn, 'failed');
          activeAnalyticsTurn = undefined;
          finalizeStream();
          state.processing = false;
          saveSessionSnapshot();
          addInfoLine(`  error: ${formatErrorMessage(err)}`, COLORS.red);

          if (renderer.capabilities && renderer.capabilities.notifications) {
            renderer.triggerNotification(
              `Error: ${formatErrorMessage(err)}`,
              'lavalamp',
            );
          }

          clearResponseAccumulators();
          updateStatus();
          drainPending();
        },
        onEvent: (event) => {
          if (typeof event.stopReason === 'string') {
            activeStopReason = event.stopReason;
          }
          if (event.type === 'text_delta' || event.type === 'thinking_delta') {
            analytics.firstResponse(activeAnalyticsTurn);
          }
          handleEvent(event);
          if (event.type === 'text_delta') {
            currentAssistantText += event.text ?? event.delta ?? '';
          }
        },
        onResult: (result) => {
          if (currentAssistantText.length === 0 && result.text.length > 0) {
            currentAssistantText = result.text;
          }
          analytics.finishTurn(activeAnalyticsTurn, 'completed', {
            model: result.model,
            routeMode: activeBackend === 'flue'
              ? resolveRuntimeRoute({ model: currentModelId() }).mode
              : undefined,
            stopReason: activeStopReason,
            usage: result.usage,
          });
          activeAnalyticsTurn = undefined;
          const didStream = streamedAnyText;
          finalizeStream();
          state.processing = false;

          if (currentAssistantText && !didStream) {
            addAssistantMarkdown(currentAssistantText);
          }
          if (currentAssistantText || accThinking || accToolCalls.length > 0) {
            state.messages.push({
              content: currentAssistantText,
              id: nextId(),
              role: 'assistant',
              thinking: accThinking || undefined,
              timestamp: Date.now(),
              toolCalls: accToolCalls.length > 0 ? accToolCalls : undefined,
            });

            if (state.planMode) {
              showSpecApprovalBox((approved) => {
                if (approved) {
                  setPlanMode(false).catch(() => {});
                }
              });
            }

            const filePaths = extractFilePaths(currentAssistantText, cwd);
            if (filePaths.length > 0) {
              const fileRow = new BoxRenderable(renderer, {
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 1,
                id: nextId(),
                width: '100%',
              });
              for (const fp of filePaths.slice(0, 8)) {
                const displayPath = stripCwd(fp, cwd);
                const linkBox = new BoxRenderable(renderer, {
                  focusable: true,
                  height: 1,
                  id: nextId(),
                  onMouseDown: () => {
                    const storedDiff = storedDiffs.get(displayPath);
                    const viewerCtx = {
                      closeViewer,
                      cwd,
                      hideMainTui,
                      nextId,
                      onReadError: (fp: string) =>
                        addInfoLine(`  could not read ${fp}`, COLORS.red),
                      overlay: viewerOverlay,
                      renderer,
                    };
                    if (storedDiff) {
                      openDiffViewer(viewerCtx, fp, storedDiff.diff);
                    } else {
                      openCodeViewer(viewerCtx, fp);
                    }
                  },
                  width: displayPath.length,
                });
                const linkText = new TextRenderable(renderer, {
                  attributes: TextAttributes.UNDERLINE,
                  content: displayPath,
                  fg: COLORS.link,
                  id: nextId(),
                });
                linkBox.add(linkText);
                fileRow.add(linkBox);
              }
              messagesScroll.add(fileRow);
            }
          }

          if (renderer.capabilities && renderer.capabilities.notifications) {
            renderer.triggerNotification('Response complete', 'lavalamp');
          }

          printUsage(result);
          clearResponseAccumulators();
          updateStatus();
          drainPending();
        },
      },
      currentSessionId,
      promptImages.length > 0 ? promptImages : undefined,
    );
    contextTransferPending = false;
  }

  function drainPending() {
    if (state.processing) {
      return;
    }

    let prompt: string | undefined;
    if (state.steerPending.length > 0) {
      prompt = state.steerPending.shift();
      addInfoLine('  (steer)', COLORS.dim);
    } else if (state.queuePending.length > 0) {
      prompt = state.queuePending.shift();
      addInfoLine('  (queued)', COLORS.yellow);
    }

    refreshQueuePanel();
    if (prompt === undefined) {
      return;
    }

    _sendPrompt(prompt).catch((error: unknown) => {
      state.processing = false;
      addInfoLine(
        `  queued prompt failed: ${error instanceof Error ? error.message : String(error)}`,
        COLORS.red,
      );
      drainPending();
    });
  }

  function handleInterrupt() {
    analytics.finishTurn(activeAnalyticsTurn, 'interrupted');
    analytics.event('interruption', 'user', activeAnalyticsTurn);
    activeAnalyticsTurn = undefined;
    if (activeBackend === 'codex') {
      void (async () => {
        try {
          await flue.interrupt?.();
          const deadline = Date.now() + 2000;
          while (flue.isProcessing && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (flue.isProcessing) {
            await flue.restart();
          }
        } catch {
          await flue.restart().catch(() => {});
        }
      })();
    } else {
      flue.cancel();
      flue.restart().catch(() => {});
    }
    state.processing = false;
    stopSpinner();
    state.steerPending = [];
    state.queuePending = [];
    refreshQueuePanel();
    state.historyIndex = -1;
    inputField.setText('');
    if (currentAssistantMd) {
      messagesScroll.remove(currentAssistantMd.id);
      currentAssistantMd.destroy();
      currentAssistantMd = null;
    }
    if (currentThinkingBlock) {
      messagesScroll.remove(currentThinkingBlock.id);
      currentThinkingBlock.destroy();
      currentThinkingBlock = null;
      currentThinkingText = '';
      streamingThinking = false;
    }
    const grp = toolUiMgr.getActiveGroup();
    if (grp !== null) {
      messagesScroll.remove(grp.box.id);
      grp.box.destroy();
      toolUiMgr.clearActiveGroup();
    }
    pendingToolEntries.clear();
    streamedAnyText = false;
    saveSessionSnapshot();
    clearResponseAccumulators();
    clearTaskStatus();
    addInfoLine('  interrupted', COLORS.yellow);
    updateStatus();
  }

  let exiting = false;
  let exitSummaryPrinted = false;
  let savedSessionOnExit: string | null = null;

  function saveSessionSnapshot(): string | null {
    if (state.processing) {
      if (currentAssistantText || accThinking || accToolCalls.length > 0) {
        state.messages.push({
          content: currentAssistantText,
          id: nextId(),
          role: 'assistant',
          thinking: accThinking || undefined,
          timestamp: Date.now(),
          toolCalls: accToolCalls.length > 0 ? accToolCalls : undefined,
        });
      }
      clearResponseAccumulators();
    }
    if (state.messages.length > 0) {
      const sessionName = nameSession(state.messages);
      savedSessionOnExit = activeBackend === 'codex'
        ? flue.codexThreadId === undefined
          ? null
          : saveCodexSession({
            version: 2,
            id: currentSessionId,
            backend: 'codex',
            codexThreadId: flue.codexThreadId,
            cwd,
            mode: state.planMode ? 'plan' : baseAgentName === 'explore' ? 'ask' : 'build',
            name: sessionName,
            savedAt: Date.now(),
          })
        : saveSession(state.messages, sessionName, currentSessionId);
      if (savedSessionOnExit !== null) {
        currentSessionId = savedSessionOnExit;
      }
    }
    return savedSessionOnExit;
  }

  function handleExit() {
    if (exiting) {
      return;
    }
    exiting = true;
    if (state.processing) {
      analytics.finishTurn(activeAnalyticsTurn, 'interrupted');
      analytics.event('interruption', 'exit', activeAnalyticsTurn);
      activeAnalyticsTurn = undefined;
    }
    analytics.finish(state.processing ? 'interrupted' : 'completed');

    const savedSessionId = saveSessionSnapshot();
    stopSpinner();
    clearInterval(lavaLampTimer);
    renderer.destroy();
    if (savedSessionId !== null && !exitSummaryPrinted) {
      exitSummaryPrinted = true;
      process.stdout.write(formatExitSummary(savedSessionId));
    }
  }

  function togglePlanMode() {
    setPlanMode(!state.planMode).catch(() => {});
  }

  let sessionPickerActive = false;
  let sessionPickerSelected = 0;
  let sessionPickerSessions: {
    backend: AgentBackend;
    id: string;
    name: string;
    savedAt: number;
    messageCount: number;
  }[] = [];
  function showSessionPicker(
    sessions: {
      backend: AgentBackend;
      id: string;
      name: string;
      savedAt: number;
      messageCount: number;
    }[],
  ) {
    sessionPickerSessions = sessions;
    sessionPickerSelected = 0;
    sessionPickerActive = true;

    renderPicker();
  }

  async function resumeSession(index: number) {
    const chosen = sessionPickerSessions[index];
    if (!chosen) {
      return;
    }
    closeSessionPicker();
    const codexRecord = chosen.backend === 'codex'
      ? loadCodexSession(chosen.id)
      : null;
    if (chosen.backend !== activeBackend) {
      saveSessionSnapshot();
      await flue.shutdown();
      const config = resolveConfig();
      const previousBackend = activeBackend;
      const nextRuntime = createRuntimeProcess({
        agentName: codexRecord?.mode === 'plan'
          ? 'plan'
          : codexRecord?.mode === 'ask'
            ? 'explore'
            : state.planMode ? 'plan' : baseAgentName,
        allowModelFallback: chosen.backend === 'codex',
        backend: chosen.backend,
        cwd,
        model: chosen.backend === 'codex'
          ? config.codexModel || undefined
          : config.defaultModel || undefined,
        serverPath: options.serverPath,
        sessionId: chosen.id,
      });
      try {
        await nextRuntime.start();
        flue = nextRuntime;
        activeBackend = chosen.backend;
        wireRuntime();
      } catch (error) {
        flue = createRuntimeProcess({
          agentName: state.planMode ? 'plan' : baseAgentName,
          backend: previousBackend,
          cwd,
          model: state.model,
          serverPath: options.serverPath,
          sessionId: currentSessionId,
        });
        await flue.start();
        wireRuntime();
        addInfoLine(`  could not switch backend: ${(error as Error).message}`, COLORS.red);
        return;
      }
    }
    if (chosen.backend === 'codex' && flue.resumeThread !== undefined) {
      if (codexRecord !== null) {
        try {
          flue.setAgentName(
            codexRecord.mode === 'plan'
              ? 'plan'
              : codexRecord.mode === 'ask' ? 'explore' : 'build',
          );
          const thread = await flue.resumeThread(codexRecord.codexThreadId);
          currentSessionId = chosen.id;
          state.messages = reconstructCodexMessages(thread);
          state.planMode = codexRecord.mode === 'plan';
          contextTransferPending = false;
          savedSessionOnExit = null;
          renderAllMessages();
        } catch (error) {
          addInfoLine(
            `  Codex thread could not be resumed; local mapping was preserved: ${(error as Error).message}`,
            COLORS.red,
          );
        }
      }
      return;
    }
    const messages = loadSession(chosen.id);
    if (messages !== null) {
      analytics.finish('completed');
      analytics.close();
      currentSessionId = chosen.id;
      analytics = AnalyticsRecorder.create({
        agent: baseAgentName,
        conversationSessionId: currentSessionId,
        mode: 'tui',
        workspaceRoot: cwd,
      });
      subManager.setAnalytics(analytics, () => activeAnalyticsTurn);
      state.messages = messages;
      const usage = analytics.conversationUsage(currentSessionId);
      if (usage !== null) {
        Object.assign(state.usageTotals, {
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          cost: usage.costTotal,
          input: usage.input,
          output: usage.output,
          totalTokens: usage.totalTokens,
        });
      }
      contextTransferPending = true;
      savedSessionOnExit = null;

      renderAllMessages();
    }
  }

  function closeSessionPicker() {
    sessionPickerActive = false;
    hideResultPanel();
  }

  function renderPicker() {
    const rows: { content: string; fg?: string; bold?: boolean }[] = [];
    for (let i = 0; i < sessionPickerSessions.length; i++) {
      const s = sessionPickerSessions[i];
      if (s === undefined) {
        continue;
      }
      const age = formatAge(s.savedAt);
      const marker = i === sessionPickerSelected ? '\u25B6 ' : '  ';
      const nameStr = s.name.slice(0, 36);
      rows.push({
        bold: i === sessionPickerSelected,
        content: `${marker}[${s.backend}] ${nameStr}  ${s.messageCount} msgs  ${age}`,
        fg: i === sessionPickerSelected ? COLORS.white : COLORS.gray,
      });
    }
    showResultPanel('/sessions', rows);
  }

  let modelPickerActive = false;
  let modelPickerState: ModelPickerState | null = null;

  function currentModelId(): string {
    const config = resolveConfig();
    return (
      state.model ??
      (activeBackend === 'codex'
        ? config.codexModel || 'server default'
        : config.defaultModel.length > 0 ? config.defaultModel : BUILD_MODEL)
    );
  }

  async function setModel(modelId: string): Promise<boolean> {
    if (activeBackend === 'codex') {
      try {
        await flue.setModel?.(modelId);
        updateConfig({ codexModel: modelId });
        state.model = modelId;
        showResultPanel('/model', [
          { content: `  Codex model set: ${modelId}`, fg: COLORS.green },
        ]);
        updateStatus();
        return true;
      } catch (error) {
        showResultPanel('/model', [
          { content: `  ${(error as Error).message}`, fg: COLORS.yellow },
        ]);
        return false;
      }
    }
    const model = getModelEntry(modelId);
    if (model === undefined) {
      showResultPanel('/model', [
        { content: `  unknown model: ${modelId}`, fg: COLORS.yellow },
        { content: '  run /model to list known models', fg: COLORS.dim },
      ]);
      return false;
    }
    if (state.processing) {
      showResultPanel('/model', [
        {
          content: '  cannot change model while a prompt is running',
          fg: COLORS.yellow,
        },
      ]);
      return false;
    }
    updateConfig({ defaultModel: modelId });
    process.env.LAVALAMP_MODEL = modelId;
    state.model = modelId;
    await flue.restart();
    showResultPanel('/model', [
      { content: `  model set: ${modelId}`, fg: COLORS.green },
    ]);
    updateStatus();
    return true;
  }

  function showModelPicker(models?: ModelPickerEntry[]) {
    modelPickerState = createModelPickerState(currentModelId(), models);
    modelPickerActive = true;
    renderModelPicker();
  }

  function closeModelPicker() {
    modelPickerActive = false;
    modelPickerState = null;
    hideResultPanel();
  }

  function renderModelPicker() {
    const picker = modelPickerState;
    if (picker === null) {
      return;
    }
    const config = resolveConfig();
    const current = currentModelId();
    const rows: { content: string; fg?: string; bold?: boolean }[] = [
      { bold: true, content: `  model: ${current}`, fg: COLORS.white },
      {
        content: `  config: ${configPath()}`,
        fg: COLORS.dim,
      },
    ];
    if (activeBackend === 'flue') {
      const route = resolveRuntimeRoute({
        config,
        env: process.env as Record<string, string | undefined>,
        model: current,
      });
      const currentEntry = route.registryEntry;
      rows.push({
        content: `  route: ${routeSummary(route)}`,
        fg: COLORS.gray,
      });
      if (currentEntry !== undefined) {
        rows.push({
          content: `  ${currentEntry.displayName} · ${Math.round(currentEntry.contextWindow / 1000)}k ctx · ${currentEntry.functionCalling ? 'tools' : 'no tools'} · ${currentEntry.vision ? 'vision' : 'text'}`,
          fg: COLORS.gray,
        });
      }
    } else {
      rows.push({
        content: '  backend: Codex app-server',
        fg: COLORS.gray,
      });
    }
    rows.push(
      { content: '' },
      {
        bold: true,
        content: '  available models:',
        fg: COLORS.white,
      },
    );
    for (let i = 0; i < picker.models.length; i++) {
      const model = picker.models[i];
      if (model === undefined) {
        continue;
      }
      const selected = i === picker.selectedIndex;
      const isCurrent = model.id === current;
      const marker = selected ? '\u25B6 ' : '  ';
      const currentTag = isCurrent ? ' current' : '';
      if (activeBackend === 'codex') {
        const defaultTag = model.isDefault ? ' default' : '';
        const efforts = model.supportedReasoningEfforts?.join(', ') ||
          'server reasoning default';
        rows.push({
          bold: selected,
          content: `  ${marker}${model.id} — ${efforts}${defaultTag}${currentTag}`,
          fg: selected ? accent() : isCurrent ? COLORS.white : COLORS.gray,
        });
        continue;
      }
      const registryModel = getModelEntry(model.id);
      rows.push({
        bold: selected,
        content: `  ${marker}${model.id}  ${registryModel?.vision ? 'vision' : 'text'} ${registryModel?.gatewaySupport ? 'gateway' : 'direct'}${currentTag}`,
        fg: selected ? accent() : isCurrent ? COLORS.white : COLORS.gray,
      });
    }
    showResultPanel('/model', rows);
  }

  async function selectModelFromPicker() {
    const picker = modelPickerState;
    if (picker === null) {
      return;
    }
    const modelId = selectedModelId(picker);
    if (modelId === undefined) {
      return;
    }
    const changed = await setModel(modelId);
    if (changed) {
      modelPickerActive = false;
      modelPickerState = null;
    }
  }

  function renderAllMessages() {
    for (const child of messagesScroll.getChildren()) {
      if (child.id !== 'lava-lamp-box') {
        child.destroy();
      }
    }
    if (state.messages.length > 0) {
      lavaLampBox.visible = false;
    }
    for (const msg of state.messages) {
      renderMessage(msg);
    }
    requestScroll();
  }

  function renderMessage(msg: Message) {
    if (msg.role === 'user') {
      addUserLine(msg.content);
      return;
    }

    addInfoLine(` ~`, accent());

    if (msg.thinking !== undefined && msg.thinking !== '') {
      const thinkBox = createThinkingBlock();
      const contentEl = thinkBox.getRenderable('thinking-content');
      if (contentEl instanceof TextRenderable) {
        contentEl.content = msg.thinking;
        contentEl.visible = false;
      }
      const hdr = thinkBox
        .getChildren()
        .find((c) => c instanceof BoxRenderable);
      if (hdr instanceof BoxRenderable) {
        const label = hdr
          .getChildren()
          .find((c) => c instanceof TextRenderable);
        if (label instanceof TextRenderable) {
          label.content = 'Reasoning... \u25B8';
          label.fg = COLORS.link;
        }
      }
      messagesScroll.add(thinkBox);
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      let grp: ReturnType<typeof getOrCreateToolGroup> | null = null;
      for (const tc of msg.toolCalls) {
        grp = getOrCreateToolGroup(tc.name);
        const summary = summarizeToolArgs(tc.name, tc.args, cwd);
        const entry = addToolGroupEntry(tc.name, summary, tc.args);
        entry.result = extractResultText(tc.result);
        entry.isError = Boolean(tc.isError);
        entry.durationMs = tc.durationMs;
        populateToolEntryContent(
          entry,
          tc.name,
          tc.args,
          entry.result,
          Boolean(tc.isError),
          tc.durationMs,
        );
      }
      if (grp) {
        finalizeToolGroup();
      }
    }

    if (msg.content) {
      const md = new MarkdownRenderable(renderer, {
        content: msg.content,
        fg: COLORS.white,
        id: nextId(),
        paddingLeft: 1,
        syntaxStyle,
        width: '100%',
      });
      md.selectable = true;
      messagesScroll.add(md);
    }
  }

  async function handleSlashCommand(raw: string) {
    const cmd = raw.split(/\s+/)[0]?.toLowerCase() ?? '';
    const arg = raw.slice(cmd.length).trim();
    switch (cmd) {
      case '/help': {
        const rows: { content: string; fg?: string; bold?: boolean }[] = [
          { bold: true, content: '  Commands:', fg: COLORS.white },
        ];
        for (const [name, desc] of HELP_COMMANDS) {
          rows.push({
            bold: true,
            content: `  ${name.padEnd(14)}${desc}`,
            fg: accent(),
          });
        }
        rows.push(
          { content: '' },
          { bold: true, content: '  Keys:', fg: COLORS.white },
        );
        for (const [key, desc] of HELP_KEYS) {
          rows.push({ content: `  ${key.padEnd(14)}${desc}`, fg: COLORS.gray });
        }
        showResultPanel('/help', rows);
        break;
      }
      case '/clear': {
        if (state.messages.length > 0) {
          saveSessionSnapshot();
        }
        for (const child of messagesScroll.getChildren()) {
          if (child.id !== 'lava-lamp-box') {
            child.destroy();
          }
        }
        lavaLampBox.visible = true;
        state.messages = [];
        currentSessionId = `session_${Date.now()}`;
        flue.clearThread?.();
        subManager.killAll();
        analytics.finish('completed');
        analytics.close();
        analytics = AnalyticsRecorder.create({
          agent: baseAgentName,
          conversationSessionId: currentSessionId,
          mode: 'tui',
          workspaceRoot: cwd,
        });
        subManager.setAnalytics(analytics, () => activeAnalyticsTurn);
        Object.assign(state.usageTotals, {
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          input: 0,
          output: 0,
          totalTokens: 0,
        });
        hideResultPanel();
        break;
      }
      case '/sessions': {
        const sessions = listSessions();
        if (sessions.length === 0) {
          showResultPanel('/sessions', [
            { content: '  no saved sessions', fg: COLORS.dim },
          ]);
          break;
        }
        showSessionPicker(sessions);
        break;
      }
      case '/compact': {
        const count = state.messages.length;
        if (count === 0) {
          showResultPanel('/compact', [
            { content: '  nothing to compact', fg: COLORS.dim },
          ]);
          break;
        }
        if (activeBackend === 'codex') {
          await flue.compact?.();
          showResultPanel('/compact', [
            { content: '  native Codex compaction started', fg: COLORS.green },
          ]);
          break;
        }
        const half = Math.ceil(count / 2);
        const kept = state.messages.slice(half);
        state.messages = kept;
        for (const child of messagesScroll.getChildren()) {
          if (child.id !== 'lava-lamp-box') {
            child.destroy();
          }
        }
        if (state.messages.length > 0) {
          lavaLampBox.visible = false;
          for (const msg of state.messages) {
            renderMessage(msg);
          }
        } else {
          lavaLampBox.visible = true;
        }
        showResultPanel('/compact', [
          {
            content: `  compacted: kept last ${kept.length} of ${count} messages`,
            fg: COLORS.green,
          },
        ]);
        break;
      }
      case '/memory': {
        const memPath = path.join(cwd, 'AGENTS.md');
        const rows: { content: string; fg?: string; bold?: boolean }[] = [];
        try {
          const content = fs.readFileSync(memPath, 'utf8');
          const lines = content.split('\n');
          rows.push({ bold: true, content: '  AGENTS.md:', fg: COLORS.white });
          for (const line of lines.slice(0, 30)) {
            rows.push({ content: `  ${line}`, fg: COLORS.gray });
          }
          if (lines.length > 30) {
            rows.push({
              content: `  ... (${lines.length - 30} more lines)`,
              fg: COLORS.dim,
            });
          }
        } catch {
          rows.push({ content: '  no AGENTS.md found', fg: COLORS.dim });
        }
        showResultPanel('/memory', rows);
        break;
      }
      case '/model':
      case '/models': {
        if (arg.length > 0) {
          await setModel(arg);
          break;
        }
        const models = await loadModelPickerModels(activeBackend, async () =>
          await flue.listModels?.() ?? [],
        );
        showModelPicker(models);
        break;
      }
      case '/backend': {
        if (arg.length === 0) {
          showResultPanel('/backend', [
            { content: `  backend: ${activeBackend}`, fg: COLORS.white },
            { content: '  usage: /backend flue|codex', fg: COLORS.dim },
          ]);
          break;
        }
        if (state.processing) {
          showResultPanel('/backend', [
            { content: '  cannot change backend while a prompt is running', fg: COLORS.yellow },
          ]);
          break;
        }
        let nextBackend: AgentBackend;
        try {
          nextBackend = parseBackend(arg) ?? activeBackend;
        } catch (error) {
          showResultPanel('/backend', [
            { content: `  ${(error as Error).message}`, fg: COLORS.red },
          ]);
          break;
        }
        if (nextBackend === activeBackend) {
          showResultPanel('/backend', [
            { content: `  already using ${activeBackend}`, fg: COLORS.dim },
          ]);
          break;
        }
        saveSessionSnapshot();
        const previousBackend = activeBackend;
        await flue.shutdown();
        const config = resolveConfig();
        const nextModel = nextBackend === 'codex'
          ? config.codexModel || undefined
          : config.defaultModel || undefined;
        const nextRuntime = createRuntimeProcess({
          agentName: state.planMode ? 'plan' : baseAgentName,
          allowModelFallback: nextBackend === 'codex',
          backend: nextBackend,
          cwd,
          model: nextModel,
          serverPath: options.serverPath,
          sessionId: `session_${Date.now()}`,
        });
        try {
          await nextRuntime.start();
          flue = nextRuntime;
          activeBackend = nextBackend;
          wireRuntime();
          updateConfig({ backend: nextBackend });
          currentSessionId = `session_${Date.now()}`;
          savedSessionOnExit = null;
          state.messages = [];
          state.model = nextModel;
          renderAllMessages();
          showResultPanel('/backend', [
            { content: `  backend set to ${nextBackend}; started a clean session`, fg: COLORS.green },
          ]);
        } catch (error) {
          flue = createRuntimeProcess({
            agentName: state.planMode ? 'plan' : baseAgentName,
            backend: previousBackend,
            cwd,
            model: state.model,
            serverPath: options.serverPath,
            sessionId: currentSessionId,
          });
          await flue.start();
          wireRuntime();
          showResultPanel('/backend', [
            { content: `  backend switch failed: ${(error as Error).message}`, fg: COLORS.red },
          ]);
        }
        break;
      }
      case '/login': {
        try {
          await loginFromTui({
            backend: activeBackend,
            cloudflareLogin: () =>
              cloudflareLogin({ allowManualPrompt: false }),
            onProgress: (event) => {
              const rows: { content: string; fg?: string }[] = [
                {
                  content: `  ${event.message}`,
                  fg:
                    event.tone === 'success'
                      ? COLORS.green
                      : COLORS.yellow,
                },
              ];
              if (event.detail !== undefined) {
                rows.push({ content: `  ${event.detail}`, fg: COLORS.link });
              }
              showResultPanel('/login', rows);
            },
            openBrowser,
            runtime: flue,
          });
        } catch (error) {
          showResultPanel('/login', [
            {
              content: `  ${error instanceof Error ? error.message : String(error)}`,
              fg: COLORS.red,
            },
          ]);
        }
        break;
      }
      case '/gateway': {
        if (arg.length > 0) {
          if (state.processing) {
            showResultPanel('/gateway', [
              {
                content: '  cannot change Gateway while a prompt is running',
                fg: COLORS.yellow,
              },
            ]);
            break;
          }
          if (arg.toLowerCase() === 'off') {
            updateConfig({
              gatewayEnabled: false,
              preferredProviderRoute: 'direct',
            });
            await flue.restart();
            showResultPanel('/gateway', [
              { content: '  AI Gateway disabled', fg: COLORS.green },
            ]);
            break;
          }
          updateConfig({
            gatewayEnabled: true,
            gatewayId: arg,
            preferredProviderRoute: 'gateway',
          });
          await flue.restart();
          showResultPanel('/gateway', [
            { content: `  AI Gateway enabled: ${arg}`, fg: COLORS.green },
          ]);
          break;
        }

        const config = resolveConfig();
        const route = resolveRuntimeRoute({
          config,
          env: process.env as Record<string, string | undefined>,
          model: state.model,
          preferredModel: BUILD_MODEL,
        });
        showResultPanel('/gateway', [
          {
            bold: true,
            content: `  gateway: ${config.gatewayEnabled ? 'on' : 'off'}`,
            fg: config.gatewayEnabled ? COLORS.green : COLORS.gray,
          },
          {
            content: `  id: ${config.gatewayId || '(none)'}`,
            fg: COLORS.gray,
          },
          {
            content: `  route: ${routeSummary(route)}`,
            fg: COLORS.gray,
          },
          {
            content: '  use /gateway <id> to enable · /gateway off to disable',
            fg: COLORS.dim,
          },
        ]);
        break;
      }
      case '/usage': {
        const total = state.usageTotals;
        showResultPanel('/usage', [
          { bold: true, content: '  neuron meter', fg: COLORS.white },
          {
            content: `  total: ${formatTokenCount(total.totalTokens)} tokens · ${formatCost(total.cost)}`,
            fg: COLORS.gray,
          },
          {
            content: `  input: ${formatTokenCount(total.input)} · output: ${formatTokenCount(total.output)}`,
            fg: COLORS.gray,
          },
          {
            content: `  cache read: ${formatTokenCount(total.cacheRead)} · cache write: ${formatTokenCount(total.cacheWrite)}`,
            fg: COLORS.dim,
          },
        ]);
        break;
      }
      case '/analytics': {
        const scope = arg === 'global' ? 'global' : 'project';
        const range =
          arg === 'session' ||
          arg === '7d' ||
          arg === '30d' ||
          arg === '90d' ||
          arg === 'all'
            ? arg
            : '30d';
        const report = analytics.report({
          range,
          scope,
          workspaceRoot: cwd,
        });
        showResultPanel(
          `/analytics ${arg || '30d'}`,
          report === null
            ? [{ content: '  analytics unavailable', fg: COLORS.yellow }]
            : formatAnalyticsRows(report).map((content, index) => ({
                bold: index === 0 || content.trim() === 'overview',
                content,
                fg: content.trim().length === 0 ? COLORS.dim : COLORS.gray,
              })),
        );
        break;
      }
      case '/rate': {
        if (arg !== 'helpful' && arg !== 'unhelpful') {
          showResultPanel('/rate', [
            {
              content: '  usage: /rate helpful|unhelpful',
              fg: COLORS.yellow,
            },
          ]);
          break;
        }
        analytics.rate(arg);
        showResultPanel('/rate', [
          {
            content: `  current run rated ${arg}`,
            fg: COLORS.gray,
          },
        ]);
        break;
      }
      case '/workspace': {
        showResultPanel('/workspace', [
          { content: `  workspace: ${cwd}`, fg: COLORS.gray },
        ]);
        break;
      }
      case '/skills': {
        const skills = discoverSkills(cwd);
        const rows: { content: string; fg?: string; bold?: boolean }[] = [];
        if (skills.length === 0) {
          rows.push({ content: '  no skills found', fg: COLORS.dim });
        } else {
          rows.push({ bold: true, content: '  skills:', fg: COLORS.white });
          for (const s of skills) {
            rows.push({ content: `  #${s}`, fg: accent() });
          }
        }
        showResultPanel('/skills', rows);
        break;
      }
      case '/mcp': {
        const mcpConfigPath = path.join(
          process.env.HOME ?? '~',
          '.config',
          'opencode',
          'opencode.json',
        );
        const rows: { content: string; fg?: string; bold?: boolean }[] = [];
        try {
          const raw = fs.readFileSync(mcpConfigPath, 'utf8');
          const cfg = JSON.parse(raw) as {
            mcpServers?: Record<string, unknown>;
            mcp?: Record<string, unknown>;
          };
          const servers: Record<string, unknown> =
            cfg.mcpServers ?? cfg.mcp ?? {};
          const names = Object.keys(servers);
          if (names.length === 0) {
            rows.push({
              content: '  no MCP servers configured',
              fg: COLORS.dim,
            });
          } else {
            rows.push({
              bold: true,
              content: '  MCP servers:',
              fg: COLORS.white,
            });
            for (const name of names) {
              const srv = servers[name];
              const server =
                srv !== null && typeof srv === 'object'
                  ? (srv as { command?: unknown; args?: unknown })
                  : {};
              const cmd =
                typeof server.command === 'string' ? server.command : '';
              const args = Array.isArray(server.args)
                ? server.args.join(' ')
                : '';
              rows.push({ bold: true, content: `  ${name}`, fg: accent() });
              if (cmd.length > 0) {
                rows.push({
                  content: `    ${cmd} ${args}`.trim(),
                  fg: COLORS.gray,
                });
              }
            }
          }
        } catch {
          rows.push({ content: '  no MCP config found', fg: COLORS.dim });
        }
        showResultPanel('/mcp', rows);
        break;
      }
      case '/tools': {
        const toolsPath = path.join(options.cwd, 'dist', 'server.mjs');
        const rows: { content: string; fg?: string; bold?: boolean }[] = [];
        try {
          const content = fs.readFileSync(toolsPath, 'utf8');
          const toolMatches = content.matchAll(/name:\s*["']([^"']+)["']/g);
          const toolNames = new Set<string>();
          for (const m of toolMatches) {
            const toolName = m[1];
            if (toolName !== undefined) {
              toolNames.add(toolName);
            }
          }
          if (toolNames.size === 0) {
            rows.push({
              content: '  no tools found in harness',
              fg: COLORS.dim,
            });
          } else {
            rows.push({
              bold: true,
              content: '  registered tools:',
              fg: COLORS.white,
            });
            for (const t of [...toolNames].toSorted()) {
              rows.push({ content: `  ${t}`, fg: accent() });
            }
          }
        } catch {
          rows.push({
            content: '  could not read harness build',
            fg: COLORS.dim,
          });
        }
        showResultPanel('/tools', rows);
        break;
      }
      case '/subagents': {
        const rows =
          state.subAgents.length === 0
            ? [{ content: '  no subagents', fg: COLORS.dim }]
            : state.subAgents.map((sub) => ({
                content: `  ${sub.id.padEnd(6)} ${sub.status.padEnd(9)} ${sub.query}`,
                fg:
                  sub.status === 'running'
                    ? COLORS.pink
                    : sub.status === 'done'
                      ? COLORS.green
                      : COLORS.red,
              }));
        showResultPanel('/subagents', rows);
        break;
      }
      case '/sudo': {
        if (isAllowAll()) {
          setAllowAll(cwd, false);
          showResultPanel('/sudo', [
            { content: '  sudo disabled', fg: COLORS.green },
          ]);
          updateStatus();
          break;
        }
        showConfirm(
          'Sudo Mode',
          [
            {
              content:
                '  DANGER: allow every tool the agent has access to without prompts',
              fg: COLORS.red,
            },
            {
              content:
                '  This includes every tool the agent has access to, such as bash, write, edit, rename, and undo.',
              fg: COLORS.yellow,
            },
            {
              content: '  Enter to enable · Escape to cancel',
              fg: COLORS.dim,
            },
          ],
          (confirmed) => {
            if (!confirmed) {
              return;
            }
            setAllowAll(cwd, true);
            showResultPanel('/sudo', [
              { content: '  sudo enabled: all tools allowed', fg: COLORS.pink },
            ]);
            updateStatus();
          },
          10_000,
          true,
          false,
        );
        updateStatus();
        break;
      }
      case '/permissions': {
        const rows: { content: string; fg?: string; bold?: boolean }[] = [
          {
            content: '  rules from .agents/rules.json merge after defaults',
            fg: COLORS.dim,
          },
        ];
        for (const rule of permissionRules.length > 0
          ? permissionRules
          : getDefaultRules()) {
          const qualifier =
            rule.commandClass !== undefined
              ? ` (${rule.commandClass} shell)`
              : rule.argPattern !== undefined
                ? ` (${rule.argPattern})`
                : '';
          rows.push({
            content: `  ${rule.action.padEnd(5)} ${rule.tool}${qualifier}`,
            fg:
              rule.action === 'allow'
                ? COLORS.green
                : rule.action === 'deny'
                  ? COLORS.red
                  : COLORS.yellow,
          });
        }
        showResultPanel('/permissions', rows);
        break;
      }
      case '/copy': {
        const transcript = state.messages
          .map((m) => {
            const prefix = m.role === 'user' ? '> ' : '~ ';
            return `${prefix}${m.content}`;
          })
          .join('\n\n');
        if (copyTextToClipboard(transcript)) {
          showResultPanel('/copy', [
            { content: '  session copied to clipboard', fg: COLORS.green },
          ]);
        } else {
          showResultPanel('/copy', [
            {
              content: '  no supported clipboard command found',
              fg: COLORS.dim,
            },
          ]);
        }
        break;
      }
      case '/plan': {
        togglePlanMode();
        break;
      }
      case '/undo': {
        if (state.messages.length === 0) {
          showResultPanel('/undo', [
            { content: '  nothing to undo', fg: COLORS.dim },
          ]);
          break;
        }
        const lastBackup = backupHistory.pop();
        let restoreMsg = '';
        if (lastBackup !== undefined) {
          try {
            backupEngine.restoreBackup(lastBackup);
            restoreMsg = ' and restored workspace files';
          } catch (error: unknown) {
            restoreMsg = ` (failed to restore backup: ${error instanceof Error ? error.message : String(error)})`;
          }
        }
        let removedCount = 0;
        while (state.messages.length > 0 && removedCount < 2) {
          state.messages.pop();
          removedCount++;
        }
        if (activeBackend === 'codex') {
          await flue.undoLastTurn?.();
        }
        renderAllMessages();
        showResultPanel('/undo', [
          {
            content: `  removed last ${removedCount} messages${restoreMsg}`,
            fg: COLORS.dim,
          },
        ]);
        break;
      }
      case '/quit': {
        handleExit();
        break;
      }
      case '/paste-image': {
        const imgPath = await pasteImageFromClipboard(cwd);
        if (imgPath !== null && imgPath !== '') {
          imageCounter++;
          const tag = `[Image ${imageCounter}]`;
          attachedImages.push({ path: imgPath, tag });
          inputField.insertText(tag);
        } else {
          showResultPanel('/paste-image', [
            { content: '  No image found in clipboard', fg: COLORS.yellow },
          ]);
        }
        break;
      }
      default: {
        showResultPanel(cmd, [
          { content: `  unknown command: ${cmd}`, fg: COLORS.yellow },
        ]);
      }
    }
  }

  inputField.focus();

  const keybindingsCtx = {
    addInfoLine,
    completion,
    confirmBox: confirmBoxMgr,
    handleExit,
    handleInterrupt,
    handleSubmit: () => {
      const text = inputField.plainText.trim();
      if (!text) {
        return;
      }
      inputField.setText('');
      if (typeof inputField.onContentChange === 'function') {
        inputField.onContentChange(inputField.plainText);
      }
      if (text.startsWith('/')) {
        handleSlashCommand(text).catch((error: unknown) => {
          addInfoLine(
            `  command failed: ${error instanceof Error ? error.message : String(error)}`,
            COLORS.red,
          );
        });
      } else {
        _sendPrompt(text).catch(() => {});
      }
    },
    inputField,
    permissionBox: permissionBoxMgr,
    questionBox: questionBoxMgr,
    queuePanelRefresh: refreshQueuePanel,
    requestScroll,
    resultPanel: resultPanelMgr,
    store,
    subBox: subPanelMgr,
    subManager,
    togglePlanMode,
    updateStatus,
    viewerOverlay,
    withModeTag,
  };

  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    if (viewerOverlay.visible) {
      return;
    }
    if ((key.ctrl || key.meta) && key.name === 'v') {
      pasteImageFromClipboard(cwd)
        .then((imgPath) => {
          if (imgPath !== null && imgPath !== '') {
            imageCounter++;
            const tag = `[Image ${imageCounter}]`;
            attachedImages.push({ path: imgPath, tag });
            inputField.insertText(tag);
            renderer.requestRender();
          }
        })
        .catch(() => {});
    }
    if (modelPickerActive && modelPickerState !== null) {
      if (key.name === 'up' || (key.name === 'k' && !key.ctrl)) {
        moveModelPickerSelection(modelPickerState, -1);
        renderModelPicker();
        key.stopPropagation();
        return;
      }
      if (key.name === 'down' || (key.name === 'j' && !key.ctrl)) {
        moveModelPickerSelection(modelPickerState, 1);
        renderModelPicker();
        key.stopPropagation();
        return;
      }
      if (key.name === 'return') {
        selectModelFromPicker().catch((error: unknown) => {
          addInfoLine(
            `model selection failed: ${error instanceof Error ? error.message : String(error)}`,
            COLORS.red,
          );
        });
        key.stopPropagation();
        return;
      }
      if (key.name === 'escape') {
        closeModelPicker();
        key.stopPropagation();
        return;
      }
    }
    if (sessionPickerActive) {
      if (key.name === 'up' || (key.name === 'k' && !key.ctrl)) {
        sessionPickerSelected = Math.max(0, sessionPickerSelected - 1);
        renderPicker();
        key.stopPropagation();
        return;
      }
      if (key.name === 'down' || (key.name === 'j' && !key.ctrl)) {
        sessionPickerSelected = Math.min(
          sessionPickerSessions.length - 1,
          sessionPickerSelected + 1,
        );
        renderPicker();
        key.stopPropagation();
        return;
      }
      if (key.name === 'return') {
        void resumeSession(sessionPickerSelected);
        key.stopPropagation();
        return;
      }
      if (key.name === 'escape') {
        closeSessionPicker();
        key.stopPropagation();
        return;
      }
    }
    if (specApprovalBox.visible) {
      if (key.name === 'y' || key.name === 'return') {
        hideSpecApprovalBox(true);
        key.stopPropagation();
        return;
      }
      if (key.name === 'n' || key.name === 'escape') {
        hideSpecApprovalBox(false);
        key.stopPropagation();
        return;
      }
      key.stopPropagation();
      return;
    }
    handleKeyPress(key, keybindingsCtx);
  });

  process.on('SIGTERM', () => {
    stopSpinner();
    clearInterval(lavaLampTimer);
    renderer.destroy();
  });
  process.on('uncaughtException', (err) => {
    stopSpinner();
    clearInterval(lavaLampTimer);
    let savedId: string | null = null;
    if (state.messages.length > 0) {
      const sessionName = nameSession(state.messages);
      savedId = saveSession(state.messages, sessionName, currentSessionId);
    }
    try {
      renderer.destroy();
    } catch {
      /* intentionally ignored */
    }
    console.error(`[lavalamp] Fatal: ${err.message}`);
    if (savedId !== null) {
      const reset = '\u001B[0m';
      const dimColor = hexToAnsi(COLORS.dim);
      const cyanColor = hexToAnsi(COLORS.cyan);
      const whiteColor = hexToAnsi(COLORS.white);
      const bannerColor = hexToAnsi(COLORS.accent);
      console.error(
        `\n${dimColor}session:${reset} ${whiteColor}${savedId}${reset}\n` +
          `${bannerColor}continue:${reset} ${cyanColor}lavalamp --continue ${savedId}${reset}\n`,
      );
    }
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    addInfoLine(
      `  unhandled: ${err instanceof Error ? err.message : String(err)}`,
      COLORS.red,
    );
  });

  await startRuntimeWithTuiCleanup(
    () => flue.start(),
    () => renderer.destroy(),
  );
  if (activeBackend === 'codex') {
    if (isCodexLoginRequired(flue.account)) {
      showResultPanel('/login', [
        { content: '  Codex authentication required.', fg: COLORS.yellow },
        { content: '  Run /login to sign in.', fg: COLORS.dim },
      ]);
    }
  }
  updateHeader();
  updatePromptChar();
  updateStatus();

  if (options.resumeSession) {
    if (typeof options.resumeSessionId === 'string') {
      const codexRecord = activeBackend === 'codex'
        ? loadCodexSession(options.resumeSessionId)
        : null;
      if (codexRecord !== null && flue.resumeThread !== undefined) {
        const thread = await flue.resumeThread(codexRecord.codexThreadId);
        const messages = reconstructCodexMessages(thread);
        currentSessionId = options.resumeSessionId;
        state.messages = messages;
        state.planMode = codexRecord.mode === 'plan';
        renderAllMessages();
      } else {
      const messages = loadSession(options.resumeSessionId);
      if (messages !== null) {
        currentSessionId = options.resumeSessionId;
        state.messages = messages;
        const usage = analytics.conversationUsage(currentSessionId);
        if (usage !== null) {
          Object.assign(state.usageTotals, {
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            cost: usage.costTotal,
            input: usage.input,
            output: usage.output,
            totalTokens: usage.totalTokens,
          });
        }
        contextTransferPending = true;

        renderAllMessages();
      } else {
        showResultPanel('session', [
          {
            content: `  session not found: ${options.resumeSessionId}`,
            fg: COLORS.red,
          },
        ]);
      }
      }
    } else {
      const sessions = listSessions();
      if (sessions.length === 0) {
        showResultPanel('sessions', [
          { content: '  no saved sessions', fg: COLORS.dim },
        ]);
      } else {
        showSessionPicker(sessions);
      }
    }
  }

  await lifetime.finished;
}
