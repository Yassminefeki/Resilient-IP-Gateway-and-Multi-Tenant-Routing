import { ArrowDown, ArrowUp } from 'lucide-react';
import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortKey?: string;
}

interface Props<T> {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  sort?: string;
  onSort?: (sort: string) => void;
  rowClassName?: (row: T) => string | undefined;
}

/** Table on wide screens; each row becomes a labelled record card on narrow screens (CSS only). */
export function DataTable<T>({ caption, columns, rows, rowKey, sort, onSort, rowClassName }: Props<T>) {
  const [sortField, sortDir] = (sort ?? '').split(':');
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = c.sortKey && c.sortKey === sortField;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (sortDir === 'desc' ? 'descending' : 'ascending') : undefined}
                >
                  {c.sortKey && onSort ? (
                    <button
                      type="button"
                      className="th-sort"
                      onClick={() =>
                        onSort(`${c.sortKey}:${active && sortDir === 'asc' ? 'desc' : 'asc'}`)
                      }
                    >
                      {c.header}
                      {active &&
                        (sortDir === 'desc' ? (
                          <ArrowDown size={14} aria-hidden />
                        ) : (
                          <ArrowUp size={14} aria-hidden />
                        ))}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className={rowClassName ? rowClassName(row) : undefined}>
              {columns.map((c) => (
                <td key={c.key} data-label={c.header}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
