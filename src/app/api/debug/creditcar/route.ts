import { NextResponse } from "next/server";
import { getCreditCarQuote } from "@/lib/creditcar";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const monto = Number(searchParams.get("monto") || "");
  const modelo = Number(searchParams.get("modelo") || "");
  const term = Number(searchParams.get("term") || "") || undefined;

  if (!Number.isFinite(monto) || monto <= 0) {
    return NextResponse.json({ ok: false, error: "param monto requerido" }, { status: 400 });
  }

  const quote = await getCreditCarQuote({ montoARS: monto, modeloYear: Number.isFinite(modelo) && modelo > 1900 ? modelo : undefined, term });
  return NextResponse.json({ ok: true, quote });
}
