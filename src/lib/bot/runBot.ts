/*
  Bot core:
  - Extrae datos con OpenAI (JSON)
  - Decide el próximo paso (preguntar 1 cosa, mostrar catálogo, o derivar)
  - Round-robin entre agentes

  Nota: notificar al vendedor por WhatsApp desde Cloud API puede requerir ventana 24h o templates.
  Por eso dejamos un "outbox" dentro de bot_runs para que lo consumas como quieras.
*/

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
  return t.toLowerCase().includes("hablar con asesor");
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
  const idx = Math.max(
    0,
    agents.findIndex((a: any) => a.id === lastId)
  );

  const next = agents[(idx + 1) % agents.length];

  await supabase
    .from("agent_assignment_cursor")
    .update({ last_agent_id: next.id, updated_at: new Date().toISOString() })
    .eq("id", cursorId);

  return next as { id: string; name: string; phone_e164: string };
}

async function searchVehicles(supabase: any, lead: LeadRow) {
  /*
    Adaptado a tu tabla real (public.vehicles) según el dump que pasaste:
      - title, brand, model, year, price, currency
      - pictures (text[])
      - permalink
      - km (lowercase) y también existe "Km" (legacy). Usamos el que esté.
      - status: usamos ('available','active') como visibles

    Si más adelante querés filtrar por agency/tenant:
      - seteá DEALERSHIP_ID en .env y se filtra por dealership_id.
  */

  let q = supabase
    .from("vehicles")
    .select(
      "id, title, brand, model, year, price, currency, pictures, permalink, km, Km, transmission, Caja, color, status, dealership_id"
    )
    .in("status", ["available", "active"]);

  const dealershipId = process.env.DEALERSHIP_ID;
  if (dealershipId) q = q.eq("dealership_id", dealershipId);

  const budget = lead.budget_max ?? lead.budget_min;
  if (budget) q = q.lte("price", budget);

  if (lead.car_query) {
    const s = String(lead.car_query).replace(/'/g, "").trim();
    if (s) {
      // Busca por marca/modelo y también por título (suele contener versión)
      q = q.or(`brand.ilike.%${s}%,model.ilike.%${s}%,title.ilike.%${s}%`);
    }
  }

  const { data, error } = await q.order("price", { ascending: true }).limit(3);
  if (error) throw error;
  return data ?? [];
}

function formatCars(cars: any[]) {
  if (!cars.length) {
    return "No encontré opciones con esos filtros. ¿Querés decirme 2 modelos que te gusten o subir un poco el presupuesto?";
  }

  return cars
    .map((c) => {
      const title = (c.title ?? `${c.brand ?? ""} ${c.model ?? ""}`.trim()).trim();
      const year = c.year ? ` ${c.year}` : "";
      const kmVal = c.km ?? c.Km;
      const km = kmVal ? `${kmVal} km` : "";
      const currency = c.currency ?? "ARS";
      const price = c.price != null ? `${currency} ${Number(c.price).toLocaleString("es-AR")}` : "";
      const link = c.permalink ? `\n${c.permalink}` : "";

      return `• ${title}${year} — ${price}\n${km}${link}`.trim();
    })
    .join("\n\n");
}

async function extractWithLLM(incomingText: string, lead: LeadRow) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL ?? "gpt-5.2-mini";
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const system = `
Sos un extractor de datos de leads de una agencia de autos.
Devolvé SOLO JSON válido con estas claves:
intent, budget_min, budget_max, budget_text, car_query, finance, trade_in, urgency, lead_quality, wants_catalog

Reglas:
- No inventes.
- budget_* numérico en pesos si se puede; si no, budget_text.
- finance y trade_in: "yes"|"no"|"maybe"|null
- urgency: "low"|"medium"|"high"|null
- lead_quality: "low"|"medium"|"high"|null
- wants_catalog true si pide ver autos/opciones/catálogo/modelos.
`;

  const user = `
Mensaje: ${incomingText}
Lead actual (puede estar incompleto): ${JSON.stringify({
    intent: lead.intent,
    budget_min: lead.budget_min,
    budget_max: lead.budget_max,
    budget_text: lead.budget_text,
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

async function saveOutboxToBotRuns(supabase: any, leadId: string, payload: any, modelUsed?: string) {
  await supabase.from("bot_runs").insert({
    lead_id: leadId,
    decision: "notify_agent_outbox",
    extracted: payload,
    model_used: modelUsed ?? null,
  });
}

async function notifyAgentOutbox(supabase: any, agent: any, lead: any, lastUserText: string) {
  const payload = {
    agentPhoneE164: agent.phone_e164,
    summary: {
      phone: lead.phone_e164,
      name: lead.name,
      intent: lead.intent,
      budget_min: lead.budget_min,
      budget_max: lead.budget_max,
      budget_text: lead.budget_text,
      car_query: lead.car_query,
      finance: lead.finance,
      trade_in: lead.trade_in,
      urgency: lead.urgency,
      lead_quality: lead.lead_quality,
      lastUserText,
    },
    action: {
      type: "agent_should_contact_client_from_own_whatsapp",
      wa_me_link: `https://wa.me/${String(lead.phone_e164).replace("+", "")}`,
    },
  };

  await saveOutboxToBotRuns(supabase, lead.id, payload, process.env.OPENAI_MODEL  || undefined);
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
  if (hasAdvisorKeyword(incomingText)) {
    const agent = await pickNextAgent(supabase);
    await supabase
      .from("leads")
      .update({
        stage: "handed_off",
        conversation_state: "HANDED_OFF",
        assigned_agent_id: agent.id,
      })
      .eq("id", lead.id);

    await notifyAgentOutbox(supabase, agent, lead, incomingText);

    return {
      decision: "handoff_keyword",
      replyText: "Perfecto. Te derivé con un asesor, ya te escribe.",
    };
  }

  if (looksLikeGreetingOnly(incomingText)) {
    return {
      decision: "greeting",
      replyText: "¡Hola! Soy el asistente de Jesús Díaz Automotores 😊 ¿Buscás comprar o entregar tu usado en parte de pago?",
    };
  }

  const extracted = await extractWithLLM(incomingText, lead);

  const patch: any = {};
  const keys = [
    "intent",
    "budget_min",
    "budget_max",
    "budget_text",
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
        stage: lead.stage === "new" ? "qualifying" : lead.stage,
      })
      .eq("id", lead.id);
  }

  const { data: fresh } = await supabase.from("leads").select("*").eq("id", lead.id).single();
  const lead2 = fresh ?? lead;

  const missing = missingRequired(lead2);

  const highIntent = lead2.lead_quality === "high" || lead2.urgency === "high";
  if (highIntent && missing.length <= 2) {
    const agent = await pickNextAgent(supabase);
    await supabase
      .from("leads")
      .update({
        stage: "handed_off",
        conversation_state: "HANDED_OFF",
        assigned_agent_id: agent.id,
      })
      .eq("id", lead.id);

    await notifyAgentOutbox(supabase, agent, lead2, incomingText);

    return {
      decision: "handoff_high_intent",
      replyText: "Genial. Te derivé con un asesor para avanzar y pasarte opciones concretas. Ya te escribe.",
      extracted,
    };
  }

  if (extracted?.wants_catalog) {
    if (missing.includes("budget")) {
      return { decision: "ask_budget_for_catalog", replyText: "Dale. ¿Qué presupuesto manejás aprox. (en pesos)?", extracted };
    }
    if (missing.includes("car_query")) {
      return { decision: "ask_car_for_catalog", replyText: "Perfecto. ¿Qué buscás: algún modelo en particular o preferís sedan / suv / pickup?", extracted };
    }

    const cars = await searchVehicles(supabase, lead2);
    const list = formatCars(cars);

    if (missing.includes("finance")) {
      return { decision: "show_cars_then_finance", replyText: `${list}

¿Lo querés financiar o sería contado?`, extracted };
    }
    if (missing.includes("trade_in")) {
      return { decision: "show_cars_then_tradein", replyText: `${list}

¿Tenés usado para permuta?`, extracted };
    }

    return {
      decision: "show_cars",
      replyText: `${list}

¿Querés que te derive con un asesor para coordinar y pasarte más opciones? (si querés escribí: HABLAR CON ASESOR)`,
      extracted,
    };
  }

  if (missing.includes("budget")) {
    return {
      decision: "ask_budget",
      replyText: "Para pasarte precios reales: ¿qué presupuesto manejás aprox. (en pesos)?",
      extracted,
    };
  }

  if (missing.includes("intent")) {
    return { decision: "ask_intent", replyText: "¿Buscás comprar o entregar tu usado en parte de pago?", extracted };
  }
  if (missing.includes("car_query")) {
    return { decision: "ask_car", replyText: "¿Qué modelo/segmento buscás? (ej: Cruze, Corolla, SUV, pickup)", extracted };
  }
  if (missing.includes("finance")) {
    return { decision: "ask_finance", replyText: "¿Lo querés financiar o sería contado?", extracted };
  }
  if (missing.includes("trade_in")) {
    return { decision: "ask_tradein", replyText: "¿Tenés usado para permuta?", extracted };
  }

  const agent = await pickNextAgent(supabase);
  await supabase
    .from("leads")
    .update({
      stage: "handed_off",
      conversation_state: "HANDED_OFF",
      assigned_agent_id: agent.id,
    })
    .eq("id", lead.id);

  await notifyAgentOutbox(supabase, agent, lead2, incomingText);

  return {
    decision: "handoff_ready",
    replyText: "Perfecto. Te derivé con un asesor para seguir y pasarte opciones concretas. Ya te escribe.",
    extracted,
  };
}
