export type AssetClassCode =
  "cash" | "fund" | "stock" | "alternative" | "unclassified";

export interface AllocationItem {
  code: string | number;
  label: string;
  valueCny: number;
  costValueCny?: number;
  profitCny?: number;
  profitPercent?: number;
  count: number;
  percent: number;
  color?: string;
}

export interface ValuedAsset {
  id: number;
  code: string;
  name: string;
  shares: number;
  costPrice: number;
  currentPrice: number | null;
  quoteCode?: string | null;
  quantityStatus: "missing" | "estimated" | "verified";
  valuationMode: "units" | "position_value";
  importedMarketValue?: number | null;
  importedCostValue?: number | null;
  valuationAsOf?: string | null;
  valuationBasis: "unit_price" | "imported_position";
  currency: string;
  marketValueCny: number;
  costValueCny: number;
  profitCny: number;
  profitPercent: number;
  accountId: number;
  accountName: string;
  assetTypeId: number;
  assetType: string;
  classCode: AssetClassCode;
  classLabel: string;
  subtypeCode: string;
  subtypeLabel: string;
  quote: {
    status: string;
    fetchedAt?: string | null;
    source?: string | null;
    error?: string | null;
  };
  dataQuality: {
    status: "ready" | "attention" | "blocked";
    label: string;
    issues: string[];
  };
}

export interface HouseholdSummary {
  month: string;
  totals: {
    income: number;
    expense: number;
    net: number;
    plannedExpense: number;
    remainingBudget: number;
  };
  budgets: Array<{
    id: number;
    categoryId: number;
    categoryName: string;
    kind: "income" | "expense";
    color: string;
    planned: number;
    actual: number;
    remaining: number;
    percent: number;
  }>;
  recentTransactions: HouseholdTransaction[];
  projects: HouseholdProject[];
  memos: FinancialMemo[];
}

export interface HouseholdPlan {
  settings: {
    openingAmount: number;
    openingCurrencyId: number;
    openingCurrencyCode: string;
    planningRateToCny: number;
    startMonth: string;
    endMonth: string;
  };
  totals: {
    openingBalanceCny: number;
    plannedIncomeCny: number;
    plannedExpenseCny: number;
    memoIncomeCny: number;
    memoExpenseCny: number;
    projectedClosingBalanceCny: number;
    firstNegativeMonth?: string | null;
  };
  months: Array<{
    month: string;
    status: "actual" | "current" | "forecast";
    openingBalanceCny: number;
    plannedIncomeCny: number;
    plannedExpenseCny: number;
    actualIncomeCny: number;
    actualExpenseCny: number;
    memoIncomeCny: number;
    memoExpenseCny: number;
    projectedNetCny: number;
    closingBalanceCny: number;
  }>;
}

export interface HouseholdTransaction {
  id: number;
  kind: "income" | "expense";
  amount: number;
  amount_cny: number;
  currency_id: number;
  fx_rate_to_cny: number;
  currency_code: string;
  category_id: number;
  category_name: string;
  category_color: string;
  account_id?: number | null;
  account_name?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  occurred_on: string;
  note?: string;
  linked_cash_flow_id?: number | null;
}

export interface HouseholdProject {
  id: number;
  name: string;
  target_amount_cny: number;
  spent_cny: number;
  remaining_cny: number;
  progress: number;
  start_date?: string;
  end_date?: string;
  status: "planned" | "active" | "completed" | "cancelled";
  note?: string;
}

export interface FinancialMemo {
  id: number;
  kind: "income" | "expense";
  title: string;
  expected_amount: number;
  currency_code: string;
  due_date: string;
  reminder_days: number;
  category_id?: number | null;
  account_id?: number | null;
  status?: "pending" | "completed" | "cancelled";
  display_status: "pending" | "upcoming" | "overdue";
  days_until: number;
  note?: string;
}

export interface DashboardData {
  asOf: string;
  baseCurrency: "CNY";
  totals: {
    marketValueCny: number;
    costValueCny: number;
    profitCny: number;
    profitPercent: number;
    assetCount: number;
    accountCount: number;
  };
  allocations: { byClass: AllocationItem[]; byAccount: AllocationItem[] };
  trend: Array<{
    date: string;
    value: number;
    cost: number;
    profit: number;
    cashFlow: number;
  }>;
  topAccounts: AllocationItem[];
  recentAssets: ValuedAsset[];
  freshness: {
    staleCount: number;
    totalCount: number;
    market: { state: string; finishedAt?: string | null };
  };
  household: HouseholdSummary;
}

export interface MetaData {
  currencies: Array<{ id: number; code: string }>;
  assetTypes: Array<{
    id: number;
    name: string;
    asset_class_code: AssetClassCode;
    asset_subtype_code: string;
  }>;
  categories: Array<{
    id: number;
    name: string;
    kind: "income" | "expense";
    color: string;
    icon: string;
  }>;
  accounts: Array<{
    id: number;
    name: string;
    account_type: string;
    default_currency_id?: number;
  }>;
  accountTypes: Array<{ code: string; label: string }>;
}
