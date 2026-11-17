const express = require('express');
const cors = require('cors');
require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());
app.use(cors());

// ---------- 1. Clientes: OpenRouter y MySQL ----------
const MODEL = process.env.MODEL || 'openai/gpt-4o-mini';

const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://tu-sitio-web.com',
    'X-Title': 'Mi Aplicativo Web',
  },
});

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
});

// ---------- 2. Funciones físicas (herramientas) ----------
const WORKSPACE = path.join(__dirname, 'workspace');

// Evita que la IA salga de la carpeta workspace (ej. "../../.env")
function safePath(filePath) {
  const full = path.resolve(WORKSPACE, String(filePath || ''));
  if (!full.startsWith(WORKSPACE + path.sep)) {
    throw new Error('Ruta no permitida: solo se puede usar la carpeta workspace');
  }
  return full;
}

async function write_file({ file_path, content }) {
  try {
    const full = safePath(file_path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, String(content ?? ''), 'utf-8');
    return `Éxito: Archivo '${file_path}' creado correctamente.`;
  } catch (e) {
    return `Error al escribir el archivo: ${e.message}`;
  }
}

async function read_file({ file_path }) {
  try {
    return await fs.readFile(safePath(file_path), 'utf-8');
  } catch (e) {
    return `Error al leer el archivo: ${e.message}`;
  }
}

async function query_database({ sql }) {
  const clean = String(sql || '').trim().replace(/;+\s*$/, '');

  if (!/^(select|with)\s/i.test(clean) || clean.includes(';')) {
    return 'Error: solo se permite UNA consulta SELECT.';
  }
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|outfile|dumpfile)\b/i.test(clean)) {
    return 'Error: la consulta contiene palabras no permitidas.';
  }

  try {
    const [rows] = await pool.query({ sql: clean, timeout: 10000 });
    return JSON.stringify(rows.slice(0, 50)); // máximo 50 filas
  } catch (e) {
    // Se devuelve el error a la IA para que corrija su propia consulta
    return `Error SQL: ${e.message}`;
  }
}

const toolFunctions = { write_file, read_file, query_database };

// ---------- 3. Manual de instrucciones para la IA (Tool Schema) ----------
const tools = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Crea o sobrescribe un archivo con el código o texto especificado.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Nombre y extensión del archivo (ej. hola.txt)' },
          content: { type: 'string', description: 'El contenido a escribir dentro del archivo' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lee el contenido de un archivo existente para verificarlo.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Nombre del archivo a leer' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_database',
      description:
        'Ejecuta una consulta SELECT (solo lectura) en la base de datos MySQL Sakila de la tienda de películas y devuelve las filas en JSON.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'Consulta SQL SELECT completa, con JOINs si hace falta.' },
        },
        required: ['sql'],
      },
    },
  },
];

// ---------- 4. Prompt de sistema con el esquema de la BD ----------
const SYSTEM_PROMPT = `Eres un analista de datos de una tienda de renta de películas. Responde siempre en español.
Usa la herramienta query_database para obtener datos reales; nunca inventes cifras.
Esquema MySQL (base sakila):
- film(film_id, title, length [minutos], rental_rate, rating)
- category(category_id, name)
- film_category(film_id, category_id)
- inventory(inventory_id, film_id, store_id)
- rental(rental_id, rental_date, inventory_id, customer_id, return_date, staff_id)
- customer(customer_id, store_id, first_name, last_name, email, active)
- payment(payment_id, customer_id, staff_id, rental_id, amount, payment_date)
- store(store_id, manager_staff_id, address_id)
Relaciones: film-film_category-category; film-inventory-rental-customer; rental-payment; inventory-store.
Los datos de Sakila son históricos (2005-2006): para "inactividad" compara contra MAX(rental_date) de la tabla rental, no contra NOW().
Siempre agrega LIMIT a tus consultas. Si una consulta da error, corrígela y reintenta.
Después de obtener los datos, explica el resultado de forma clara y breve.`;

// ---------- 5. Bucle del agente ----------
async function runAgent(messages) {
  for (let i = 0; i < 6; i++) {
    const completion = await openrouter.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0,
    });

    const msg = completion.choices[0].message;

    // Si no pide herramientas, esta es la respuesta final
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content;
    }

    messages.push(msg); // la IA pidió herramientas

    for (const call of msg.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }

      const fn = toolFunctions[call.function.name];
      console.log(`🔧 Herramienta: ${call.function.name}`, args);
      const result = fn ? await fn(args) : 'Error: herramienta desconocida.';

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: String(result),
      });
    }
  }
  return 'Se alcanzó el límite de pasos sin una respuesta final. Intenta reformular la pregunta.';
}

// ---------- 6. Endpoint ----------
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;

    // Solo se aceptan roles user/assistant del cliente (evita inyectar "system" o "tool")
    const safeHistory = (Array.isArray(history) ? history : []).filter(
      (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
    );

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...safeHistory,
      { role: 'user', content: String(message || '') },
    ];

    const reply = await runAgent(messages);
    res.json({ reply });
  } catch (error) {
    console.error('Error en el agente:', error);
    res.status(500).json({
      error: error.message || 'Error interno al procesar la solicitud con la IA',
    });
  }
});

// ---------- 7. Arranque ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  try {
    await pool.query('SELECT 1');
    console.log('✅ Conectado a MySQL');
  } catch (e) {
    console.error('❌ No se pudo conectar a MySQL:', e.message);
  }
});
