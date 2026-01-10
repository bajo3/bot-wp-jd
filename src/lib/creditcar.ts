/*
  CreditCar quote helper.

  Endpoint provided by user:
    https://api.cotizadorcreditcar.com.ar/2?monto=M&modelo=YYYY

  We treat the response as JSON but remain defensive to format changes.
*/

export type CreditCarQuote = {
  raw: any;
  summaryText: string;
};

function pickNumbers(obj: any): number[] {
  const nums: number[] = [];
  const stack: any[] = [obj];
  const visited = new Set<any>();

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (visited.has(cur)) continue;
    visited.add(cur);

    for (const v of Object.values(cur)) {
      if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
      else if (typeof v === "string") {
        const m = v.replace(/\./g, "").replace(/,/g, ".").match(/-?\d+(?:\.\d+)?/g);
        if (m) {
          for (const s of m) {
            const n = Number(s);
            if (Number.isFinite(n)) nums.push(n);
          }
        }
      } else if (v && typeof v === "object") stack.push(v);
    }
  }

  return nums;
}

function summarize(raw: any): string {
  // Heuristic summary:
  // - If it returns an array of options, show up to 3 lines.
  if (Array.isArray(raw)) {
    const lines = raw
      .slice(0, 3)
      .map((o, i) => {
        const cuota = o?.cuota ?? o?.cuota_mensual ?? o?.cuotaMensual ?? o?.valor_cuota ?? null;
        const plazo = o?.plazo ?? o?.meses ?? o?.cantidad_cuotas ?? o?.cuotas ?? null;
        const tasa = o?.tna ?? o?.tea ?? o?.tasa ?? null;
        const parts = [];
        if (plazo) parts.push(`${plazo} cuotas`);
        if (cuota) parts.push(`cuota aprox. ${Number(cuota).toLocaleString("es-AR")}`);
        if (tasa) parts.push(`tasa ${tasa}`);
        return `• Opción ${i + 1}: ${parts.filter(Boolean).join(" — ")}`.trim();
      })
      .filter(Boolean);
    if (lines.length) return lines.join("\n");
  }

  // If it's an object, try common fields.
  const cuota = raw?.cuota ?? raw?.cuota_mensual ?? raw?.cuotaMensual ?? raw?.valor_cuota ?? null;
  const plazo = raw?.plazo ?? raw?.meses ?? raw?.cantidad_cuotas ?? raw?.cuotas ?? null;
  if (cuota || plazo) {
    const parts = [];
    if (plazo) parts.push(`${plazo} cuotas`);
    if (cuota) parts.push(`cuota aprox. ${Number(cuota).toLocaleString("es-AR")}`);
    return parts.join(" — ");
  }

  // Last resort: show a conservative numeric hint.
  const nums = pickNumbers(raw)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  if (nums.length) {
    // Pick a mid-ish number to avoid showing extreme totals.
    const pick = nums[Math.min(nums.length - 1, Math.floor(nums.length / 2))];
    return `Simulación disponible (dato numérico detectado: ${pick.toLocaleString("es-AR")}).`;
  }

  return "Simulación disponible.";
}

export async function getCreditCarQuote(params: { montoARS: number; modeloYear?: number }): Promise<CreditCarQuote | null> {
  const { montoARS } = params;
  const modeloYear = params.modeloYear ?? new Date().getFullYear();
  const url = `https://api.cotizadorcreditcar.com.ar/2?monto=${encodeURIComponent(String(montoARS))}&modelo=${encodeURIComponent(
    String(modeloYear)
  )}`;

  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return null;
    const raw = await res.json();
    return {
      raw,
      summaryText: summarize(raw),
    };
  } catch {
    return null;
  }
}
