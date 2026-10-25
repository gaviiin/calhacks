import { categoryName, usdShort } from '../lib/format';
import { IconAgent, IconEntry, IconPolicy, IconQuestion } from './icons';
import type { InboxItem } from './inboxModel';

function KindIcon({ item }: { item: InboxItem }) {
  if (item.kind === 'policy') return <IconPolicy size={14} />;
  if (item.kind === 'entry') return <IconEntry size={14} />;
  if (item.kind === 'question') return <IconQuestion size={14} />;
  return item.item.state === 'NEEDS_INFO' ? <IconQuestion size={14} /> : <IconAgent size={14} />;
}

function kindLabel(item: InboxItem): string {
  if (item.kind === 'policy') return 'Policy';
  if (item.kind === 'entry') return 'Revenue entry';
  if (item.kind === 'question') return 'Revenue question';
  if (item.item.state === 'NEEDS_INFO') return 'Question';
  return item.item.proposalSource === 'llm' ? 'New scenario' : 'Proposal';
}

export function InboxRow({ item, selected, onSelect }: { item: InboxItem; selected: boolean; onSelect: () => void }) {
  const proposal =
    item.kind === 'item'
      ? item.item.state === 'NEEDS_INFO'
        ? 'asks before classifying'
        : categoryName(item.item.proposedCategoryCode)
      : item.kind === 'policy'
        ? `→ ${categoryName(item.policy.categoryCode)}`
        : item.kind === 'question'
          ? 'asks about a contract clause'
          : item.entry.kind.replace(/_/g, ' ');
  return (
    <li>
      <button className={selected ? 'inbox-row inbox-row--on' : 'inbox-row'} onClick={onSelect} aria-current={selected ? 'true' : undefined}>
        <span className={`inbox-kind inbox-kind--${item.desk}`}>
          <KindIcon item={item} />
          {kindLabel(item)}
        </span>
        <span className="inbox-title">{item.title}</span>
        <span className="inbox-amount mono">{item.amount ? usdShort(item.amount) : ''}</span>
        <span className="inbox-sub">
          <span className="inbox-proposal">{proposal}</span>
          <span className="muted"> · {item.sub}</span>
        </span>
        <span className="inbox-needs">for {item.needs}</span>
      </button>
    </li>
  );
}
