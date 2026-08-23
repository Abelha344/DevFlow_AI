const NODES = [
  { id: "coder", label: "Coder", hint: "Generate / repair" },
  { id: "executor", label: "Executor", hint: "Run pytest" },
  { id: "evaluator", label: "Evaluator", hint: "Pass or retry" },
  { id: "human_approval", label: "Human Approval", hint: "Review gate" },
];

function nodeTone(id, currentNode, status, testsPassed) {
  const active = currentNode === id;
  const doneApproval =
    id === "human_approval" &&
    (status === "approved" || status === "rejected" || status === "completed");
  const passedEval = id === "evaluator" && testsPassed;
  const failed =
    status === "failed" && (id === "evaluator" || currentNode === id);

  if (failed) {
    return "border-rose-500 bg-rose-50 text-rose-900 shadow-rose-200";
  }
  if (doneApproval && status === "approved") {
    return "border-teal-600 bg-teal-50 text-teal-950";
  }
  if (doneApproval && status === "rejected") {
    return "border-slate-400 bg-slate-100 text-slate-700";
  }
  if (passedEval) {
    return "border-teal-500 bg-teal-50/80 text-teal-900";
  }
  if (active || status === "awaiting_approval" && id === "human_approval") {
    return "border-amber-500 bg-amber-50 text-amber-950 ring-2 ring-amber-400/60 animate-pulse-soft";
  }
  return "border-slate-300/80 bg-white/60 text-slate-600";
}

export default function GraphVisualizer({ currentNode, status, testsPassed }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white/50 p-5 backdrop-blur">
      <ol className="flex min-w-[640px] items-stretch gap-3">
        {NODES.map((node, index) => (
          <li key={node.id} className="flex flex-1 items-center gap-3">
            <div
              className={`flex-1 rounded-xl border px-4 py-3 transition ${nodeTone(
                node.id,
                currentNode,
                status,
                testsPassed
              )}`}
            >
              <div className="text-[11px] uppercase tracking-wider opacity-70">
                Step {index + 1}
              </div>
              <div className="font-display text-xl leading-tight">{node.label}</div>
              <div className="mt-1 text-xs opacity-80">{node.hint}</div>
            </div>
            {index < NODES.length - 1 && (
              <div className="hidden shrink-0 text-slate-400 sm:block" aria-hidden>
                →
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-slate-500">
        Cycle: Evaluator routes failures back to Coder (max 3 iterations) before ending.
      </p>
    </div>
  );
}
