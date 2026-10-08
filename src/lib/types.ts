export type Category =
  | 'lodging'
  | 'connectivity'
  | 'transport'
  | 'meals'
  | 'office'
  | 'entertainment'
  | 'subscription'
  | 'gaming'
  | 'other';

/** What the business owner allows its agents to do with company money. */
export interface CompanyPolicy {
  id: string;
  company: string;
  travel_budget: number;
  hotel_limit: number;
  /** purchases at or below this are paid without asking a manager */
  auto_pay_limit: number;
  allowed_categories: Category[];
  blocked_categories: Category[];
  created_at: string;
}

/** How auto-pay reaches PayPal: a billing agreement the owner approved once. */
export interface AutoPay {
  connected: boolean;
  mode: 'sandbox' | 'mock';
  agreement_id: string | null;
}

export type AgentRole = 'travel' | 'hotel' | 'booking' | 'experience' | 'custom' | 'recovery';

export type AiSource = 'jev' | 'cached';

export interface Restriction {
  label: string;
  category: Category;
}

export interface Intent {
  id: string;
  status: 'DRAFT' | 'ACTIVE';
  prompt: string;
  goal: string;
  purpose: 'business' | 'leisure';
  purpose_detail: string;
  location: string;
  budget: number;
  currency: 'USD';
  category_caps: Partial<Record<Category, number>>;
  restrictions: Restriction[];
  trip_start: string;
  trip_end: string;
  nights: number;
  source: AiSource;
  created_at: string;
}

export interface DelegationScope {
  location: string;
  from: string;
  to: string;
  categories?: Category[];
}

export interface Delegation {
  id: string;
  intent_id: string;
  parent: string; // 'human' or a parent delegation id
  from: 'human' | AgentRole;
  agent: AgentRole;
  purpose: string;
  budget: number;
  category_caps?: Partial<Record<Category, number>>;
  per_night?: number;
  scope: DelegationScope;
  expires_at: string;
  single_use: boolean;
  status: 'ACTIVE' | 'USED' | 'EXPIRED' | 'REVOKED';
  paypal_tools: string[];
  /** HMAC over this grant's constraints and its parent's signature */
  signature: string;
  /** how faithfully this grant's purpose stays within the human intent, 0–100 */
  fidelity?: { score: number; source: AiSource };
  /** true when the purpose has drifted away from the human intent */
  drift?: boolean;
  created_at: string;
}

export interface Violation {
  /** who introduced the problem: an agent, or a delegation hop */
  source: string;
  type: string;
  delegation_id: string | null;
}

export interface CatalogItem {
  id: string;
  name: string;
  merchant: string;
  description: string;
  amount: number;
  category: Category;
  location: string;
  /** days after trip start on which the purchase is used */
  day_offset: number;
  nights?: number;
  /** reference alignment score for a business trip (used when the AI is offline) */
  reference_score?: number;
}

export interface Check {
  pass: boolean;
  detail: string;
}

export interface IntentCheck {
  status: 'pass' | 'warning' | 'fail' | 'skipped';
  score: number | null;
  detail: string;
  restriction: string | null;
  source: AiSource | null;
}

export interface Validation {
  /** company policy: is this kind of purchase allowed at all? */
  policy: Check;
  budget: Check;
  authority: Check;
  scope: Check;
  intent: IntentCheck;
  decision: 'APPROVED' | 'WARNING' | 'BLOCKED';
  reason_code:
    | 'OK'
    | 'POLICY_VIOLATION'
    | 'INTENT_DRIFT'
    | 'AUTHORITY_EXCEEDED'
    | 'BUDGET_EXCEEDED'
    | 'OUT_OF_SCOPE'
    | 'INTENT_MISMATCH'
    | 'NEEDS_HUMAN_REVIEW'
    | 'REJECTED_BY_HUMAN';
  headline: string;
  /** set on anything that is not approved: where in the chain it went wrong */
  violation?: Violation;
  /** number of signed delegation hops verified for this transaction */
  chain_hops?: number;
  /** for an approved purchase: paid automatically, or held for a manager */
  payment_route?: 'AUTO_PAY' | 'MANAGER_APPROVAL';
}

export type TxStatus =
  | 'BLOCKED'
  | 'WARNING'
  | 'APPROVED'
  | 'ORDER_CREATED'
  | 'CAPTURED'
  | 'PAYMENT_FAILED'
  | 'OUTCOME_FAILED'
  | 'REFUNDED'
  | 'REFUND_FAILED';

export interface Payment {
  mode: 'sandbox' | 'mock';
  /** auto-pay through the billing agreement, or a checkout the manager approves in PayPal */
  via?: 'billing_agreement' | 'checkout';
  order_id?: string;
  approve_url?: string | null;
  capture_id?: string;
  /** PayPal's own status for the capture, e.g. COMPLETED or PENDING */
  capture_status?: string;
  refund_id?: string;
  error?: string;
}

export interface Transaction {
  id: string;
  intent_id: string;
  agent: AgentRole;
  delegation_id: string | null;
  item: CatalogItem;
  decision_id?: string;
  validation: Validation;
  status: TxStatus;
  payment?: Payment;
  created_at: string;
  updated_at: string;
}

export interface DecisionOption {
  item: CatalogItem;
  minutes_to_meeting: number;
  refundable: boolean;
  outcome: 'SELECTED' | 'REJECTED';
  reason: string;
}

export interface Decision {
  id: string;
  intent_id: string;
  agent: AgentRole;
  question: string;
  options: DecisionOption[];
  selected_item_id: string;
  because: string[];
  source: AiSource;
  created_at: string;
}

export interface Recovery {
  id: string;
  intent_id: string;
  failed_transaction_id: string;
  status: 'REQUIRED' | 'AWAITING_HUMAN';
  proposal?: {
    item: CatalogItem;
    validation: Validation;
    reason: string;
    source: AiSource;
  };
  created_at: string;
}

export interface AuditEvent {
  seq: number;
  id: string;
  type: string;
  intent_id: string | null;
  transaction_id: string | null;
  actor: string;
  at: string;
  data: Record<string, unknown>;
}

export interface Metrics {
  budget: number;
  spent: number;
  remaining: number;
  intent_integrity: number | null;
  authority_integrity: number | null;
  outcome_status: 'No payments yet' | 'On Track' | 'Recovery Active';
}

export interface AppState {
  intent: Intent | null;
  delegations: Delegation[];
  transactions: Transaction[];
  decisions: Decision[];
  recoveries: Recovery[];
  events: AuditEvent[];
  metrics: Metrics | null;
  policy: CompanyPolicy;
  autopay: AutoPay;
  /** grant tokens for the agent gateway, by delegation id */
  grant_tokens: Record<string, string>;
  config: {
    paypal_mode: 'sandbox' | 'mock';
    ai_mode: 'live' | 'cached';
    demo_mode: boolean;
  };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
