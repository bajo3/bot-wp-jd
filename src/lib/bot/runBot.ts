/*
  Bot core (improved):

  Goals implemented:
  - One question per message (no "se queda" con 2 preguntas juntas)
  - Vehicles search is "budget aware" (ARS/USD) using Dólar Blue SELL (venta)
  - Always returns the 3 closest vehicles by price (even if outside budget)
  - Supports numeric selection (1/2/3) with stored suggestions
  - Integrates CreditCar quote when financing
  - Keeps handoff-outbox in bot_runs (provider-agnostic)
*/

import { searchVehiclesClosest, formatVehicleOptions, type VehicleSuggestion } from "@/lib/vehicleSearch";
import { getCreditCarQuote } from "@/lib/creditcar";

type LeadRow = any;

export type BotResult = {
  replyText?: string;
  decision: string;
  extracted?: any;
};

function looksLikeGreetingOnly(t: string) {
  const s = t.trim().toLowerCase();
  return ["hola", "buenas", "buen día", "buen dia", "que tal", "👋"].includes(s);
}

function hasAdvisorKeyword(t: string) {
  const s = t.toLowerCase();
  return s.includes("hablar con asesor") || s.includes("asesor") || s.includes("vendedor") || s.includes("humano");
}

function normalizeYesNo(text: string): "yes" | "no" | "maybe" | null {
  const s = text.toLowerCase();
  if (/(contado|efectivo|de contado|transferencia|cash)/.test(s)) return "no";
  if (/(finan|cr[eé]dito|cuota|cuotas|plan|pr[eé]stamo)/.test(s)) return "yes";
  if (/(capaz|puede ser|tal vez|no se|depende)/.test(s)) return "maybe";
  if (/\b(si|sí|sisi|sii)\b/.test(s)) return "yes";
  if (/\b(no|nop)\b/.test(s)) return "no";
  return null;
}

function parseChoice(text: string): 1 | 2 | 3 | null {
  const m = text.trim().match(/^([1-3])\b/);
  if (!m) return null;
  return Number(m[1]) as 1 | 2 | 3;
}

function missingRequired(lead: LeadRow) {
  const missing: string[] = [];
  if (!lead.intent) missing.push("intent");
  if (!lead.budget_min && !lead.budget_max && !lead.budget_text) missing.push("budget");
  if (!lead.car_query) missing.push("car_query");
  if (!lead.finance) missing.push("finance");
  if (!lead.trade_in) missing.push("trade_in");
  return missing;
}

async function pickNextAgent(supabase: any) {
  const cursorId = process.env.AGENCY_CURSOR_ID ?? "jesus_diaz";

  const { data: agents, error: agentsErr } = await supabase
    .from("agents")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  if (agentsErr) throw agentsErr;
  if (!agents?.length) throw new Error("No active agents");

  const { data: cursor } = await supabase
    .from("agent_assignment_cursor")
    .select("*")
    .eq("id", cursorId)
    .single();

  const lastId = (cursor?.last_agent_id as string | null) ?? null;
  const idx = Math.max(0, agents.findIndex((a: any) => a.id === lastId));
  const next = agents[(idx + 1) % agents.length];

  await supabase
    .from("agent_assignment_cursor")
    .update({ last_agent_id: next.id, updated_at: new Date().toISOString() })
    .eq("id", cursorId);

  return next as { id: string; name: string; phone_e164: string };
}

async function saveBotRun(supabase: any, leadId: string, decision: string, extracted?: any) {
  await supabase.from("bot_runs").insert({
    lead_id: leadId,
    decision,
    extracted: extracted ?? null,
    model_used: process.env.OPENAI_MODEL ?? null,
  });
}

async function saveOutboxToBotRuns(supabase: any, leadId: string, payload: any) {
  await supabase.from("bot_runs").insert({
    lead_id: leadId,
    decision: "notify_agent_outbox",
    extracted: payload,
    model_used: process.env.OPENAI_MODEL ?? null,
  });
}

async function notifyAgentOutbox(
  supabase: any,
  agent: any,
  lead: any,
  lastUserText: string,
  extra?: any
) {
  const payload = {
    agentPhoneE164: agent.phone_e164,
    summary: {
      phone: lead.phone_e164,
      name: lead.name,
      intent: lead.intent,
      budget_min: lead.budget_min,
      budget_max: lead.budget_max,
      budget_text: lead.budget_text,
      budget_currency: lead.budget_currency,
      car_query: lead.car_query,
      finance: lead.finance,
      trade_in: lead.trade_in,
      urgency: lead.urgency,
      lead_quality: lead.lead_quality,
      selected_vehicle: lead.selected_vehicle ?? null,
      lastUserText,
      ...extra,
    },
    action: {
      type: "agent_should_contact_client_from_own_whatsapp",
      wa_me_link: `https://wa.me/${String(lead.phone_e164).replace("+", "")}`,
    },
  };

  const leadId = lead?.id;
  if (!leadId) throw new Error("notifyAgentOutbox: lead.id missing");

  await saveOutboxToBotRuns(supabase, leadId, payload);
}




async function extractWithLLM(incomingText: string, lead: LeadRow) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL ?? "gpt-5.2-mini";
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const system = `
Sos un extractor de datos de leads de una agencia de autos.
Devolvé SOLO JSON válido con estas claves:

intent, budget_min, budget_max, budget_text, budget_currency, car_query, finance, trade_in, urgency, lead_quality, wants_catalog

Reglas:
- No inventes.
- intent: "buy" | "sell" | "trade" | null
- budget_*: numérico SIEMPRE (sin símbolos) en la moneda indicada por budget_currency.
- budget_currency: "ARS" | "USD" | null. Si el usuario menciona dólares/usd/u$s => USD.
- Si no se puede parsear un número, usar budget_text.
- finance y trade_in: "yes"|"no"|"maybe"|null
- urgency: "low"|"medium"|"high"|null
- lead_quality: "low"|"medium"|"high"|null
- wants_catalog true si pide ver autos/opciones/catálogo/modelos o si pregunta "qué tenés".
`;

  const user = `
Mensaje: ${incomingText}
Lead actual (puede estar incompleto): ${JSON.stringify({
    intent: lead.intent,
    budget_min: lead.budget_min,
    budget_max: lead.budget_max,
    budget_text: lead.budget_text,
    budget_currency: lead.budget_currency,
    car_query: lead.car_query,
    finance: lead.finance,
    trade_in: lead.trade_in,
  })}
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: user.trim() },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) throw new Error(await res.text());
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty model response");
  return JSON.parse(content);
}

async function showOptionsAndStore(supabase: any, leadId: string, lead: any) {
  const result = await searchVehiclesClosest({ supabase, lead, limit: 3 });
  const { text, suggestions } = formatVehicleOptions(result.suggestions, result.meta);

  await supabase
    .from("leads")
    .update({
      last_vehicle_suggestions: suggestions,
      selected_vehicle: null,
      selected_vehicle_id: null,
      conversation_state: "AWAITING_CHOICE",
    })
    .eq("id", leadId);

  return {
    replyText: `${text}

¿Cuál te interesa? Respondé 1, 2 o 3.`, suggestions
  };
}

function getSuggestionByChoice(suggestions: VehicleSuggestion[] | null | undefined, choice: 1 | 2 | 3) {
  if (!Array.isArray(suggestions)) return null;
  return suggestions[choice - 1] ?? null;
}

export async function runBotForIncomingMessage({
  supabase,
  lead,
  incomingText,
}: {
  supabase: any;
  lead: LeadRow;
  incomingText: string;
}): Promise<BotResult | null> {
  // Refresh lead (we rely on stored suggestions/state)
  const { data: fresh } = await supabase.from("leads").select("*").eq("id", lead.id).single();
  const lead0 = fresh ?? lead;

  // If already handed off, keep it short
  if (lead0.conversation_state === "HANDED_OFF") {
    return { decision: "already_handed_off", replyText: "Perfecto, ya te contacta un asesor." };
  }

  // Explicit handoff
  if (hasAdvisorKeyword(incomingText)) {
    const agent = await pickNextAgent(supabase);
    await supabase
      .from("leads")
      .update({
        stage: "handed_off",
        conversation_state: "HANDED_OFF",
        assigned_agent_id: agent.id,
      })
      .eq("id", lead0.id);

    await notifyAgentOutbox(supabase, agent, lead0, incomingText);
    await saveBotRun(supabase, lead0.id, "handoff_keyword");

    return { decision: "handoff_keyword", replyText: "Perfecto. Te derivé con un asesor, ya te escribe." };
  }

  // Choice fast-path: "1" / "2" / "3"
  const choice = parseChoice(incomingText);
  if (choice && lead0.last_vehicle_suggestions) {
    const suggestions = lead0.last_vehicle_suggestions as VehicleSuggestion[];
    const picked = getSuggestionByChoice(suggestions, choice);
    if (picked) {
      // Save selection
      await supabase
        .from("leads")
        .update({
          selected_vehicle_id: picked.id,
          selected_vehicle: picked,
          conversation_state: "AWAITING_FINANCE",
        })
        .eq("id", lead0.id);

      await saveBotRun(supabase, lead0.id, "vehicle_selected", { choice, picked });

      // If finance already known, skip straight to next missing
      if (!lead0.finance) {
        return { decision: "ask_finance_after_choice", replyText: "Perfecto. ¿Lo querés financiar o sería contado?" };
      }

      if (!lead0.trade_in) {
        return { decision: "ask_tradein_after_choice", replyText: "¿Tenés usado para permuta?" };
      }

      // Ready to handoff
      const agent = await pickNextAgent(supabase);
      await supabase
        .from("leads")
        .update({ stage: "handed_off", conversation_state: "HANDED_OFF", assigned_agent_id: agent.id })
        .eq("id", lead0.id);

      await notifyAgentOutbox(supabase, agent, { ...lead0, selected_vehicle: picked }, incomingText);
      return { decision: "handoff_after_choice", replyText: "Listo. Te paso con un asesor para coordinar." };
    }
  }

  // Finance fast-path when we are awaiting it
  if (lead0.conversation_state === "AWAITING_FINANCE") {
    const f = normalizeYesNo(incomingText);
    if (f) {
      await supabase.from("leads").update({ finance: f, conversation_state: "AWAITING_TRADE_IN" }).eq("id", lead0.id);
      await saveBotRun(supabase, lead0.id, "finance_set", { finance: f });

      if (f === "yes" && lead0.selected_vehicle) {
        const sv = lead0.selected_vehicle as VehicleSuggestion;
        const quote = await getCreditCarQuote({ montoARS: sv.price_ars, modeloYear: sv.year ?? undefined });
        // Ask next question only
        const quoteLine = quote?.summaryText ? `\n\nSimulación aprox.: ${quote.summaryText}` : "";
        return { decision: "ask_tradein_with_quote", replyText: `Perfecto.${quoteLine}\n\n¿Tenés usado para permuta?` };
      }

      return { decision: "ask_tradein", replyText: "¿Tenés usado para permuta?" };
    }
  }

  // Trade-in fast-path when we are awaiting it
  if (lead0.conversation_state === "AWAITING_TRADE_IN") {
    const t = normalizeYesNo(incomingText);
    if (t) {
      const { data: updated } = await supabase
        .from("leads")
        .update({ trade_in: t })
        .eq("id", lead0.id)
        .select("*")
        .single();

      await saveBotRun(supabase, lead0.id, "trade_in_set", { trade_in: t });

      const agent = await pickNextAgent(supabase);
      await supabase
        .from("leads")
        .update({ stage: "handed_off", conversation_state: "HANDED_OFF", assigned_agent_id: agent.id })
        .eq("id", lead0.id);

      await notifyAgentOutbox(supabase, agent, updated ?? lead0, incomingText);
      return { decision: "handoff_ready", replyText: "Perfecto. Te derivé con un asesor para avanzar. Ya te escribe." };
    }
  }

  if (looksLikeGreetingOnly(incomingText)) {
    return {
      decision: "greeting",
      replyText: "¡Hola! Soy el asistente de Jesús Díaz Automotores. ¿Buscás comprar o entregar tu usado en parte de pago?",
    };
  }

  // LLM extraction for slot filling
  const extracted = await extractWithLLM(incomingText, lead0);

  // Apply patch
  const patch: any = {};
  const keys = [
    "intent",
    "budget_min",
    "budget_max",
    "budget_text",
    "budget_currency",
    "car_query",
    "finance",
    "trade_in",
    "urgency",
    "lead_quality",
  ];

  for (const k of keys) {
    const v = extracted?.[k];
    if (v !== null && v !== undefined && v !== "") patch[k] = v;
  }

  if (Object.keys(patch).length) {
    await supabase
      .from("leads")
      .update({
        ...patch,
        stage: lead0.stage === "new" ? "qualifying" : lead0.stage,
      })
      .eq("id", lead0.id);
  }

  await saveBotRun(supabase, lead0.id, "extracted", extracted);

  const { data: lead2 } = await supabase.from("leads").select("*").eq("id", lead0.id).single();
  const leadX = lead2 ?? lead0;
  const missing = missingRequired(leadX);

  // If user wants catalog/options, show options but ask ONLY for choice.
  if (extracted?.wants_catalog) {
    if (missing.includes("budget")) {
      await supabase.from("leads").update({ conversation_state: "AWAITING_BUDGET" }).eq("id", lead0.id);
      return { decision: "ask_budget_for_catalog", replyText: "Dale. ¿Qué presupuesto manejás aprox? (podés decir ARS o USD)", extracted };
    }
    if (missing.includes("car_query")) {
      await supabase.from("leads").update({ conversation_state: "AWAITING_CAR" }).eq("id", lead0.id);
      return { decision: "ask_car_for_catalog", replyText: "Perfecto. ¿Qué buscás? Decime 1 o 2 modelos que te gusten.", extracted };
    }

    const shown = await showOptionsAndStore(supabase, lead0.id, leadX);
    return { decision: "show_options", replyText: shown.replyText, extracted };
  }

  // Ask missing one-by-one (single question)
  if (missing.includes("intent")) {
    return { decision: "ask_intent", replyText: "¿Buscás comprar o entregar tu usado en parte de pago?", extracted };
  }
  if (missing.includes("budget")) {
    await supabase.from("leads").update({ conversation_state: "AWAITING_BUDGET" }).eq("id", lead0.id);
    return { decision: "ask_budget", replyText: "Para pasarte precios reales: ¿qué presupuesto manejás aprox? (ARS o USD)", extracted };
  }
  if (missing.includes("car_query")) {
    await supabase.from("leads").update({ conversation_state: "AWAITING_CAR" }).eq("id", lead0.id);
    return { decision: "ask_car", replyText: "¿Qué modelo/segmento buscás? (decime 1 o 2 modelos)", extracted };
  }

  // We have enough to show options even if they didn't explicitly ask for catalog
  if (!missing.includes("budget") && !missing.includes("car_query")) {
    const shown = await showOptionsAndStore(supabase, lead0.id, leadX);
    return { decision: "show_options_auto", replyText: shown.replyText, extracted };
  }

  if (missing.includes("finance")) {
    await supabase.from("leads").update({ conversation_state: "AWAITING_FINANCE" }).eq("id", lead0.id);
    return { decision: "ask_finance", replyText: "¿Lo querés financiar o sería contado?", extracted };
  }
  if (missing.includes("trade_in")) {
    await supabase.from("leads").update({ conversation_state: "AWAITING_TRADE_IN" }).eq("id", lead0.id);
    return { decision: "ask_tradein", replyText: "¿Tenés usado para permuta?", extracted };
  }

  // Ready to handoff
  const agent = await pickNextAgent(supabase);
  await supabase
    .from("leads")
    .update({ stage: "handed_off", conversation_state: "HANDED_OFF", assigned_agent_id: agent.id })
    .eq("id", lead0.id);

  await notifyAgentOutbox(supabase, agent, leadX, incomingText);

  return {
    decision: "handoff_ready",
    replyText: "Perfecto. Te derivé con un asesor para seguir y pasarte opciones concretas. Ya te escribe.",
    extracted,
  };
}
