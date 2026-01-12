/*
  CreditCar quote helper.

  Endpoint provided by user:
    https://api.cotizadorcreditcar.com.ar/2?monto=M&modelo=YYYY

  We treat the response as JSON but remain defensive to format changes.
*/

export type CreditCarQuote = {
  raw: any;
  summaryText: string;
  selected?: { plazo: number; cuota: number; inclusion?: any };
};

function parseNumberLoose(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).replace(/\./g, "").replace(/,/g, ".").trim(); // handles 521400.00 or 521.400,00
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function selectOption(raw: any, term?: number): { plazo: number; cuota: number; inclusion?: any } | null {
  if (!term || !Array.isArray(raw)) return null;
  const candidates = raw
    .map((o: any) => {
      const plazo = parseNumberLoose(o?.plazo ?? o?.meses ?? o?.cantidad_cuotas ?? o?.cuotas);
      const cuota = parseNumberLoose(o?.cuota ?? o?.cuota_mensual ?? o?.cuotaMensual ?? o?.valor_cuota);
      if (!plazo || !cuota) return null;
      return { plazo: Math.round(plazo), cuota, inclusion: o?.inclusion ?? null };
    })
    .filter(Boolean) as Array<{ plazo: number; cuota: number; inclusion?: any }>;
  const exact = candidates.find((c) => c.plazo === term);
  return exact ?? null;
}

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


function summarizeText(rawText: string): string {
  // Try to extract cuota/plazo numbers from plain text/HTML.
  const text = rawText.replace(/\s+/g, " ").trim();
  // Common patterns: "24 cuotas" and "cuota 123.456"
  const plazoMatch = text.match(/(\d{1,3})\s*(cuotas|meses)/i);
  const cuotaMatch = text.match(/cuota\s*(aprox\.?|mensual)?\s*[:\-]?\s*\$?\s*([\d\.\,]+)/i);
  const parts: string[] = [];
  if (plazoMatch) parts.push(`${plazoMatch[1]} cuotas`);
  if (cuotaMatch) parts.push(`cuota aprox. ${cuotaMatch[2]}`);
  if (parts.length) return parts.join(" — ");
  // Last resort: return a short snippet so we know something came back.
  return text.slice(0, 140) + (text.length > 140 ? "…" : "");
}

function summarize(raw: any): string {
  if (typeof raw === "string") return summarizeText(raw);

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

export async function getCreditCarQuote(params: { montoARS: number; modeloYear?: number; term?: number }): Promise<CreditCarQuote | null> {
  const { montoARS } = params;
  const rawYear = params.modeloYear ?? new Date().getFullYear();
  const modeloYear = Math.max(2012, Number(rawYear) || 2012);
  const term = params.term;

  const url = `https://api.cotizadorcreditcar.com.ar/2?monto=${encodeURIComponent(String(montoARS))}&modelo=${encodeURIComponent(
    String(modeloYear)
  )}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "Mozilla/5.0 (compatible; JD-AutoBot/1.0)",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        raw: { status: res.status, statusText: res.statusText, body: txt.slice(0, 600) },
        summaryText: txt ? summarizeText(txt) : `No se pudo consultar CreditCar (HTTP ${res.status}).`,
      };
    }

    const contentType = res.headers.get("content-type") || "";
    let raw: any;

    if (contentType.includes("application/json")) {
      raw = await res.json();
    } else {
      const txt = await res.text();
      try {
        raw = JSON.parse(txt);
      } catch {
        raw = txt;
      }
    }

    // If it returns a list of options with plazo/cuotas, try to pick the closest to the requested term.
    if (term && Array.isArray(raw)) {
      const withPlazo = raw
        .map((o: any) => {
          const plazo = Number(o?.plazo ?? o?.meses ?? o?.cantidad_cuotas ?? o?.cuotas ?? NaN);
          return { o, plazo };
        })
        .filter((x: any) => Number.isFinite(x.plazo));

      if (withPlazo.length) {
        withPlazo.sort((a: any, b: any) => Math.abs(a.plazo - term) - Math.abs(b.plazo - term));
        raw = [withPlazo[0].o, ...withPlazo.slice(1, 3).map((x: any) => x.o)];
      }
    }

    const selected = selectOption(raw, term);
    const summaryText = selected
      ? `• ${selected.plazo} cuotas — cuota aprox. ${Math.round(selected.cuota).toLocaleString("es-AR")}`
      : summarize(raw);

    return {
      raw,
      summaryText,
      selected: selected ?? undefined,
    };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "timeout" : String(e?.message || e);
    return {
      raw: { error: msg },
      summaryText: `No se pudo consultar CreditCar (${msg}).`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
