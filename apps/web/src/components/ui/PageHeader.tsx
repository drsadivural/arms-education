import type { ReactNode } from "react";
import { Link } from "react-router";

export interface Crumb {
  label: string;
  to?: string;
}

/** Breadcrumb + page title (h1) + primary actions fixed at the top right. */
export function PageHeader({ title, crumbs = [], actions, description }: { title: string; crumbs?: Crumb[]; actions?: ReactNode; description?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <nav aria-label="パンくずリスト" className="mb-2 text-[11px] text-muted">
          <ol className="flex flex-wrap items-center gap-1">
            <li>
              <Link to="/dashboard" className="hover:underline">
                ARMS
              </Link>
            </li>
            {crumbs.map((c) => (
              <li key={c.label} className="flex items-center gap-1">
                <span aria-hidden>/</span>
                {c.to ? (
                  <Link to={c.to} className="hover:underline">
                    {c.label}
                  </Link>
                ) : (
                  <span aria-current="page">{c.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <h1 className="text-[28px] leading-tight font-bold text-fg">{title}</h1>
        {description ? <p className="mt-2 text-xs text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
