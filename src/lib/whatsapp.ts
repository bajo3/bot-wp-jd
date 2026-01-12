type WhatsAppSectionRow = {
  id: string;
  title: string;
  description?: string;
};

type WhatsAppListSection = {
  title: string;
  rows: WhatsAppSectionRow[];
};

function getWhatsAppConfig() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.GRAPH_API_VERSION ?? "v20.0";
  if (!token || !phoneNumberId) throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
  return { token, phoneNumberId, version };
}

async function postWhatsAppMessage(payload: any) {
  const { token, phoneNumberId, version } = getWhatsAppConfig();
  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WhatsApp send failed: ${res.status} ${err}`);
  }
}

export async function sendWhatsAppText(toE164: string, body: string) {
  await postWhatsAppMessage({
    messaging_product: "whatsapp",
    to: toE164.replace("+", ""),
    type: "text",
    text: { body },
  });
}

export async function sendWhatsAppImage(toE164: string, link: string, caption?: string) {
  const payload: any = {
    messaging_product: "whatsapp",
    to: toE164.replace("+", ""),
    type: "image",
    image: { link },
  };
  if (caption) payload.image.caption = caption;
  await postWhatsAppMessage(payload);
}

/**
 * WhatsApp Cloud API interactive list message.
 * Falls back at call site if WhatsApp rejects interactives (e.g. not allowed by account/phone).
 */
export async function sendWhatsAppInteractiveList(
  toE164: string,
  bodyText: string,
  buttonText: string,
  sections: WhatsAppListSection[],
  headerText?: string
) {
  const interactive: any = {
    type: "list",
    body: { text: bodyText },
    action: {
      button: buttonText,
      sections: sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title,
          ...(r.description ? { description: r.description } : {}),
        })),
      })),
    },
  };

  if (headerText) interactive.header = { type: "text", text: headerText };

  await postWhatsAppMessage({
    messaging_product: "whatsapp",
    to: toE164.replace("+", ""),
    type: "interactive",
    interactive,
  });
}

export async function sendMainMenu(toE164: string) {
  const catalogUrl = process.env.CATALOG_URL ?? "https://jesusdiaz-automotores.vercel.app/catalogo";

  // Try interactive list first
  try {
    await sendWhatsAppInteractiveList(
      toE164,
      "Menú — elegí una opción:",
      "Abrir menú",
      [
        {
          title: "Opciones",
          rows: [
            { id: "MENU_CATALOG", title: "Ver catálogo", description: "Abrir el catálogo web" },
            { id: "MENU_SEARCH", title: "Buscar por modelo", description: "Decime qué modelo buscás" },
            { id: "MENU_FINANCE", title: "Simular cuotas", description: "Cuotas 6/12/18/24 (60/40)" },
            { id: "MENU_TRADEIN", title: "Tasar / tomar usado", description: "Decime marca/modelo/año/km" },
            { id: "MENU_ADVISOR", title: "Hablar con asesor", description: "Te contacta un vendedor" },
            { id: "MENU_LOCATION", title: "Ubicación / horarios", description: "Dirección y mapa" },
          ],
        },
      ],
      "Menú"
    );
    return;
  } catch {
    // fallback to text menu
  }

  const lines = [
    "Menú:",
    `1) Ver catálogo (${catalogUrl})`,
    "2) Buscar por modelo",
    "3) Simular cuotas",
    "4) Tasar / tomar usado",
    "5) Hablar con asesor",
    "6) Ubicación / horarios",
    "",
    'Tip: también podés escribir "menu".',
  ];
  await sendWhatsAppText(toE164, lines.join("\n"));
}
