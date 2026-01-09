export default function Page() {
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, marginBottom: 8 }}>Jesús Díaz Automotores — WhatsApp Bot</h1>
      <p style={{ marginBottom: 16 }}>
        Este proyecto expone el webhook en <code>/api/whatsapp/webhook</code>.
      </p>
      <ol>
        <li>Configurá <code>.env.local</code> desde <code>.env.example</code>.</li>
        <li>Corré las migraciones SQL en Supabase (carpeta <code>sql/</code>).</li>
        <li>Arrancá con <code>npm i</code> y <code>npm run dev</code>.</li>
      </ol>
    </main>
  );
}
