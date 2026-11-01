import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { isApiError } from '../api/errors';
import { EmptyState, ErrorState, LoadingSkeleton } from './ui';
import { formatDateTime } from '../lib/format';

interface Props<T> {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  rows?: number;
  label?: string;
}

/**
 * Keeps three situations visibly distinct:
 *  - loading        -> skeleton
 *  - request failed -> error state (or last-known data plus a stale warning)
 *  - succeeded but empty -> the caller's empty state
 */
export function QueryView<T>({ query, children, isEmpty, empty, rows, label }: Props<T>) {
  const { data, error, isError, isPending, refetch, dataUpdatedAt } = query;
  if (isPending && !isError) return <LoadingSkeleton rows={rows} label={label} />;
  if (data === undefined) {
    if (isApiError(error) && (error.kind === 'auth' || error.kind === 'forbidden')) {
      return (
        <EmptyState
          title="Sign-in required"
          message="Authentication is required to view live data. Set your API bearer token to continue."
          action={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('felcloud:open-auth'));
              }}
            >
              Set API token
            </button>
          }
        />
      );
    }
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'The request failed.'}
        traceId={isApiError(error) ? error.traceId : undefined}
        onRetry={() => void refetch()}
      />
    );
  }
  return (
    <>
      {isError && (
        <p className="stale-note" role="alert">
          Could not refresh. Showing last-known data from{' '}
          {formatDateTime(new Date(dataUpdatedAt).toISOString())}.
        </p>
      )}
      {isEmpty?.(data) ? empty : children(data)}
    </>
  );
}
