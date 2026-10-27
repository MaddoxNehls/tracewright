/**
 * A tiny positional-parameter collector. Query text is assembled only from
 * trusted fragments in this codebase; every user-supplied value goes through
 * `add()` and becomes a `$n` placeholder.
 */
export type SqlValue = string | number | boolean | null;

export interface BuiltQuery {
  text: string;
  values: SqlValue[];
}

export class Params {
  readonly values: SqlValue[] = [];

  add(value: SqlValue): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Escapes LIKE/ILIKE metacharacters so user text matches literally (default escape char is backslash). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
