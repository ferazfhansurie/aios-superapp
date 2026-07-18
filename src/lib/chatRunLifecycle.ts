/**
 * Authoritative renderer-side run state. A stop click is only a request: the
 * pane remains interrupting until the engine sends a terminal lifecycle frame.
 * Every accepted start receives a local run id so late frames from a previous
 * run cannot settle the newer one.
 */
export type ChatRunTerminalType = "completed" | "failed" | "interrupted" | "exited";

export interface ChatRunTerminal<T extends ChatRunTerminalType = ChatRunTerminalType> {
  type: T;
  reason?: string;
}

export type ChatRunLifecycle =
  | { phase: "idle"; runId?: never; turnId?: never; terminal?: never }
  | { phase: "starting"; runId: string; turnId?: never; terminal?: never }
  | { phase: "running"; runId: string; turnId?: string; terminal?: never }
  | { phase: "interrupting"; runId: string; turnId?: string; terminal?: never }
  | {
      phase: "completed";
      runId: string;
      turnId?: string;
      terminal: ChatRunTerminal<"completed">;
    }
  | {
      phase: "failed";
      runId: string;
      turnId?: string;
      terminal: ChatRunTerminal<"failed">;
    }
  | {
      phase: "interrupted";
      runId: string;
      turnId?: string;
      terminal: ChatRunTerminal<"interrupted">;
    }
  | {
      phase: "exited";
      runId: string;
      turnId?: string;
      terminal: ChatRunTerminal<"exited">;
    };

export type ChatRunLifecycleEvent =
  | { type: "starting" }
  | { type: "running"; runId: string; turnId?: string }
  | { type: "interrupting"; runId: string }
  | { type: "completed"; runId: string; reason?: string }
  | { type: "failed"; runId: string; reason?: string }
  | { type: "interrupted"; runId: string; reason?: string }
  | { type: "exited"; runId: string; reason?: string };

let runSequence = 0;

export function createChatRunId(): string {
  runSequence += 1;
  return `chat-run-${runSequence}`;
}

export function initialChatRunLifecycle(): ChatRunLifecycle {
  return { phase: "idle" };
}

export function isTerminalChatRun(
  state: ChatRunLifecycle,
): state is Extract<ChatRunLifecycle, { terminal: ChatRunTerminal }> {
  return (
    state.phase === "completed" ||
    state.phase === "failed" ||
    state.phase === "interrupted" ||
    state.phase === "exited"
  );
}

/** A normal send starts a fresh turn only while no prior turn is in flight. */
export function canStartNormalSend(state: ChatRunLifecycle): boolean {
  return state.phase === "idle" || isTerminalChatRun(state);
}

/** @deprecated use canStartNormalSend for the explicit action name. */
export function canSendNormally(state: ChatRunLifecycle): boolean {
  return canStartNormalSend(state);
}

/** Steering is valid solely for a backend-confirmed live lifecycle. */
export function canSteer(state: ChatRunLifecycle): boolean {
  return state.phase === "running";
}

function hasMismatchedRunId(state: ChatRunLifecycle, event: ChatRunLifecycleEvent): boolean {
  return state.phase !== "idle" && event.type !== "starting" && event.runId !== state.runId;
}

function terminalState<T extends ChatRunTerminalType>(
  state: Exclude<ChatRunLifecycle, { phase: "idle" }>,
  type: T,
  reason?: string,
): Extract<ChatRunLifecycle, { phase: T }> {
  return {
    phase: type,
    runId: state.runId,
    ...(state.turnId ? { turnId: state.turnId } : {}),
    terminal: reason ? { type, reason } : { type },
  } as Extract<ChatRunLifecycle, { phase: T }>;
}

export function reduceChatRunLifecycle(
  state: ChatRunLifecycle,
  event: ChatRunLifecycleEvent,
): ChatRunLifecycle {
  // The first terminal frame is authoritative. Late results, error fallbacks,
  // and process-exit notifications must not rewrite the visible outcome.
  if (isTerminalChatRun(state) && event.type !== "starting") return state;
  if (hasMismatchedRunId(state, event)) return state;

  switch (event.type) {
    case "starting":
      // Duplicate startup notifications must not erase a live turn or cancel an
      // interrupt already in flight. Only idle/terminal states may open a run.
      if (state.phase !== "idle" && !isTerminalChatRun(state)) return state;
      // The id comes from this renderer, never transport input. It clears the
      // prior terminal/turn identity so the next run cannot inherit either.
      return { phase: "starting", runId: createChatRunId() };

    case "running":
      // An interrupt request wins over a delayed turn/start acknowledgement.
      if (state.phase === "idle" || state.phase === "interrupting") return state;
      return {
        phase: "running",
        runId: state.runId,
        ...(event.turnId ? { turnId: event.turnId } : state.turnId ? { turnId: state.turnId } : {}),
      };

    case "interrupting":
      // A stop can land before a local spawn / remote websocket enqueue has
      // acknowledged `running`. It still owns this renderer run and must block
      // a later running frame from making steer available again.
      if (state.phase === "idle" || state.phase === "interrupting") {
        return state;
      }
      return {
        phase: "interrupting",
        runId: state.runId,
        ...(state.turnId ? { turnId: state.turnId } : {}),
      };

    case "completed":
    case "failed":
    case "interrupted":
    case "exited":
      if (state.phase === "idle") return state;
      return terminalState(state, event.type, event.reason);
  }
}
