import type { RepoTraffic, TrafficItem } from "@/lib/git/types";
import { TrafficChart } from "./charts";
import { Empty, fmt, Stat, TitledSection } from "./primitives";

function ItemList({
  items,
  showTitle,
}: {
  items: TrafficItem[];
  showTitle?: boolean;
}) {
  return (
    <ul className="space-y-0.5">
      {items.slice(0, 8).map((it) => (
        <li
          key={it.name}
          className="flex items-baseline justify-between gap-3 text-xs"
        >
          <span
            className="min-w-0 truncate"
            title={showTitle ? it.title || it.name : it.name}
          >
            {showTitle ? it.title || it.name : it.name}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {fmt(it.count)} · {fmt(it.uniques)} unique
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TrafficCard({ data }: { data: RepoTraffic }) {
  if (!data.available) {
    return (
      <Empty>
        Traffic needs push access — GitHub only shares views and clones with the
        repository's maintainers.
      </Empty>
    );
  }
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-8">
        <Stat label="Views (14d)">
          {fmt(data.viewsCount)} · {fmt(data.viewsUniques)} unique
        </Stat>
        <Stat label="Clones (14d)">
          {fmt(data.clonesCount)} · {fmt(data.clonesUniques)} unique
        </Stat>
      </dl>
      {(data.views.length > 0 || data.clones.length > 0) && (
        <TrafficChart views={data.views} clones={data.clones} />
      )}
      <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
        {/* h3s under the card's h3: SectionTitle is an h3 everywhere, and
            each block is a named group inside the card's own group. */}
        {data.referrers.length > 0 && (
          <TitledSection title="Top referrers">
            <ItemList items={data.referrers} />
          </TitledSection>
        )}
        {data.paths.length > 0 && (
          <TitledSection title="Popular paths">
            <ItemList items={data.paths} showTitle />
          </TitledSection>
        )}
      </div>
    </div>
  );
}
