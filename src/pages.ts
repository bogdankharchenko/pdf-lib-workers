import { badRequest } from "./errors";

/**
 * Turns a 1-based page selection into 0-based indices, in the order given.
 * Accepts an array of numbers, or a string such as "1-3,5,last", "all", "odd", "even".
 * Negative numbers count from the end (-1 is the last page).
 */
export function resolvePages(spec: string | number[] | undefined, count: number): number[] {
  if (spec === undefined || spec === "all") return range(0, count - 1);
  const out: number[] = [];
  const toIndex = (raw: string | number): number => {
    const s = String(raw).trim().toLowerCase();
    const n = s === "last" ? count : s === "first" ? 1 : Number(s);
    if (!Number.isInteger(n) || n === 0) throw badRequest(`Invalid page "${raw}"`);
    const idx = n < 0 ? count + n : n - 1;
    if (idx < 0 || idx >= count) throw badRequest(`Page ${raw} is out of range (document has ${count} pages)`);
    return idx;
  };
  if (Array.isArray(spec)) return spec.map(toIndex);
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (part === "odd" || part === "even") {
      for (let i = part === "odd" ? 0 : 1; i < count; i += 2) out.push(i);
      continue;
    }
    const m = part.match(/^(-?\w+)\s*-\s*(-?\w+)$/);
    if (m) {
      const [a, b] = [toIndex(m[1]), toIndex(m[2])];
      out.push(...(a <= b ? range(a, b) : range(b, a).reverse()));
    } else {
      out.push(toIndex(part));
    }
  }
  return out;
}

function range(a: number, b: number): number[] {
  const r: number[] = [];
  for (let i = a; i <= b; i++) r.push(i);
  return r;
}
