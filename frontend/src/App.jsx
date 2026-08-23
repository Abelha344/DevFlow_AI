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

function downloadTextFile(filename, content) {
  const blob = new Blob([content || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function ArtifactDownloads({ code, tests, prompt, threadId, variant = "default" }) {
  const btnClass =
    variant === "pill"
      ? "rounded-full border border-teal-700/20 bg-white/90 px-3 py-1 text-xs font-medium text-teal-900 shadow-sm transition hover:bg-teal-50"
      : variant === "compact"
        ? "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
        : "rounded-lg border border-teal-700/30 bg-white px-3 py-2 text-sm font-semibold text-teal-900 hover:bg-teal-50";

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className={btnClass}
        onClick={() => downloadTextFile("solution.py", code)}
      >
        solution.py
      </button>
      <button
        type="button"
        className={btnClass}
        onClick={() => downloadTextFile("test_solution.py", tests)}
      >
        test_solution.py
      </button>
      {prompt ? (
        <button
          type="button"
          className={btnClass}
          onClick={() => downloadTextFile("prompt.txt", prompt)}
        >
          prompt.txt
        </button>
      ) : null}
      {threadId && variant === "default" ? (
        <span className="self-center font-mono text-[11px] text-slate-500">
          session {threadId.slice(0, 8)}
        </span>
      ) : null}
    </div>
  );
}

function CompletionBanner({ sessionComplete, saveToDisk, onDismiss }) {
  if (!sessionComplete) return null;

  const approved = sessionComplete.outcome === "approved";

  return (
    <div
      className={`mb-4 flex flex-col gap-3 rounded-2xl border p-4 shadow-sm sm:flex-row sm:items-start sm:justify-between ${
        approved
          ? "border-teal-200/80 bg-gradient-to-br from-teal-50 via-white to-emerald-50/80"
          : "border-slate-200 bg-gradient-to-br from-slate-50 to-white"
      }`}
    >
      <div className="flex gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg font-bold text-white ${
            approved ? "bg-teal-700" : "bg-slate-500"
          }`}
        >
          {approved ? "✓" : "×"}
        </div>
        <div>
          <p className="font-display text-lg text-teal-950">
            {approved ? "Approved — your next prompt is ready" : "Review ended"}
          </p>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">
            {approved ? (
              saveToDisk && sessionComplete.artifactsSaved ? (
                <>
                  Saved to{" "}
                  <span className="font-mono text-teal-900">
                    {sessionComplete.savePath ||
                      `output/${sessionComplete.threadId?.slice(0, 8)}…`}
                  </span>
                  . Download copies below, then type your next request.
                </>
              ) : (
                <>
                  Session complete. Download the files if you want to keep them, then enter
                  your next request below.
                </>
              )
            ) : (
              "Adjust your prompt and run again, or reset the workspace."
            )}
          </p>
          {approved && (
            <div className="mt-3">
              <ArtifactDownloads
                variant="pill"
                code={sessionComplete.code}
                tests={sessionComplete.tests}
                prompt={sessionComplete.taskPrompt}
                threadId={sessionComplete.threadId}
              />
            </div>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="self-start rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 transition hover:bg-white/80 hover:text-slate-800"
      >
        Dismiss
      </button>
    </div>
  );
}

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [threadId, setThreadId] = useState(null);
  const [agentState, setAgentState] = useState(EMPTY_STATE);
  const [running, setRunning] = useState(false);
  const [streamLogs, setStreamLogs] = useState([]);
  const [error, setError] = useState(null);
  const [llmInfo, setLlmInfo] = useState(null);
  const [sessionComplete, setSessionComplete] = useState(null);
  const [showCompletionBanner, setShowCompletionBanner] = useState(true);
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
    setShowCompletionBanner(true);
    const timer = setTimeout(() => {
      promptRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      promptInputRef.current?.focus();
    }, 120);
    return () => clearTimeout(timer);
  }, [sessionComplete]);

  const resetWorkspace = useCallback(() => {
    setPrompt("");
    setThreadId(null);
    setAgentState(EMPTY_STATE);
    setStreamLogs([]);
    setError(null);
    setSessionComplete(null);
    setShowCompletionBanner(true);
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
        artifactsSaved: Boolean(data.artifacts_saved),
        storageMode: data.storage_mode || (llmInfo?.storage_mode ?? "session"),
        threadId,
        code: agentState.code || "",
        tests: agentState.tests || "",
        taskPrompt: agentState.prompt || prompt,
      });
      setPrompt("");
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
  const saveToDisk = llmInfo?.save_artifacts !== false;
  const approvedReady = sessionComplete?.outcome === "approved";
  const statusLabel = readyForNextTask
    ? approvedReady
      ? "ready · next task"
      : "rejected · edit & retry"
    : `${agentState.status || "idle"}${
        typeof agentState.iteration_count === "number"
          ? ` · iter ${agentState.iteration_count}`
          : ""
      }`;
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

      <main className={`mx-auto max-w-7xl space-y-8 px-6 pt-6 ${readyForNextTask ? "pb-12" : "pb-28"}`}>
        <section
          ref={promptRef}
          className={`animate-rise rounded-2xl border bg-white/60 p-5 shadow-sm backdrop-blur transition ${
            readyForNextTask
              ? "border-teal-300/80 ring-2 ring-teal-500/25 ring-offset-2 ring-offset-[#eef3e6]"
              : "border-transparent"
          }`}
        >
          {readyForNextTask && showCompletionBanner && (
            <CompletionBanner
              sessionComplete={sessionComplete}
              saveToDisk={saveToDisk}
              onDismiss={() => setShowCompletionBanner(false)}
            />
          )}

          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <label className="block text-sm font-semibold text-slate-800">
              {readyForNextTask ? "Next feature / bug request" : "Feature / bug request"}
            </label>
            {readyForNextTask && approvedReady && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-700 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-white shadow-sm">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300 animate-pulse" />
                Ready for next task
              </span>
            )}
          </div>

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
              rows={readyForNextTask ? 5 : 4}
              aria-label={promptHint}
              className={`relative w-full resize-y rounded-xl border bg-white px-4 py-3 text-sm text-slate-800 shadow-inner outline-none ring-teal-600/30 placeholder:text-transparent focus:ring-2 ${
                readyForNextTask
                  ? "border-teal-300/70 focus:border-teal-500"
                  : "border-slate-300/80"
              }`}
              placeholder={promptHint}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleRun}
              disabled={running || !prompt.trim()}
              className="rounded-lg bg-teal-800 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {runLabel}
            </button>
            {readyForNextTask && (
              <button
                type="button"
                onClick={handleStartNewTask}
                disabled={running}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear workspace
              </button>
            )}
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-slate-600">
              {statusLabel}
            </span>
            {error && (
              <span className="text-sm text-rose-700">{error}</span>
            )}
          </div>
        </section>

        {readyForNextTask ? (
          <details className="group rounded-2xl border border-slate-200/70 bg-white/40 shadow-sm backdrop-blur">
            <summary className="cursor-pointer list-none px-5 py-4 marker:content-none">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-display text-lg text-slate-700">
                  Previous run
                </span>
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500 group-open:hidden">
                  Expand to review code &amp; logs
                </span>
                <span className="hidden text-xs font-medium uppercase tracking-wide text-slate-500 group-open:inline">
                  Collapse
                </span>
              </div>
            </summary>
            <div className="space-y-8 border-t border-slate-200/70 px-5 pb-6 pt-4">
              <section>
                <h2 className="mb-3 font-display text-xl text-teal-950">Execution graph</h2>
                <GraphVisualizer
                  currentNode={agentState.current_node}
                  status={agentState.status}
                  testsPassed={agentState.tests_passed}
                />
              </section>
              <section>
                <h2 className="mb-3 font-display text-xl text-teal-950">Generated artifacts</h2>
                <CodeViewer code={agentState.code || ""} tests={agentState.tests || ""} />
              </section>
              <section>
                <h2 className="mb-3 font-display text-xl text-teal-950">Terminal</h2>
                <TerminalLogs content={terminalText} />
              </section>
            </div>
          </details>
        ) : (
          <>
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
          </>
        )}
      </main>

      {awaitingApproval && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-amber-500/40 bg-amber-50/95 px-4 py-4 shadow-[0_-8px_30px_rgba(15,23,42,0.12)] backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-display text-lg text-amber-950">
                Human approval required
              </p>
              <p className="text-sm text-amber-900/80">
                Pytest passed. Review the code, download if you want a copy, then approve to finish this session.
                {!saveToDisk && (
                  <span className="block mt-1 text-amber-950/90">
                    Cloud mode: approval does not write to server disk — use Download to keep the files.
                  </span>
                )}
              </p>
              <ArtifactDownloads
                variant="compact"
                code={agentState.code}
                tests={agentState.tests}
                prompt={prompt}
                threadId={threadId}
              />
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
                Approve
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
