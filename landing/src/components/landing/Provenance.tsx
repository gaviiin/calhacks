import { PROVENANCE } from '../../data/demo';

/** The evidence trail behind a proposed entry: source, clause, computation, approver. */
export function Provenance({ id, approver }: { id: string; approver?: string }) {
  return (
    <dl className="provenance" id={id}>
      {PROVENANCE.map(p => (
        <div key={p.label}>
          <dt>{p.label}</dt>
          <dd>{p.value}</dd>
        </div>
      ))}
      <div>
        <dt>APPROVER</dt>
        <dd>{approver ?? 'Human Controller: pending'}</dd>
      </div>
    </dl>
  );
}
