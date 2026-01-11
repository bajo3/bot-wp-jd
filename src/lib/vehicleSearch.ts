import { getBlueSellRate, moneyToARS, roundUp } from "@/lib/exchangeRate";

type SupabaseClient = any;

export type VehicleRow = {
  id: string;
  title?: string | null;
  brand?: string | null;
  model?: string | null;
  year?: number | null;
  price?: number | null;
  currency?: string | null; // 'ARS' | 'USD' | null
  pictures?: string[] | null;
  permalink?: string | null;
  km?: number | null;
  Km?: number | null;
  transmission?: string | null;
  Caja?: string | null;
  color?: string | null;
  status?: string | null;
  dealership_id?: string | null;
};

export type VehicleSuggestion = {
  id: string;
  title: string;
  year?: number | null;
  km?: number | null;
  permalink?: string | null;
  pictures?: string[] | null;
  transmission?: string | null;
  color?: string | null;
  currency_original: "ARS" | "USD";
  price_original: number;
  price_ars: number;
  // Kept for internal comparisons only. Do not show USD conversions unless the original price is USD.
  price_usd_approx: number;
};

export type SearchResult = {
  suggestions: VehicleSuggestion[];
  meta: {
    used_fallback_without_query: boolean;
    blue_sell: number;
  };
};

function normStr(x: any) {
  return String(x ?? "").trim().toLowerCase();
}

function tokenizeQuery(q: string): string[] {
  const clean = q
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  return clean.split(" ").filter(Boolean);
}

function matchesQuery(v: VehicleRow, terms: string[]): boolean {
  if (!terms.length) return true;
  const hay = [v.title, v.brand, v.model].map(normStr).join(" ");
  // All terms must match somewhere (AND). This reduces "false positives".
  return terms.every((t) => hay.includes(t));
}

function detectVehicleCurrency(v: VehicleRow): "ARS" | "USD" {
  const c = String(v.currency ?? "").toUpperCase().trim();
  if (c === "USD" || c === "U$S" || c === "US$" || c === "DOL" || c === "DOLARES") return "USD";
  if (c === "ARS" || c === "$" || c === "PESOS") return "ARS";

  // Heuristic for legacy rows:
  // - if price is "small" we treat it as USD (e.g. 18.000)
  const p = Number(v.price ?? 0);
  if (p > 0 && p < 1_000_000) return "USD";
  return "ARS";
}

function buildTitle(v: VehicleRow): string {
  const t = String(v.title ?? "").trim();
  if (t) return t;
  return `${String(v.brand ?? "").trim()} ${String(v.model ?? "").trim()}`.trim() || "(Sin título)";
}

function vehicleToSuggestion(v: VehicleRow, blueSell: number): VehicleSuggestion | null {
  const price = v.price == null ? null : Number(v.price);
  if (!price || !Number.isFinite(price) || price <= 0) return null;

  const currencyOriginal = detectVehicleCurrency(v);
  const priceARS = moneyToARS(price, currencyOriginal, blueSell);
  const priceUSDApprox = currencyOriginal === "USD" ? roundUp(price) : roundUp(priceARS / blueSell);

  const kmVal = (v.km ?? v.Km) != null ? Number(v.km ?? v.Km) : null;

  return {
    id: String(v.id),
    title: buildTitle(v),
    year: v.year ?? null,
    km: kmVal != null && Number.isFinite(kmVal) ? kmVal : null,
    permalink: v.permalink ?? null,
    pictures: Array.isArray(v.pictures) ? (v.pictures as any) : null,
    transmission: (v.transmission ?? v.Caja ?? null) as any,
    color: (v.color ?? null) as any,
    currency_original: currencyOriginal,
    price_original: price,
    price_ars: priceARS,
    price_usd_approx: priceUSDApprox,
  };
}

function parseBudgetFromLead(lead: any): { amount: number | null; currency: "ARS" | "USD" } {
  const currency = String(lead?.budget_currency ?? "ARS").toUpperCase() === "USD" ? "USD" : "ARS";
  const amount = lead?.budget_max ?? lead?.budget_min;
  if (amount != null && Number.isFinite(Number(amount))) {
    return { amount: Number(amount), currency };
  }

  // fallback: try to extract a number from budget_text
  const bt = String(lead?.budget_text ?? "");
  const m = bt.replace(/\./g, "").match(/(\d{1,3}(?:[\s,]\d{3})+|\d+)/);
  if (!m) return { amount: null, currency };
  const num = Number(m[0].replace(/[\s,]/g, ""));
  if (!Number.isFinite(num)) return { amount: null, currency };
  return { amount: num, currency };
}

export async function searchVehiclesClosest({
  supabase,
  lead,
  limit = 3,
}: {
  supabase: SupabaseClient;
  lead: any;
  limit?: number;
}): Promise<SearchResult> {
  const { sell: blueSell } = await getBlueSellRate(supabase, 120);

  // fetch
  let q = supabase
    .from("vehicles")
    .select(
      "id, title, brand, model, year, price, currency, pictures, permalink, km, Km, transmission, Caja, color, status, dealership_id"
    )
    .in("status", ["available", "active"]);

  const dealershipId = process.env.DEALERSHIP_ID;
  if (dealershipId) q = q.eq("dealership_id", dealershipId);

  const { data, error } = await q.limit(300);
  if (error) throw error;

  const vehicles: VehicleRow[] = (data ?? []) as any;

  const terms = tokenizeQuery(String(lead?.car_query ?? ""));
  const { amount: budgetAmount, currency: budgetCurrency } = parseBudgetFromLead(lead);

  const budgetARS = budgetAmount ? moneyToARS(budgetAmount, budgetCurrency, blueSell) : null;

  const toSuggestions = (rows: VehicleRow[]) =>
    rows
      .map((v) => vehicleToSuggestion(v, blueSell))
      .filter((x): x is VehicleSuggestion => Boolean(x));

  let filtered = vehicles;
  let usedFallbackWithoutQuery = false;

  if (terms.length) {
    const byQuery = vehicles.filter((v) => matchesQuery(v, terms));
    if (byQuery.length) filtered = byQuery;
    else usedFallbackWithoutQuery = true;
  }

  let suggestions = toSuggestions(filtered);
  if (!suggestions.length && usedFallbackWithoutQuery) {
    // nothing with query, fallback to all
    suggestions = toSuggestions(vehicles);
  }

  // if still empty, return empty
  if (!suggestions.length) {
    return {
      suggestions: [],
      meta: {
        used_fallback_without_query: usedFallbackWithoutQuery,
        blue_sell: blueSell,
      },
    };
  }

  // Budget-based sort
  if (budgetARS != null) {
    const target = budgetARS;
    suggestions.sort((a, b) => {
      const da = Math.abs(a.price_ars - target);
      const db = Math.abs(b.price_ars - target);
      if (da !== db) return da - db;
      // prefer closer but also cheaper if tie
      return a.price_ars - b.price_ars;
    });
  } else {
    // No budget: show cheapest first
    suggestions.sort((a, b) => a.price_ars - b.price_ars);
  }

  return {
    suggestions: suggestions.slice(0, Math.max(1, limit)),
    meta: {
      used_fallback_without_query: usedFallbackWithoutQuery,
      blue_sell: blueSell,
    },
  };
}

function formatARS(n: number) {
  return "$ " + Math.round(n).toLocaleString("es-AR");
}

function formatUSD(n: number) {
  return "USD " + Math.round(n).toLocaleString("en-US");
}

export function formatVehicleOptions(suggestions: VehicleSuggestion[], meta: SearchResult["meta"]) {
  if (!suggestions.length) {
    return {
      text: "Ahora mismo no veo autos cargados en stock.",
      suggestions: [] as VehicleSuggestion[],
    };
  }

  const header = meta.used_fallback_without_query
    ? "No encontré ese modelo exacto en stock, pero con tu presupuesto lo más cercano es:"
    : "Con tu presupuesto, las opciones más cercanas en stock son:";

  const lines = suggestions.map((v, i) => {
    const year = v.year ? ` ${v.year}` : "";
    const km = v.km != null ? ` • ${Math.round(v.km).toLocaleString("es-AR")} km` : "";

    // Price display policy:
    // - Show ARS always.
    // - Only mention USD if the ORIGINAL price is USD.
    const priceLine =
      v.currency_original === "USD"
        ? `${formatUSD(v.price_original)} (≈ ${formatARS(v.price_ars)})`
        : `${formatARS(v.price_ars)}`;

    return `${i + 1}) ${v.title}${year}${km}\n${priceLine}`;
  });

  return {
    text: `${header}\n\n${lines.join("\n\n")}`,
    suggestions,
  };
}
