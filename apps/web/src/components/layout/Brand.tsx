/** Original H&A logo (unaltered, on a white tile for dark mode) + ARMS wordmark + subtitle. */
export function Brand({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className="inline-flex rounded-md bg-white p-1">
        <img src="/logo.png" alt="H&A" className={compact ? "h-6 w-auto" : "h-8 w-auto"} />
      </span>
      <span className="flex flex-col leading-none">
        <span className="text-2xl font-bold tracking-wide text-primary">ARMS</span>
        {compact ? null : <span className="mt-1 text-[9px] text-muted">新入社員研修システム</span>}
      </span>
    </div>
  );
}
