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
import { getBlueSellRate, moneyToARS } from "@/lib/exchangeRate";

type LeadRow = any;

export type BotResult = {
  replyText?: string;
  outgoing?: Array<{ type: "text"; body: string } | { type: "image"; link: string; caption?: string }>; 
  decision: string;
  extracted?: any;
};

function looksLikeGreetingOnly(t: string) {
  const s = t
    .trim()
    .toLowerCase()
    .replace(/[!¡?.:,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Greetings even when they include a short extra phrase (e.g. "hola como estas").
  if (/^hola\b/.test(s)) return true;
  if (/^buen(as|os)?\b/.test(s)) return true;
  if (/^buen\s*d[ií]a\b/.test(s) || /^buen\s*dia\b/.test(s)) return true;
  if (/^(que|qué)\s+tal\b/.test(s)) return true;
  if (s === "👋") return true;
  // Keep it conservative: don't treat every message containing these words as greeting-only.
  return false;
}

function looksLikeGreeting(t: string) {
  const s = t
    .trim()
    .toLowerCase()
    .replace(/[!¡?.:,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^hola\b/.test(s) || /^buen(as|os)?\b/.test(s) || /^(que|qué)\s+tal\b/.test(s) || s === "👋";
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

function isStepAnswerForState(text: string, state: string | null | undefined) {
  const st = String(state ?? "");
  if (st === "AWAITING_CHOICE") return Boolean(parseChoice(text));
  if (["AWAITING_FINANCE_INTEREST", "AWAITING_FINANCE", "AWAITING_TRADE_IN"].includes(st)) return Boolean(normalizeYesNo(text));
  if (st === "AWAITING_TERM") return /\b(12|24|36|48)\b/.test(text);
  if (st === "AWAITING_DOWNPAYMENT") return Boolean(parseDownpayment(text).value);
  if (st === "AWAITING_USED_DETAILS") return text.trim().length > 0;
  return false;
}

function looksLikeThanksOrAck(t: string) {
  const s = t.trim().toLowerCase();
  return (
    s === "gracias" ||
    s === "muchas gracias" ||
    s === "genial" ||
    s === "joya" ||
    s === "ok" ||
    s === "okay" ||
    s === "dale" ||
    s === "perfecto" ||
    s === "listo" ||
    s === "👍" ||
    s === "👌"
  );
}

function wantsMorePhotos(t: string) {
  const s = t.toLowerCase();
  return s.includes("más fotos") || s.includes("mas fotos") || s.includes("otras fotos") || s.includes("fotos") && s.includes("mas");
}

function wantsPublicationLink(t: string) {
  const s = t.toLowerCase();
  return (
    s.includes("link") ||
    s.includes("public") ||
    s.includes("mercado") ||
    s.includes("ml") ||
    s.includes("publicación") ||
    s.includes("publicacion")
  );
}

function looksLikeNewSearchIntent(t: string) {
  const s = t.toLowerCase();
  if (looksLikeThanksOrAck(s)) return false;
  if (looksLikeGreetingOnly(s)) return false;
  if (normalizeYesNo(s)) return false;
  if (/^\s*[1-3]\b/.test(s)) return false;
  // Heuristic: a question/request about availability of a model.
  return /(ten[eé]s|tienen|hay|busco|me interesa|alguna|algún|algun|modelo|auto|camioneta)/.test(s);
}

function formatKm(km: number | null | undefined) {
  if (km == null || !Number.isFinite(Number(km))) return null;
  return Math.round(Number(km)).toLocaleString("es-AR");
}

function extractMotorAndVersionFromTitle(title: string) {
  const t = String(title ?? "");
  // Motor: detect patterns like 1.6, 2.0, 1.4, 2.4
  const motorMatch = t.match(/\b(\d(?:\.\d)?)\b/);
  const motor = motorMatch ? motorMatch[1] : null;

  // Version/trim: common Argentine trims (best-effort)
  const trims = [
    "highline",
    "trendline",
    "comfortline",
    "exclusive",
    "dynamique",
    "privilege",
    "attractive",
    "pack",
    "full",
    "ltz",
    "lt",
    "se",
    "xe",
    "xlt",
    "xle",
    "xli",
    "s",
  ];
  const lower = t.toLowerCase();
  const found = trims.find((tr) => new RegExp(`\\b${tr}\\b`, "i").test(lower)) ?? null;

  // Capitalize a bit
  const version = found ? found.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
  return { motor, version };
}

function parseDownpayment(text: string): { value: number | null; isPercent: boolean; currency: "ARS" | "USD" } {
  const s = text.toLowerCase();
  const isPercent = /%/.test(s);
  const currency: "ARS" | "USD" = /usd|u\$s|dolar|dólar/.test(s) ? "USD" : "ARS";

  // Remove separators and get first number
  const m = s.replace(/\./g, "").match(/(\d{1,3}(?:[\s,]\d{3})+|\d+)(?:\.(\d+))?/);
  if (!m) return { value: null, isPercent, currency };
  const n = Number(m[1].replace(/[\s,]/g, ""));
  if (!Number.isFinite(n)) return { value: null, isPercent, currency };
  return { value: n, isPercent, currency };
}

function missingRequired(lead: LeadRow) {
  const missing: string[] = [];
  if (!lead.intent) {
    missing.push("intent");
    return missing;
  }

  const intent = String(lead.intent).toLowerCase();

  // BUY: we need budget + what they're looking for + finance + trade-in.
  if (intent === "buy") {
    if (!lead.budget_min && !lead.budget_max && !lead.budget_text) missing.push("budget");
    if (!lead.car_query) missing.push("car_query");
    if (!lead.finance) missing.push("finance");
    if (!lead.trade_in) missing.push("trade_in");
    return missing;
  }

  // SELL/TRADE: do NOT force the buy-flow fields. Ask for used vehicle details first.
  // We store it as a simple text field for now.
  if (!lead.used_vehicle_text) missing.push("used_vehicle");

  // TRADE: after used details, we can ask what they want to take.
  if (intent === "trade" && !lead.car_query) missing.push("car_query");

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

async function tryInsertAgentOutbox(supabase: any, leadId: string, agentId: string, payload: any) {
  try {
    const { error } = await supabase.from("agent_outbox").insert({
      lead_id: leadId,
      agent_id: agentId,
      payload,
      status: "pending",
    });
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

async function tryMarkHandedOff(supabase: any, leadId: string) {
  try {
    await supabase
      .from("leads")
      .update({ handed_off_at: new Date().toISOString() })
      .eq("id", leadId)
      .is("handed_off_at", null);
  } catch {
    // ignore (column might not exist yet)
  }
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

  // 1) Best-effort: enqueue into a dedicated outbox table (worker/n8n/edge can deliver).
  const inserted = await tryInsertAgentOutbox(supabase, leadId, String(agent.id), payload);

  // 2) Always keep a copy in bot_runs for debugging/training.
  await saveOutboxToBotRuns(supabase, leadId, payload);

  // 3) Optional timestamps (if columns exist).
  if (inserted) {
    try {
      await supabase.from("leads").update({ handed_off_notified_at: new Date().toISOString() }).eq("id", leadId);
    } catch {
      // ignore (column might not exist yet)
    }
  }
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
    replyText:
      suggestions.length === 1
        ? `${text}

Si querés ver la ficha con fotos, respondé 1.`
        : `${text}

Respondé 1, 2 o 3 para ver la ficha con fotos de la unidad.`,
    suggestions,
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
  let lead0 = fresh ?? lead;

  const isHandedOff = lead0.conversation_state === "HANDED_OFF" || lead0.stage === "handed_off";

  // If the last bot interaction is old, reset the flow (but keep the lead and assigned agent).
  // This prevents the bot from continuing a stale conversation (e.g. still talking about a past chosen car).
  try {
    const maxAgeMin = Number(process.env.BOT_RESET_MINUTES ?? 90);
    const lastBotAt = lead0.last_bot_message_at ? new Date(String(lead0.last_bot_message_at)).getTime() : null;
    if (lastBotAt && Number.isFinite(lastBotAt)) {
      const ageMin = (Date.now() - lastBotAt) / 60000;
      const shouldResetByAge =
        ageMin > maxAgeMin &&
        !isStepAnswerForState(incomingText, lead0.conversation_state) &&
        (looksLikeGreeting(incomingText) || looksLikeNewSearchIntent(incomingText) || isHandedOff);

      if (shouldResetByAge) {
        await supabase
          .from("leads")
          .update({
            conversation_state: "START",
            last_vehicle_suggestions: null,
            selected_vehicle: null,
            selected_vehicle_id: null,
          })
          .eq("id", lead0.id);

        // Optional timestamp (if the column exists).
        try {
          await supabase.from("leads").update({ last_reset_at: new Date().toISOString() }).eq("id", lead0.id);
        } catch {
          // ignore
        }

        lead0 = {
          ...lead0,
          conversation_state: "START",
          last_vehicle_suggestions: null,
          selected_vehicle: null,
          selected_vehicle_id: null,
        };
      }
    }
  } catch {
    // ignore reset errors
  }

  // Courtesy/ack messages: do not push the flow.
  if (looksLikeThanksOrAck(incomingText)) {
    const base = "¡De nada!";
    const extra = isHandedOff
      ? " Mientras tanto, si querés puedo pasarte más fotos, detalles o un aproximado de cuotas."
      : " Si querés, decime qué modelo buscás o tu presupuesto y te paso opciones.";
    return { decision: "courtesy_ack", replyText: `${base}${extra}` };
  }

  // When the lead is already handed off, a bare "no" should not trigger a new search/options.
  // Example: "¿Querés link o más fotos?" -> "no".
  if (isHandedOff) {
    const s = incomingText.trim().toLowerCase();
    if (s === "no" || s === "nop" || s === "nope") {
      return {
        decision: "handed_off_no_ack",
        replyText:
          "Perfecto. ¿Querés coordinar para verla, ver otra unidad, o te armo un aproximado de cuotas?",
      };
    }
  }

  // Explicit handoff
  if (hasAdvisorKeyword(incomingText)) {
    // If already handed off, don't reassign. Just acknowledge.
    if (lead0.assigned_agent_id) {
      await supabase.from("leads").update({ conversation_state: "HANDED_OFF", stage: "handed_off" }).eq("id", lead0.id);
      await saveBotRun(supabase, lead0.id, "handoff_keyword_already_assigned");
      return { decision: "handoff_keyword_already_assigned", replyText: "Dale. Ya hay un asesor asignado, en breve te escribe." };
    }

    const agent = await pickNextAgent(supabase);
    await supabase
      .from("leads")
      .update({ stage: "handed_off", conversation_state: "HANDED_OFF", assigned_agent_id: agent.id })
      .eq("id", lead0.id);

    await tryMarkHandedOff(supabase, lead0.id);

    await notifyAgentOutbox(supabase, agent, lead0, incomingText);
    await saveBotRun(supabase, lead0.id, "handoff_keyword");

    return { decision: "handoff_keyword", replyText: "Listo. Te derivé con un asesor, ya te escribe." };
  }

  // If the user changes the topic/model mid-flow, reset the conversational state so the bot doesn't
  // continue asking stale questions.
  if (
    looksLikeNewSearchIntent(incomingText) &&
    !["START", "AWAITING_BUDGET", "AWAITING_CAR"].includes(String(lead0.conversation_state))
  ) {
    await supabase
      .from("leads")
      .update({
        conversation_state: "START",
        last_vehicle_suggestions: null,
        selected_vehicle: null,
        selected_vehicle_id: null,
      })
      .eq("id", lead0.id);
    lead0 = {
      ...lead0,
      conversation_state: "START",
      last_vehicle_suggestions: null,
      selected_vehicle: null,
      selected_vehicle_id: null,
    };
  }

  // Choice fast-path: "1" / "2" / "3" (only when we are awaiting a choice)
  const choice = parseChoice(incomingText);
  if (choice && lead0.conversation_state === "AWAITING_CHOICE" && lead0.last_vehicle_suggestions) {
    const suggestions = lead0.last_vehicle_suggestions as VehicleSuggestion[];
    const picked = getSuggestionByChoice(suggestions, choice);
    if (picked) {
      // Save selection
      await supabase
        .from("leads")
        .update({
          selected_vehicle_id: picked.id,
          selected_vehicle: picked,
          conversation_state: "AWAITING_FINANCE_INTEREST",
        })
        .eq("id", lead0.id);

      await saveBotRun(supabase, lead0.id, "vehicle_selected", { choice, picked });

      // Present a short ficha + 4 photos (from Supabase) and offer a no-commitment financing approximation.
      const { motor, version } = extractMotorAndVersionFromTitle(picked.title);
      const yearLine = picked.year ? ` (${picked.year})` : "";
      const kmLine = formatKm(picked.km) ? `\n- Km: ${formatKm(picked.km)}` : "";
      const motorLine = motor ? `\n- Motor: ${motor}` : "";
      const versionLine = version ? `\n- Versión: ${version}` : "";
      const transLine = picked.transmission ? `\n- Caja: ${String(picked.transmission)}` : "";
      const colorLine = picked.color ? `\n- Color: ${String(picked.color)}` : "";
      const priceLine =
        picked.currency_original === "USD"
          ? `\n- Precio: USD ${Math.round(picked.price_original).toLocaleString("en-US")} (≈ $ ${Math.round(picked.price_ars).toLocaleString("es-AR")})`
          : `\n- Precio: $ ${Math.round(picked.price_ars).toLocaleString("es-AR")}`;

      const card = `✅ ${picked.title}${yearLine}${kmLine}${motorLine}${versionLine}${transLine}${colorLine}${priceLine}`;
      const pics = Array.isArray(picked.pictures) ? picked.pictures.filter(Boolean) : [];
      const first4 = pics.slice(0, 4);

      const outgoing: NonNullable<BotResult["outgoing"]> = [{ type: "text", body: `${card}\n\nTe paso 4 fotos 👇` }];
      for (const link of first4) outgoing.push({ type: "image", link });
      outgoing.push({
        type: "text",
        body:
          "Si querés, te hago un aproximado de cuotas (sin compromiso) para que te des una idea. ¿Te lo armo? (sí/no)\n\nSi querés más fotos, escribí: más fotos.",
      });

      return { decision: "vehicle_card_and_photos", outgoing };
    }
  }

  // If the user asks for more photos and we have a selected vehicle, send all photos.
  if (wantsMorePhotos(incomingText) && lead0.selected_vehicle) {
    const sv = lead0.selected_vehicle as VehicleSuggestion;
    const pics = Array.isArray(sv.pictures) ? sv.pictures.filter(Boolean) : [];
    if (!pics.length) {
      return { decision: "no_photos_available", replyText: "Todavía no tengo fotos cargadas de esa unidad." };
    }
    const outgoing: NonNullable<BotResult["outgoing"]> = [{ type: "text", body: "Dale, te paso todas las fotos 👇" }];
    for (const link of pics) outgoing.push({ type: "image", link });
    return { decision: "send_all_photos", outgoing };
  }

  // Only share an external publication link if the user explicitly asks.
  if (wantsPublicationLink(incomingText) && lead0.selected_vehicle) {
    const sv = lead0.selected_vehicle as VehicleSuggestion;
    if (sv.permalink) {
      return { decision: "share_publication_link", replyText: `Acá tenés la publicación: ${sv.permalink}` };
    }
  }

  // Used vehicle details flow (sell/trade)
  if (lead0.conversation_state === "AWAITING_USED_DETAILS") {
    const usedText = incomingText.trim();
    if (usedText.length < 3) {
      return {
        decision: "used_details_retry",
        replyText: "¿Me decís marca, modelo, año y km de tu usado? (ej: Suran 2013, 126.000 km)",
      };
    }

    // Save (best-effort; column may not exist yet)
    try {
      await supabase.from("leads").update({ used_vehicle_text: usedText }).eq("id", lead0.id);
    } catch {
      // ignore
    }

    const intent = String(lead0.intent ?? "").toLowerCase();
    if (intent === "trade") {
      // Continue to what they want to take.
      await supabase.from("leads").update({ conversation_state: "AWAITING_CAR" }).eq("id", lead0.id);
      return {
        decision: "used_details_saved_ask_car",
        replyText: "Perfecto. ¿Qué te interesa llevar? Decime 1 o 2 modelos (ej: Fluence, Amarok).",
      };
    }

    // SELL: handoff to an agent for valuation.
    if (lead0.assigned_agent_id) {
      const { data: agent } = await supabase.from("agents").select("*").eq("id", lead0.assigned_agent_id).maybeSingle();
      if (agent) await notifyAgentOutbox(supabase, agent, lead0, incomingText, { used_vehicle_text: usedText });
      await supabase.from("leads").update({ conversation_state: "HANDED_OFF", stage: "handed_off" }).eq("id", lead0.id);
      await tryMarkHandedOff(supabase, lead0.id);
      return {
        decision: "used_details_saved_already_assigned",
        replyText: "Dale, lo dejo asentado y el asesor lo ve para cotizarlo. Ya te escribe.",
      };
    }

    const agent = await pickNextAgent(supabase);
    await supabase.from("leads").update({ stage: "handed_off", conversation_state: "HANDED_OFF", assigned_agent_id: agent.id }).eq("id", lead0.id);
    await tryMarkHandedOff(supabase, lead0.id);
    await notifyAgentOutbox(supabase, agent, lead0, incomingText, { used_vehicle_text: usedText });
    return {
      decision: "used_details_saved_handoff",
      replyText: "Listo. Te derivé con un asesor para cotizar tu usado. Ya te escribe.",
    };
  }

  // Financing-approx flow after showing a vehicle.
  if (lead0.conversation_state === "AWAITING_FINANCE_INTEREST") {
    const ans = normalizeYesNo(incomingText);
    if (ans === "yes") {
      await supabase.from("leads").update({ finance: "yes", conversation_state: "AWAITING_DOWNPAYMENT" }).eq("id", lead0.id);
      return {
        decision: "ask_downpayment",
        replyText: "Dale. ¿Cuánto pensás entregar de anticipo aprox? (en $ o %)",
      };
    }
    if (ans === "no") {
      await supabase.from("leads").update({ finance: "no", conversation_state: "AWAITING_TRADE_IN" }).eq("id", lead0.id);
      return { decision: "skip_financing", replyText: "Perfecto. ¿Tenés usado para permuta?" };
    }
    // If they ask a question about the unit, let extraction handle it below.
  }

  if (lead0.conversation_state === "AWAITING_DOWNPAYMENT" && lead0.selected_vehicle) {
    const sv = lead0.selected_vehicle as any;
    const parsed = parseDownpayment(incomingText);
    if (!parsed.value) {
      return { decision: "downpayment_retry", replyText: "¿Cuánto podrías entregar aprox? (por ejemplo: 30% o $5.000.000)" };
    }
    await supabase
      .from("leads")
      .update({
        selected_vehicle: { ...sv, finance_downpayment: parsed },
        conversation_state: "AWAITING_TERM",
      })
      .eq("id", lead0.id);
    return { decision: "ask_term", replyText: "¿En cuántas cuotas te gustaría? (12/24/36/48)" };
  }

  if (lead0.conversation_state === "AWAITING_TERM" && lead0.selected_vehicle) {
    const term = Number(String(incomingText).trim().match(/\b(12|24|36|48)\b/)?.[1] ?? NaN);
    if (!Number.isFinite(term)) {
      return { decision: "term_retry", replyText: "¿En cuántas cuotas? (12/24/36/48)" };
    }

    const sv = lead0.selected_vehicle as any;
    const dp = sv.finance_downpayment as { value: number; isPercent: boolean; currency: "ARS" | "USD" } | undefined;
    const { sell: blueSell } = await getBlueSellRate(supabase, 120);

    let downARS = 0;
    if (dp?.value) {
      if (dp.isPercent) downARS = Math.round((sv.price_ars * dp.value) / 100);
      else downARS = moneyToARS(dp.value, dp.currency ?? "ARS", blueSell);
    }
    const montoFinanciado = Math.max(0, Math.round(Number(sv.price_ars) - downARS));
    const quote = montoFinanciado > 0 ? await getCreditCarQuote({ montoARS: montoFinanciado, modeloYear: sv.year ?? undefined, term }) : null;
    const cuotaCreditCar = quote?.selected?.cuota ?? null;
    const cuotaLine = cuotaCreditCar
      ? `

Cuotas (CreditCar):
- ${term} cuotas: $ ${Math.round(cuotaCreditCar).toLocaleString("es-AR")}`
      : (quote?.summaryText ? `

Simulación aprox.:
${quote.summaryText}` : "");

    await supabase
      .from("leads")
      .update({ selected_vehicle: { ...sv, finance_term: term, finance_amount_ars: montoFinanciado }, conversation_state: "AWAITING_TRADE_IN" })
      .eq("id", lead0.id);

    return { decision: "quote_done_ask_tradein", replyText: `Listo.${cuotaLine}

¿Tenés usado para permuta?` };
  }

  // Finance fast-path when we are awaiting it
  if (lead0.conversation_state === "AWAITING_FINANCE") {
    const f = normalizeYesNo(incomingText);
    if (f) {
      await supabase.from("leads").update({ finance: f, conversation_state: "AWAITING_TRADE_IN" }).eq("id", lead0.id);
      await saveBotRun(supabase, lead0.id, "finance_set", { finance: f });

      if (f === "yes" && lead0.selected_vehicle) {
        const sv = lead0.selected_vehicle as VehicleSuggestion;
        const quote = await getCreditCarQuote({
          montoARS: (sv as any).finance_amount_ars ?? (sv as any).price_ars,
          modeloYear: (sv as any).year ?? undefined,
          term: (sv as any).finance_term ?? undefined,
        });
        // Ask next question only
        const cuotaCreditCar = quote?.selected?.cuota ?? null;
        const quoteLine = cuotaCreditCar
          ? `

Cuotas (CreditCar): $ ${Math.round(cuotaCreditCar).toLocaleString("es-AR")}`
          : (quote?.summaryText ? `

Simulación aprox.: ${quote.summaryText}` : "");
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

      // If the lead already has an assigned agent, avoid re-handing off. Just log/notify and keep helping.
      if (lead0.assigned_agent_id) {
        const { data: agent } = await supabase.from("agents").select("*").eq("id", lead0.assigned_agent_id).maybeSingle();
        if (agent) {
          await notifyAgentOutbox(supabase, agent, updated ?? lead0, incomingText, { trade_in: t });
        }
        await supabase.from("leads").update({ conversation_state: "HANDED_OFF", stage: "handed_off" }).eq("id", lead0.id);
        await tryMarkHandedOff(supabase, lead0.id);
        return { decision: "tradein_added_already_handed_off", replyText: "Dale, lo sumo y el asesor lo tiene en cuenta. ¿Querés que te pase el link de la publicación o más fotos?" };
      }

      const agent = await pickNextAgent(supabase);
      await supabase.from("leads").update({ stage: "handed_off", conversation_state: "HANDED_OFF", assigned_agent_id: agent.id }).eq("id", lead0.id);

      await tryMarkHandedOff(supabase, lead0.id);
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

  // Sell/Trade: ask for used vehicle details before going into stock suggestions.
  if (missing.includes("used_vehicle")) {
    await supabase.from("leads").update({ conversation_state: "AWAITING_USED_DETAILS" }).eq("id", lead0.id);
    return {
      decision: "ask_used_vehicle_details",
      replyText: "Perfecto. ¿Me decís marca, modelo, año y km de tu usado? (ej: Suran 2013, 126.000 km)",
      extracted,
    };
  }
  if (missing.includes("budget")) {
    await supabase.from("leads").update({ conversation_state: "AWAITING_BUDGET" }).eq("id", lead0.id);
    return { decision: "ask_budget", replyText: "Para pasarte precios reales: ¿qué presupuesto manejás aprox? (ARS o USD)", extracted };
  }
  if (missing.includes("car_query")) {
    await supabase.from("leads").update({ conversation_state: "AWAITING_CAR" }).eq("id", lead0.id);
    return { decision: "ask_car", replyText: "¿Qué modelo/segmento buscás? (decime 1 o 2 modelos)", extracted };
  }

  // Auto-show options ONLY when we're at the start of a search flow.
  if (!missing.includes("budget") && !missing.includes("car_query")) {
    const st = String(leadX.conversation_state ?? "START");
    if (["START", "AWAITING_BUDGET", "AWAITING_CAR"].includes(st)) {
      const shown = await showOptionsAndStore(supabase, lead0.id, leadX);
      return { decision: "show_options_auto", replyText: shown.replyText, extracted };
    }
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
  const alreadyAssigned = leadX.assigned_agent_id || leadX.stage === "handed_off" || leadX.conversation_state === "HANDED_OFF";
  if (alreadyAssigned) {
    return {
      decision: "already_handed_off_continue",
      replyText: "Listo. Ya hay un asesor asignado. Si querés, puedo pasarte más fotos/detalles o armarte un aproximado de cuotas.",
      extracted,
    };
  }

  const agent = await pickNextAgent(supabase);
  await supabase.from("leads").update({ stage: "handed_off", conversation_state: "HANDED_OFF", assigned_agent_id: agent.id }).eq("id", lead0.id);
  await tryMarkHandedOff(supabase, lead0.id);
  await notifyAgentOutbox(supabase, agent, leadX, incomingText);

  return {
    decision: "handoff_ready",
    replyText: "Listo. Te derivé con un asesor para seguir y pasarte opciones concretas. Ya te escribe.",
    extracted,
  };
}
