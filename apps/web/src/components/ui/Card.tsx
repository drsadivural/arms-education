import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export function Card({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <section className={cn("rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-[0_3px_14px_#243f6410]", className)} {...rest} />;
}

export function CardHeader({ title, actions, description, id }: { title: ReactNode; actions?: ReactNode; description?: ReactNode; id?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id={id} className="text-base font-bold text-fg">
          {title}
        </h2>
        {description ? <p className="mt-1 text-xs text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function StatCard({ label, value, unit, note }: { label: string; value: ReactNode; unit?: string; note?: ReactNode }) {
  return (
    <Card className="p-5">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-3 text-3xl font-bold text-fg">
        {value}
        {unit ? <span className="ml-1 text-sm font-medium text-muted">{unit}</span> : null}
      </p>
      {note ? <p className="mt-3 text-xs text-muted">{note}</p> : null}
    </Card>
  );
}
