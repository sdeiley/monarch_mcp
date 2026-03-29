/**
 * Monarch Money transaction fetcher.
 * Fetches transactions from the Monarch GraphQL API.
 * Returns data — does not write to filesystem.
 */

export const BATCH_SIZE = 250;
export const API_URL = 'https://api.monarch.com/graphql';

const QUERY = `
  query GetTransactionsList($offset: Int, $limit: Int, $filters: TransactionFilterInput, $orderBy: TransactionOrdering) {
    allTransactions(filters: $filters) {
      totalCount
      results(offset: $offset, limit: $limit, orderBy: $orderBy) {
        id amount pending date originalDate hideFromReports needsReview
        plaidName notes isRecurring isSplitTransaction hasSplitTransactions
        category { id name group { id name type } }
        merchant { id name }
        account { id displayName }
        tags { id name color order }
        originalTransaction { id }
        splitTransactions {
          id amount notes
          merchant { id name }
          category { id name group { id name type } }
          tags { id name color order }
        }
      }
    }
  }
`;

/**
 * Fetch transactions from Monarch Money API.
 * @param {object} options
 * @param {string} options.token - Monarch auth token
 * @param {'recent'|'full'} [options.mode='recent'] - Fetch mode
 * @param {number} [options.months=3] - Months to look back (recent mode)
 * @param {string} [options.since] - Specific start date (YYYY-MM-DD)
 * @param {function} [options.onBatch] - Callback for progress: (batchNum, fetched, total) => void
 * @returns {Promise<{transactions: object[], totalCount: number, fetchedAt: string, mode: string, startDate: string|null}>}
 */
export async function fetchTransactions({ token, mode = 'recent', months = 3, since, onBatch }) {
  let startDate = null;
  if (mode !== 'full') {
    if (since) {
      startDate = since;
    } else {
      const d = new Date();
      d.setMonth(d.getMonth() - months);
      startDate = d.toISOString().split('T')[0];
    }
  }

  const filters = startDate ? { startDate } : {};

  async function fetchBatch(offset) {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': 'application/json',
        'Client-Platform': 'web',
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { offset, limit: BATCH_SIZE, filters, orderBy: 'date' },
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text.substring(0, 300)}`);
    }

    const json = await resp.json();
    if (json.errors) {
      throw new Error(`GraphQL: ${json.errors.map(e => e.message).join('; ')}`);
    }

    return json.data.allTransactions;
  }

  // First batch to get totalCount
  const first = await fetchBatch(0);
  const totalCount = first.totalCount;
  let allTxns = first.results;
  onBatch?.(1, allTxns.length, totalCount);

  // Remaining batches
  let offset = BATCH_SIZE;
  let batch = 2;
  while (offset < totalCount) {
    const result = await fetchBatch(offset);
    allTxns = allTxns.concat(result.results);
    onBatch?.(batch, allTxns.length, totalCount);
    offset += BATCH_SIZE;
    batch++;
  }

  return {
    transactions: allTxns,
    totalCount: allTxns.length,
    fetchedAt: new Date().toISOString(),
    mode: mode === 'full' ? 'full' : 'partial',
    startDate,
  };
}
