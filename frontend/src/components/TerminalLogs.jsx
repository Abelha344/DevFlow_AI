import { useEffect, useRef } from "react";

export default function TerminalLogs({ content }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [content]);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-[#05080f] shadow-inner">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-500/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
        <span className="ml-2 font-mono text-xs text-slate-400">pytest · agent logs</span>
      </div>
      <pre
        ref={ref}
        className="max-h-80 overflow-auto p-4 font-mono text-[12px] leading-relaxed text-emerald-300/95"
      >
        {content || "$ waiting for agent output…"}
      </pre>
    </div>
  );
}
