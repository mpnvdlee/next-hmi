/**
 * A variable's current value, as read from the live pipeline — shared by the
 * datasource variable table and the recipe tables, which state the same three
 * cases: no value on the wire, an empty one, and a real one.
 */
export default function LiveValue({ value }: { value: string | undefined }) {
  if (value === undefined) return <span className="cfg-var-live-value--unavailable">—</span>;
  if (value === '') return <span className="cfg-var-live-value--empty">empty</span>;
  return <span className="cfg-var-live-value">{value}</span>;
}
