/**
 * Minimal tagged-template SQL builder. Every interpolated value becomes a bind parameter ($n);
 * only `ident()` (validated identifiers) and `raw()` (code constants) are inlined as text.
 *
 *   sql`SELECT * FROM app.teachers WHERE id = ${id} ${limit ? sql`LIMIT ${limit}` : empty}`
 */
export class SqlFragment {
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}
}

class RawText {
  constructor(readonly text: string) {}
}

export function sql(strings: TemplateStringsArray | readonly string[], ...values: unknown[]): SqlFragment {
  return new SqlFragment(strings, values);
}

export const empty = sql``;

/** Inline trusted SQL text (never user input). */
export function raw(text: string): RawText {
  return new RawText(text);
}

const IDENT_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
/** Inline a column/table identifier from an allowlist. Throws for anything unexpected. */
export function ident(name: string): RawText {
  if (!IDENT_RE.test(name)) throw new Error(`Invalid identifier: ${name}`);
  return new RawText(name);
}

export function join(fragments: readonly SqlFragment[], separator = ", "): SqlFragment {
  if (fragments.length === 0) return empty;
  const strings: string[] = [""];
  const values: unknown[] = [];
  fragments.forEach((f, i) => {
    if (i > 0) strings[strings.length - 1] += separator;
    values.push(f);
    strings.push("");
  });
  return new SqlFragment(strings, values);
}

/** AND-joins the given conditions (undefined/false entries are skipped). Empty → TRUE. */
export function and(conditions: readonly (SqlFragment | false | null | undefined)[]): SqlFragment {
  const list = conditions.filter((c): c is SqlFragment => c instanceof SqlFragment);
  return list.length ? sql`(${join(list, " AND ")})` : sql`TRUE`;
}

export interface CompiledQuery {
  text: string;
  values: unknown[];
}

export function compile(fragment: SqlFragment): CompiledQuery {
  const values: unknown[] = [];
  const walk = (f: SqlFragment): string => {
    let text = f.strings[0] ?? "";
    for (let i = 0; i < f.values.length; i++) {
      const v = f.values[i];
      if (v instanceof SqlFragment) text += walk(v);
      else if (v instanceof RawText) text += v.text;
      else {
        values.push(v);
        text += `$${values.length}`;
      }
      text += f.strings[i + 1] ?? "";
    }
    return text;
  };
  return { text: walk(fragment), values };
}
