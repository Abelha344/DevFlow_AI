export default function CodeViewer({ code, tests }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="solution.py" body={code || "# waiting for coder…"} />
      <Panel title="test_solution.py" body={tests || "# waiting for coder…"} />
    </div>
  );
}

function Panel({ title, body }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800/80 bg-[#0b1220] shadow-lg shadow-slate-900/10">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="font-mono text-xs text-teal-300">{title}</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          python
        </span>
      </div>
      <pre className="max-h-[28rem] overflow-auto p-4 font-mono text-[12.5px] leading-relaxed text-slate-100">
        <code>{body}</code>
      </pre>
    </div>
  );
}
