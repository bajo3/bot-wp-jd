import { NextResponse } from "next/server";
import crypto from "crypto";
import { createAdminClient } from "@/lib/supabaseAdmin";
import { sendWhatsAppText } from "@/lib/whatsapp";
import { runBotForIncomingMessage } from "@/lib/bot/runBot";

export const runtime = "nodejs";

function verifySignature(rawBody: string, signatureHeader: string | null) {
  // Header: "sha256=..."
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return true; // si no configuraste secret, no verifiques
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const their = signatureHeader.slice("sha256=".length);
  const ours = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(ours), Buffer.from(their));
  } catch {
    return false;
  }
}

// GET: verificación webhook
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

// POST: eventos
export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256");

  if (!verifySignature(raw, sig)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(raw);

  const changes = body?.entry?.[0]?.changes?.[0]?.value;
  const messages = changes?.messages;
  const contacts = changes?.contacts;

  if (!messages?.length) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const msg = messages[0];
  const waMessageId = msg.id as string | undefined;
  const from = msg.from as string; // "549..." (sin '+')
  const text = msg.text?.body ?? "";

  const phoneE164 = from?.startsWith("+") ? from : `+${from}`;
  const name = contacts?.[0]?.profile?.name as string | undefined;

  const supabase = createAdminClient();

  // idempotencia
  if (waMessageId) {
    const { data: existing } = await supabase
      .from("messages")
      .select("id")
      .eq("wa_message_id", waMessageId)
      .maybeSingle();

    if (existing) return NextResponse.json({ ok: true }, { status: 200 });
  }

  // upsert lead
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .upsert(
      {
        phone_e164: phoneE164,
        name: name ?? null,
        last_user_message_at: new Date().toISOString(),
      },
      { onConflict: "phone_e164" }
    )
    .select("*")
    .single();

  if (leadErr || !lead) {
    return NextResponse.json({ error: "Lead upsert failed" }, { status: 500 });
  }

  // guardar mensaje entrante
  await supabase.from("messages").insert({
    lead_id: lead.id,
    wa_message_id: waMessageId ?? null,
    direction: "in",
    text,
    raw_payload: msg,
  });

  // correr bot
  const result = await runBotForIncomingMessage({ supabase, lead, incomingText: text });

  if (result?.replyText) {
    await sendWhatsAppText(phoneE164, result.replyText);

    await supabase.from("messages").insert({
      lead_id: lead.id,
      direction: "out",
      text: result.replyText,
      raw_payload: { decision: result.decision },
    });

    await supabase
      .from("leads")
      .update({ last_bot_message_at: new Date().toISOString() })
      .eq("id", lead.id);

    // training example auto
    await supabase.from("training_examples").insert({
      lead_id: lead.id,
      user_message: text,
      bot_message: result.replyText,
      extracted: result.extracted ?? null,
    });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
