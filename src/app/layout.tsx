import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Jesús Díaz Automotores - Bot",
  description: "WhatsApp bot + Supabase",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial" }}>
        {children}
      </body>
    </html>
  );
}
