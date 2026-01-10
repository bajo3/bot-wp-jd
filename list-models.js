const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

client.models.list().then((res) => {
  console.log(res.data.map(m => m.id).sort().join("\n"));
});
