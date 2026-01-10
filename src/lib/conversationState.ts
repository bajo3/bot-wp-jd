export type ConversationState =
  | "START"
  | "AWAITING_BUDGET"
  | "AWAITING_CAR"
  | "AWAITING_CHOICE"
  | "AWAITING_FINANCE"
  | "AWAITING_TRADE_IN"
  | "HANDED_OFF";

export function nextQuestionFromMissing(missing: string[]): ConversationState {
  if (missing.includes("budget")) return "AWAITING_BUDGET";
  if (missing.includes("car_query")) return "AWAITING_CAR";
  if (missing.includes("finance")) return "AWAITING_FINANCE";
  if (missing.includes("trade_in")) return "AWAITING_TRADE_IN";
  return "START";
}

export function isTerminal(state?: string | null) {
  return state === "HANDED_OFF";
}
