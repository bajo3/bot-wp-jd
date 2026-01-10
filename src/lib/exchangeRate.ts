/*
  Exchange rate helper (USD blue) with DB cache.

  Requirements implemented:
  - Use only "blue"
  - Use the more expensive value (sell / venta)
  - Cache for 2 hours (configurable)
  - Round "up" in conversions
*/

type SupabaseClient = any;

export type BlueRate = {
  sell: number;
  buy?: number;
  source: string;
  updatedAt: string; // ISO
};

const DEFAULT_MAX_AGE_MINUTES = 120;

function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function toNumber(x: any): number | null {
  if (isFiniteNumber(x)) return x;
  if (typeof x === "string") {
    const n = Number(x.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function fetchBlueFromDolarApi(): Promise<BlueRate | null> {
  // https://dolarapi.com/v1/dolares/blue
  const url = "https://dolarapi.com/v1/dolares/blue";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const json = await res.json();
  const sell = toNumber(json?.venta);
  const buy = toNumber(json?.compra);
  const updatedAt = (typeof json?.fechaActualizacion === "string" && json.fechaActualizacion) || new Date().toISOString();
  if (!sell) return null;
  return { sell, buy: buy ?? undefined, source: "dolarapi", updatedAt };
}

async function fetchBlueFromBluelytics(): Promise<BlueRate | null> {
  // https://api.bluelytics.com.ar/v2/latest
  const url = "https://api.bluelytics.com.ar/v2/latest";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const json = await res.json();
  const sell = toNumber(json?.blue?.value_sell);
  const buy = toNumber(json?.blue?.value_buy);
  if (!sell) return null;
  return { sell, buy: buy ?? undefined, source: "bluelytics", updatedAt: new Date().toISOString() };
}

async function fetchBlueFromArgentinaDatos(): Promise<BlueRate | null> {
  // https://api.argentinadatos.com/v1/cotizaciones/dolares/blue
  const url = "https://api.argentinadatos.com/v1/cotizaciones/dolares/blue";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const json = await res.json();
  const sell = toNumber(json?.venta);
  const buy = toNumber(json?.compra);
  const updatedAt = (typeof json?.fecha === "string" && json.fecha) || new Date().toISOString();
  if (!sell) return null;
  return { sell, buy: buy ?? undefined, source: "argentinadatos", updatedAt };
}

async function fetchBlueRate(): Promise<BlueRate> {
  const providers = [fetchBlueFromDolarApi, fetchBlueFromBluelytics, fetchBlueFromArgentinaDatos];
  let lastErr: any = null;
  for (const fn of providers) {
    try {
      const r = await fn();
      if (r?.sell) return r;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Unable to fetch blue rate");
}

function minutesAgoISO(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

export async function getBlueSellRate(supabase: SupabaseClient, maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES): Promise<BlueRate> {
  // DB cache
  const { data: row } = await supabase
    .from("exchange_rates")
    .select("id, sell, buy, source, updated_at")
    .eq("id", "blue")
    .maybeSingle();

  const updatedAt = row?.updated_at ? String(row.updated_at) : null;
  const sell = toNumber(row?.sell);
  if (sell && updatedAt) {
    const ageMs = Date.now() - new Date(updatedAt).getTime();
    if (ageMs >= 0 && ageMs <= maxAgeMinutes * 60 * 1000) {
      return {
        sell,
        buy: toNumber(row?.buy) ?? undefined,
        source: row?.source ?? "cache",
        updatedAt,
      };
    }
  }

  // refresh
  const fresh = await fetchBlueRate();
  await supabase
    .from("exchange_rates")
    .upsert(
      {
        id: "blue",
        sell: fresh.sell,
        buy: fresh.buy ?? null,
        source: fresh.source,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );

  return { ...fresh, updatedAt: new Date().toISOString() };
}

// Conversions (always round UP)
export function arsToUsdCeil(ars: number, blueSell: number): number {
  if (!Number.isFinite(ars) || !Number.isFinite(blueSell) || blueSell <= 0) return NaN;
  return Math.ceil(ars / blueSell);
}

export function usdToArsCeil(usd: number, blueSell: number): number {
  if (!Number.isFinite(usd) || !Number.isFinite(blueSell) || blueSell <= 0) return NaN;
  return Math.ceil(usd * blueSell);
}

export function roundUp(n: number): number {
  return Math.ceil(Number(n));
}

export function moneyToARS(amount: number, currency: "ARS" | "USD", blueSell: number): number {
  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) return NaN;
  return currency === "USD" ? usdToArsCeil(a, blueSell) : roundUp(a);
}
