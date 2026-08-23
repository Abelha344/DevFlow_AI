import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GraphVisualizer from "./components/GraphVisualizer";
import CodeViewer from "./components/CodeViewer";
import TerminalLogs from "./components/TerminalLogs";

// Empty string is valid (Docker/Nginx same-origin /api proxy) — do not coerce with ||
const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

const EMPTY_STATE = {
  status: "idle",
  current_node: null,
  code: "",
  tests: "",
  stdout: "",
  stderr: "",
  logs: [],
  iteration_count: 0,
  tests_passed: false,
  failure_summary: "",
  paused: false,
};

const PROMPT_PLACEHOLDER =
  "Ask DevFlow AI for a feature or bug fix";

const PROMPT_PLACEHOLDER_NEXT =
  "Ask DevFlow AI for your next feature or bug fix";

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [threadId, setThreadId] = useState(null);
  const [agentState, setAgentState] = useState(EMPTY_STATE);
  const [running, setRunning] = useState(false);
  const [streamLogs, setStreamLogs] = useState([]);
  const [error, setError] = useState(null);
  const [llmInfo, setLlmInfo] = useState(null);
  const [sessionComplete, setSessionComplete] = useState(null);
  const [promptFocused, setPromptFocused] = useState(false);
  const promptRef = useRef(null);
  const promptInputRef = useRef(null);

  const awaitingApproval = useMemo(() => {
    if (agentState.status === "approved" || agentState.status === "rejected") {
      return false;
    }
    return agentState.paused || agentState.status === "awaiting_approval";
  }, [agentState]);

  const mergeState = useCallback((incoming) => {
    if (!incoming) return;
    setAgentState((prev) => ({
      ...prev,
      ...incoming,
      logs: incoming.logs?.length ? incoming.logs : prev.logs,
    }));
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/api/v1/agent/config`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setLlmInfo(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!sessionComplete) return undefined;
    const timer = setTimeout(() => {
      promptRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      promptInputRef.current?.focus();
    }, 180);
    return () => clearTimeout(timer);
  }, [sessionComplete]);

  const resetWorkspace = useCallback(() => {
    setPrompt("");
    setThreadId(null);
    setAgentState(EMPTY_STATE);
    setStreamLogs([]);
    setError(null);
    setSessionComplete(null);
    setRunning(false);
  }, []);

  const handleStartNewTask = () => {
    resetWorkspace();
    requestAnimationFrame(() => promptInputRef.current?.focus());
  };

  const handleRun = async () => {
    if (!prompt.trim() || running) return;
    setRunning(true);
    setError(null);
    setSessionComplete(null);
    setStreamLogs([]);
    setAgentState({ ...EMPTY_STATE, status: "coding", current_node: "coder" });
    setThreadId(null);

    try {
      const res = await fetch(`${API_BASE}/api/v1/agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      if (!res.ok) {
        throw new Error(`Run failed: ${res.status} ${res.statusText}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }

          if (evt.thread_id) setThreadId(evt.thread_id);

          if (evt.event === "node") {
            setStreamLogs((prev) => [
              ...prev,
              `[stream] node=${evt.node} status=${evt.state?.status || "?"}`,
            ]);
            mergeState({
              ...evt.state,
              current_node: evt.node,
            });
          } else if (evt.event === "paused") {
            mergeState({
              ...evt.state,
              paused: true,
              status: "awaiting_approval",
              current_node: "human_approval",
            });
            setStreamLogs((prev) => [...prev, "[stream] paused — awaiting approval"]);
          } else if (evt.event === "finished") {
            mergeState({ ...evt.state, paused: false });
            if (evt.state?.failure_summary) {
              setError(evt.state.failure_summary);
            }
            setStreamLogs((prev) => [...prev, "[stream] finished"]);
          } else if (evt.event === "error") {
            setError(evt.error || "Unknown stream error");
            setStreamLogs((prev) => [...prev, `[stream] ERROR: ${evt.error}`]);
          } else if (evt.event === "started") {
            setStreamLogs((prev) => [...prev, `[stream] started thread=${evt.thread_id}`]);
          } else if (evt.event === "heartbeat") {
            setStreamLogs((prev) => [...prev, "[stream] still working…"]);
          }
        }
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setRunning(false);
    }
  };

  const handleDecision = async (approved) => {
    if (!threadId) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/agent/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: threadId, approved }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Approve failed: ${res.status}`);
      }
      const data = await res.json();
      mergeState({
        ...data.state,
        status: data.status,
        paused: false,
        current_node: "completed",
        approved,
      });
      setSessionComplete({
        outcome: approved ? "approved" : "rejected",
        savePath: data.push_path || "",
        threadId,
      });
      setPrompt("");
      setStreamLogs((prev) => [
        ...prev,
        `[approval] ${approved ? "APPROVED" : "REJECTED"}`,
        approved
          ? "[session] Task complete — ready for your next request"
          : "[session] Review ended — start a new task when ready",
      ]);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setRunning(false);
    }
  };

  // Poll state while waiting for approval (resilience if stream ends early)
  useEffect(() => {
    if (!threadId || !awaitingApproval) return undefined;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/agent/state/${threadId}`);
        if (res.ok) {
          const data = await res.json();
          mergeState(data);
        }
      } catch {
        /* ignore poll errors */
      }
    }, 2500);
    return () => clearInterval(id);
  }, [threadId, awaitingApproval, mergeState]);

  // Poll during active runs so UI recovers if the stream drops mid-flight
  useEffect(() => {
    if (!threadId || !running || awaitingApproval) return undefined;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/agent/state/${threadId}`);
        if (res.ok) {
          const data = await res.json();
          mergeState(data);
        }
      } catch {
        /* ignore poll errors */
      }
    }, 3000);
    return () => clearInterval(id);
  }, [threadId, running, awaitingApproval, mergeState]);

  const terminalText = [
    ...(agentState.logs || []),
    ...streamLogs,
    agentState.stdout ? `\n--- pytest stdout ---\n${agentState.stdout}` : "",
    agentState.stderr ? `\n--- pytest stderr ---\n${agentState.stderr}` : "",
    agentState.failure_summary
      ? `\n--- failure summary ---\n${agentState.failure_summary}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const readyForNextTask = Boolean(sessionComplete);
  const promptHint = readyForNextTask ? PROMPT_PLACEHOLDER_NEXT : PROMPT_PLACEHOLDER;
  const showPromptHint = !prompt.trim() && !promptFocused && !running;
  const runLabel = running
    ? "Running…"
    : readyForNextTask
      ? "Run next task"
      : "Run Agent";

  return (
    <div className="min-h-screen text-ink">
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -left-24 top-0 h-[42rem] w-[42rem] rounded-full bg-teal-400/20 blur-3xl" />
        <div className="absolute -right-16 top-40 h-[36rem] w-[36rem] rounded-full bg-amber-300/25 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-[28rem] w-[28rem] rounded-full bg-sky-400/15 blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              "radial-gradient(rgba(15,23,42,0.08) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />
      </div>

      <header className="mx-auto flex max-w-7xl items-end justify-between px-6 pb-2 pt-10">
        <div>
          <p className="font-display text-5xl tracking-tight text-teal-900 md:text-6xl">
            DevFlow AI
          </p>
          <p className="mt-2 max-w-xl text-sm text-slate-600 md:text-base">
            Self-correcting <strong>Python</strong> code generation with live pytest feedback and human approval.
          </p>
          {llmInfo && (
            <p className="mt-1 font-mono text-xs text-teal-800/80">
              LLM: {llmInfo.label}
              {Array.isArray(llmInfo.allowed_libraries) && (
                <span className="block text-slate-600">
                  libs: {llmInfo.allowed_libraries.join(", ")}
                </span>
              )}
            </p>
          )}
        </div>
        <div className="hidden text-right text-xs text-slate-500 sm:block">
          <div>thread</div>
          <div className="font-mono text-slate-700">
            {threadId ? threadId.slice(0, 8) : "—"}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-8 px-6 pb-28 pt-6">
        <section
          ref={promptRef}
          className={`animate-rise rounded-2xl transition ${
            readyForNextTask
              ? "ring-2 ring-teal-500/40 ring-offset-2 ring-offset-[#eef3e6]"
              : ""
          }`}
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <label className="block text-sm font-medium text-slate-700">
              {readyForNextTask ? "Next feature / bug request" : "Feature / bug request"}
            </label>
            {readyForNextTask && (
              <span className="rounded-full bg-teal-100 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-teal-900">
                Ready for next task
              </span>
            )}
          </div>
          {readyForNextTask && (
            <p className="mb-2 text-sm text-slate-600">
              {sessionComplete.outcome === "approved"
                ? "Previous task approved and saved. Enter a new prompt below, or reset the workspace to start fresh."
                : "Previous review was rejected. Adjust your prompt and run again, or reset the workspace."}
            </p>
          )}
          <div className="relative">
            {showPromptHint && (
              <div
                className="pointer-events-none absolute inset-x-0 top-0 px-4 py-3 text-sm leading-relaxed text-slate-400"
                aria-hidden="true"
              >
                {promptHint}
              </div>
            )}
            <textarea
              ref={promptInputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onFocus={() => setPromptFocused(true)}
              onBlur={() => setPromptFocused(false)}
              rows={4}
              aria-label={promptHint}
              className="relative w-full resize-y rounded-xl border border-slate-300/80 bg-white/70 px-4 py-3 text-sm text-slate-800 shadow-sm outline-none ring-teal-600/30 backdrop-blur placeholder:text-transparent focus:ring-2"
              placeholder={promptHint}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleRun}
              disabled={running || !prompt.trim()}
              className="rounded-lg bg-teal-800 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {runLabel}
            </button>
            {readyForNextTask && (
              <button
                type="button"
                onClick={handleStartNewTask}
                disabled={running}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Reset workspace
              </button>
            )}
            <span className="text-xs uppercase tracking-wide text-slate-500">
              status: {agentState.status || "idle"}
              {typeof agentState.iteration_count === "number"
                ? ` · iter ${agentState.iteration_count}`
                : ""}
            </span>
            {error && (
              <span className="text-sm text-rose-700">{error}</span>
            )}
          </div>
        </section>

        <section className="animate-rise-delayed">
          <h2 className="mb-3 font-display text-2xl text-teal-950">Execution graph</h2>
          <GraphVisualizer
            currentNode={agentState.current_node}
            status={agentState.status}
            testsPassed={agentState.tests_passed}
          />
        </section>

        <section className="animate-rise-delayed-2">
          <h2 className="mb-3 font-display text-2xl text-teal-950">Generated artifacts</h2>
          <CodeViewer code={agentState.code || ""} tests={agentState.tests || ""} />
        </section>

        <section>
          <h2 className="mb-3 font-display text-2xl text-teal-950">Terminal</h2>
          <TerminalLogs content={terminalText} />
        </section>
      </main>

      {awaitingApproval && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-amber-500/40 bg-amber-50/95 px-4 py-4 shadow-[0_-8px_30px_rgba(15,23,42,0.12)] backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-display text-lg text-amber-950">
                Human approval required
              </p>
              <p className="text-sm text-amber-900/80">
                Pytest passed. Review the generated code, then approve to save it to the output folder.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={running}
                onClick={() => handleDecision(false)}
                className="rounded-lg border border-slate-400 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
              >
                Reject
              </button>
              <button
                type="button"
                disabled={running}
                onClick={() => handleDecision(true)}
                className="rounded-lg bg-teal-800 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
              >
                Approve &amp; Push
              </button>
            </div>
          </div>
        </div>
      )}

      {sessionComplete && !awaitingApproval && (
        <div
          className={`fixed inset-x-0 bottom-0 z-50 border-t px-4 py-4 shadow-[0_-8px_30px_rgba(15,23,42,0.12)] backdrop-blur ${
            sessionComplete.outcome === "approved"
              ? "border-teal-500/40 bg-teal-50/95"
              : "border-slate-400/50 bg-slate-50/95"
          }`}
        >
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
            <div>
              <p
                className={`font-display text-lg ${
                  sessionComplete.outcome === "approved"
                    ? "text-teal-950"
                    : "text-slate-900"
                }`}
              >
                {sessionComplete.outcome === "approved"
                  ? "Task completed successfully"
                  : "Review completed — changes not saved"}
              </p>
              <p className="text-sm text-slate-700">
                {sessionComplete.outcome === "approved" ? (
                  <>
                    Artifacts saved to{" "}
                    <span className="font-mono text-teal-900">
                      {sessionComplete.savePath || `output/${sessionComplete.threadId?.slice(0, 8)}…`}
                    </span>
                    . The workspace is ready for your next prompt.
                  </>
                ) : (
                  "You rejected this run. Update the prompt or reset the workspace to begin again."
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setSessionComplete(null);
                  promptInputRef.current?.focus();
                }}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
              >
                Keep reviewing
              </button>
              <button
                type="button"
                onClick={handleStartNewTask}
                className="rounded-lg bg-teal-800 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
              >
                Start new task
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
