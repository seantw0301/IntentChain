'use client';

import { useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule,
  ModuleRegistry,
  colorSchemeDarkBlue,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
} from 'ag-grid-community';
import type { AppState, Transaction } from '@/lib/types';

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withPart(colorSchemeDarkBlue).withParams({
  backgroundColor: '#0f1730',
  foregroundColor: '#e8edff',
  headerBackgroundColor: '#16203f',
  borderColor: '#24325c',
  accentColor: '#6b93ff',
  fontSize: 13,
  headerFontSize: 12,
  spacing: 6,
});

interface Row {
  id: string;
  time: string;
  agent: string;
  item: string;
  amount: number;
  policy: string;
  budget: string;
  authority: string;
  scope: string;
  intent: string;
  result: string;
  via: string;
  paypal: string;
}

function result(t: Transaction): string {
  switch (t.status) {
    case 'CAPTURED': return t.payment?.via === 'vault' ? 'Auto-paid' : 'Manager approved';
    case 'APPROVED':
    case 'ORDER_CREATED': return 'Awaiting manager';
    case 'WARNING': return 'Human review';
    case 'REFUNDED': return 'Outcome failed · refunded';
    case 'OUTCOME_FAILED': return 'Outcome failed';
    case 'BLOCKED': return `Blocked · ${t.validation.reason_code.replace(/_/g, ' ').toLowerCase()}`;
    default: return t.status.replace(/_/g, ' ').toLowerCase();
  }
}

const verdict = (pass: boolean | undefined) => (pass === undefined ? '—' : pass ? 'PASS' : 'FAIL');

/** PASS / FAIL / REVIEW as a coloured tag. */
function Verdict(p: ICellRendererParams<Row, string>) {
  const v = p.value ?? '';
  if (p.node.rowPinned) return null;
  const tone = v.startsWith('PASS') ? 'ok' : v.startsWith('FAIL') ? 'no' : v.startsWith('REVIEW') ? 'wait' : '';
  return <span className={`ledger-tag ${tone}`}>{v}</span>;
}

/** The company ledger: every purchase an agent proposed, with the firewall's verdict on each check. */
export default function LedgerGrid({
  state,
  focus,
  onFocus,
}: {
  state: AppState;
  focus: string | null;
  onFocus: (id: string) => void;
}) {
  const grid = useRef<AgGridReact<Row>>(null);
  const [search, setSearch] = useState('');

  const rows = useMemo<Row[]>(
    () =>
      state.transactions.map((t) => {
        const v = t.validation;
        const grant = state.delegations.find((d) => d.id === t.delegation_id);
        return {
          id: t.id,
          time: new Date(t.created_at).toLocaleTimeString('en-GB'),
          agent: grant?.label ?? t.agent,
          item: t.item.name,
          amount: t.item.amount,
          policy: verdict(v.policy?.pass),
          budget: verdict(v.budget.pass),
          authority: verdict(v.authority.pass),
          scope: verdict(v.scope.pass),
          intent:
            v.intent.status === 'skipped'
              ? '—'
              : `${{ pass: 'PASS', fail: 'FAIL', warning: 'REVIEW' }[v.intent.status]} ${v.intent.score ?? ''}`.trim(),
          result: result(t),
          via: t.payment?.via === 'vault' ? 'PayPal Vault' : t.payment?.via === 'checkout' ? 'Checkout' : '',
          paypal: t.payment?.refund_id ?? t.payment?.capture_id ?? t.payment?.order_id ?? '',
        };
      }),
    [state.transactions, state.delegations],
  );

  const columns = useMemo<ColDef<Row>[]>(
    () => [
      { field: 'item', headerName: 'Purchase', flex: 3, minWidth: 170 },
      {
        field: 'amount',
        headerName: 'Amount',
        flex: 1,
        minWidth: 84,
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        valueFormatter: (p) => (p.value == null ? '' : `$${p.value}`),
      },
      { field: 'agent', headerName: 'Agent', flex: 2, minWidth: 120 },
      { field: 'policy', headerName: 'Policy', flex: 1, minWidth: 74, cellRenderer: Verdict },
      { field: 'budget', headerName: 'Budget', flex: 1, minWidth: 74, cellRenderer: Verdict },
      { field: 'authority', headerName: 'Authority', flex: 1, minWidth: 84, cellRenderer: Verdict },
      { field: 'scope', headerName: 'Scope', flex: 1, minWidth: 70, cellRenderer: Verdict },
      { field: 'intent', headerName: 'Intent', flex: 1, minWidth: 84, cellRenderer: Verdict },
      { field: 'result', headerName: 'Result', flex: 3, minWidth: 170 },
      { field: 'paypal', headerName: 'PayPal reference', flex: 2, minWidth: 150, cellClass: 'ledger-mono' },
      // kept out of view by default, still searchable and included in the CSV export
      { field: 'time', headerName: 'Time', hide: true },
      { field: 'via', headerName: 'Paid via', hide: true },
    ],
    [],
  );

  const totals = useMemo<Row[]>(
    () => [
      {
        id: 'total',
        time: '',
        agent: '',
        item: 'Paid, net of refunds',
        amount: state.metrics?.spent ?? 0,
        policy: '',
        budget: '',
        authority: '',
        scope: '',
        intent: '',
        result: `${state.transactions.filter((t) => t.status === 'BLOCKED').length} blocked before reaching PayPal`,
        via: '',
        paypal: '',
      },
    ],
    [state.metrics, state.transactions],
  );

  return (
    <div className="ledger">
      <div className="row" style={{ marginBottom: 8 }}>
        <input
          type="text"
          placeholder="Search the ledger…"
          aria-label="Search the ledger"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: '1 1 200px' }}
        />
        <button
          className="btn small"
          onClick={() => grid.current?.api.exportDataAsCsv({ fileName: `intentchain-ledger-${state.intent?.id ?? 'export'}.csv`, allColumns: true })}
        >
          Export CSV
        </button>
      </div>
      <AgGridReact<Row>
        ref={grid}
        theme={theme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: true, filter: true, resizable: true }}
        getRowId={(p) => p.data.id}
        domLayout="autoHeight"
        quickFilterText={search}
        pinnedBottomRowData={totals}
        rowClassRules={{ 'ledger-focus': (p) => p.data?.id === focus }}
        onRowClicked={(e) => e.data && !e.node.rowPinned && onFocus(e.data.id)}
        suppressCellFocus
      />
    </div>
  );
}
