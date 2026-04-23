import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Two Supabase clients:
// - supabase: service role for DB operations (bypasses RLS)
// - supabaseAuth: anon key for auth operations (login/register)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

app.set('trust proxy', 1);
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET','POST','PUT','DELETE'] }));
app.use(express.json({ limit: '2mb' }));
app.use('/api/', rateLimit({ 
  windowMs: 60000, max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes.' }
}));
app.use(express.static(path.join(__dirname, '../kakeibo-app')));

// ── Auth middleware ──
function decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // Handle base64url: replace - with + and _ with /, add padding
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch(e) {
    console.error('JWT decode error:', e.message);
    return null;
  }
}

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado.' });
  const payload = decodeJWT(token);
  if (!payload || !payload.sub) {
    console.log('Invalid token payload:', payload);
    return res.status(401).json({ error: 'Token inválido.' });
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    return res.status(401).json({ error: 'Token expirado.' });
  }
  req.user = { id: payload.sub, email: payload.email };
  next();
}

// ══════════════════════════════
// AUTH
// ══════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, lang, currency } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Campos requeridos: email, password, name.' });
  const { data, error } = await supabaseAuth.auth.signUp({ email, password, options: { data: { name, lang: lang||'es', currency: currency||'JPY' } } });
  if (error) return res.status(400).json({ error: error.message });
  await supabase.from('profiles').upsert({ id: data.user.id, name, lang: lang||'es', currency: currency||'JPY' });
  res.json({ success: true, user: data.user, session: data.session });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  console.log('Login attempt:', email);
  console.log('ANON KEY starts with:', (process.env.SUPABASE_ANON_KEY||'').substring(0,20));
  console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error) {
    console.log('Login error:', error.message, error.status, error.code);
    return res.status(401).json({ error: error.message });
  }
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', data.user.id).single();
  res.json({ success: true, user: data.user, session: data.session, profile });
});

app.post('/api/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token requerido.' });
  try {
    const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token });
    if (error || !data.session) return res.status(401).json({ error: 'Sesión expirada. Por favor inicia sesión de nuevo.' });
    res.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
  } catch(e) {
    res.status(401).json({ error: 'Error al renovar sesión.' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', req.user.id).single();
  res.json({ user: req.user, profile });
});

app.put('/api/auth/profile', requireAuth, async (req, res) => {
  const { name, lang, currency, budgets } = req.body;
  const { error } = await supabase.from('profiles').upsert({ id: req.user.id, name, lang, currency, budgets, updated_at: new Date().toISOString() });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ══════════════════════════════
// EXPENSES
// ══════════════════════════════
app.get('/api/expenses', requireAuth, async (req, res) => {
  try {
    const { from, to, category, limit = 500 } = req.query;
    console.log('GET expenses for user:', req.user.id);
    let q = supabase.from('expenses').select('*').eq('user_id', req.user.id).order('date', { ascending: false }).limit(Number(limit));
    if (from) q = q.gte('date', from);
    if (to) q = q.lte('date', to);
    if (category && category !== 'all') q = q.eq('category', category);
    const { data, error, count } = await q;
    console.log('Expenses result - count:', data?.length, 'error:', error?.message);
    if (error) return res.status(500).json({ error: error.message });
    const mapped = (data||[]).map(e => {
      return {
        id: e.id,
        desc: e.description,
        description: e.description,
        category: e.category,
        cat: e.category,
        amount: e.amount,
        amt: e.amount,
        date: e.date,
        note: e.note,
        user_id: e.user_id,
        created_at: e.created_at
      };
    });
    console.log('Mapped first item:', JSON.stringify(mapped[0]));
    res.json({ expenses: mapped });
  } catch(e) {
    console.error('GET expenses error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/expenses', requireAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    const rows = items.map(e => ({ 
      description: e.desc || e.description || 'Sin descripción', 
      category: e.cat || e.category || 'varios', 
      amount: parseFloat(e.amt || e.amount || 0), 
      date: e.date || new Date().toISOString().split('T')[0], 
      note: e.note || '', 
      user_id: req.user.id 
    }));
    console.log('Saving expenses:', JSON.stringify(rows));
    const { data, error } = await supabase.from('expenses').insert(rows).select();
    if (error) {
      console.error('Supabase expenses error:', error.message, error.details, error.hint);
      return res.status(500).json({ error: error.message });
    }
    res.json({ success: true, expenses: data });
  } catch(e) {
    console.error('Expenses endpoint error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/expenses/:id', requireAuth, async (req, res) => {
  await supabase.from('expenses').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ success: true });
});

// ══════════════════════════════
// INCOMES
// ══════════════════════════════
app.get('/api/incomes', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('incomes').select('*').eq('user_id', req.user.id).order('date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ incomes: (data||[]).map(i => ({ ...i, desc: i.description, amt: i.amount })) });
});

app.post('/api/incomes', requireAuth, async (req, res) => {
  try {
    const i = req.body;
    const row = { description: i.desc || i.description, type: i.type || 'otro', freq: i.freq || 'mensual', amount: parseFloat(i.amt||i.amount||0), date: i.date || new Date().toISOString().split('T')[0], note: i.note||'', user_id: req.user.id };
    console.log('Saving income:', JSON.stringify(row));
    const { data, error } = await supabase.from('incomes').insert(row).select();
    if (error) {
      console.error('Supabase incomes error:', error.message, error.details, error.hint);
      return res.status(500).json({ error: error.message });
    }
    res.json({ success: true, income: data[0] });
  } catch(e) {
    console.error('Incomes endpoint error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/incomes/:id', requireAuth, async (req, res) => {
  await supabase.from('incomes').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ success: true });
});

// ══════════════════════════════
// BANK EXPENSES
// ══════════════════════════════
app.get('/api/bank-expenses', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('bank_expenses').select('*').eq('user_id', req.user.id).order('date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ bankExpenses: (data||[]).map(b => ({ ...b, desc: b.description, amt: b.amount, cat: b.category, bankType: b.bank_type, cardName: b.card_name })) });
});

app.post('/api/bank-expenses', requireAuth, async (req, res) => {
  const b = req.body;
  const { data, error } = await supabase.from('bank_expenses').insert({ description: b.desc||b.description, bank_type: b.bankType||b.bank_type, category: b.cat||b.category, card_name: b.cardName||b.card_name||'', amount: b.amt||b.amount, date: b.date, note: b.note||'', user_id: req.user.id }).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, bankExpense: data[0] });
});

// ══════════════════════════════
// SCAN (AI)
// ══════════════════════════════
app.post('/api/scan-receipt', requireAuth, upload.single('image'), async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key no configurada.' });
    const lang = req.body.lang || 'es';
    const currency = req.body.currency || 'JPY';
    let imageBase64, mediaType = 'image/jpeg';
    if (req.file) {
      const buf = await sharp(req.file.buffer).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      imageBase64 = buf.toString('base64');
    } else if (req.body.imageBase64) {
      imageBase64 = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      mediaType = req.body.mediaType || 'image/jpeg';
    } else return res.status(400).json({ error: 'No se recibió imagen.' });

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-5', max_tokens: 2048,
        system: `Analiza recibos (japonés/español/inglés). Categorías: servicios, renta, tarjeta_credito, limp_p, limp_h, comida, hormiga, movilidad, regalo, bancario. Responde SOLO JSON válido.`,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: `Idioma: ${lang}. Moneda: ${currency}. JSON: {"store":"","date":"YYYY-MM-DD","currency":"${currency}","items":[{"nameOriginal":"","nameTranslated":"","amount":0,"quantity":1,"category":"","confidence":0.9}],"subtotal":0,"tax":0,"taxRate":0.1,"total":0,"notes":null}` }
        ]}]
      })
    });
    if (!resp.ok) return res.status(502).json({ error: 'Error al llamar a la IA.' });
    const aiData = await resp.json();
    const raw = aiData.content?.[0]?.text || '';
    try {
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      if (!Array.isArray(parsed.items)) throw new Error();
      res.json({ success: true, receipt: parsed });
    } catch { res.status(422).json({ error: 'No se pudo leer el recibo. Intenta con mejor iluminación.' }); }
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno.' }); }
});

// ══════════════════════════════
// EXPORT
// ══════════════════════════════
const CAT_LABELS = { servicios:'Servicios', renta:'Renta/Hipoteca', tarjeta_credito:'Tarjeta crédito', limp_p:'Limpieza personal', limp_h:'Limpieza hogar', comida:'Comida', hormiga:'Gastos Hormiga', movilidad:'Movilidad', regalo:'Regalos', bancario:'Bancario' };

async function getExportData(userId, from, to) {
  const [e, i, b, p] = await Promise.all([
    supabase.from('expenses').select('*').eq('user_id', userId).gte('date', from).lte('date', to).order('date'),
    supabase.from('incomes').select('*').eq('user_id', userId).order('date'),
    supabase.from('bank_expenses').select('*').eq('user_id', userId).gte('date', from).lte('date', to).order('date'),
    supabase.from('profiles').select('*').eq('id', userId).single(),
  ]);
  return { expenses: e.data||[], incomes: i.data||[], bankExpenses: b.data||[], profile: p.data||{} };
}

// Excel
app.get('/api/export/excel', requireAuth, async (req, res) => {
  const now = new Date();
  const from = req.query.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const to = req.query.to || now.toISOString().split('T')[0];
  const { expenses, incomes, bankExpenses, profile } = await getExportData(req.user.id, from, to);
  const cur = profile.currency || 'JPY';
  const sym = { JPY:'¥', PEN:'S/', MXN:'MX$' }[cur] || '';
  const moneyFmt = `"${sym}"#,##0${cur==='JPY'?'':'.00'}`;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kakeibo App'; wb.created = new Date();

  const GREEN_D = 'FF2D5016', GREEN_L = 'FFEAF3DE', TEAL = 'FF2A6B3C', PURPLE = 'FF3C3489';
  const hFont = { color: { argb: 'FFFFFFFF' }, bold: true, size: 11 };
  const mkHeader = (fill) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: fill } });
  const altFill = mkHeader('FFF7F5F0');

  function addSheet(name, cols, rows, fillArgb) {
    const ws = wb.addWorksheet(name);
    ws.columns = cols;
    const hr = ws.getRow(1);
    hr.font = hFont; hr.height = 22;
    hr.eachCell(c => { c.fill = mkHeader(fillArgb); c.alignment = { vertical:'middle', horizontal:'center' }; c.border = { bottom:{ style:'thin' } }; });
    rows.forEach((row, i) => {
      const r = ws.addRow(row);
      cols.forEach((col, ci) => {
        if (col.money) r.getCell(ci+1).numFmt = moneyFmt;
      });
      if (i % 2 === 1) r.eachCell(c => { if (!c.fill || c.fill.fgColor?.argb === 'FF000000') c.fill = altFill; });
    });
    // total row
    const totalCol = cols.findIndex(c => c.money);
    if (totalCol >= 0) {
      const total = rows.reduce((s, r) => s + (Number(r[totalCol]) || 0), 0);
      const tr = ws.addRow(cols.map((c, i) => i === 0 ? 'TOTAL' : i === totalCol ? total : ''));
      tr.getCell(totalCol+1).numFmt = moneyFmt;
      tr.eachCell(c => { c.fill = mkHeader(GREEN_L); c.font = { bold:true }; });
    }
    ws.columns.forEach(c => { let m = c.header ? String(c.header).length : 8; c.eachCell({ includeEmpty:false }, cell => { const l = cell.value ? String(cell.value).length : 0; if (l>m) m=l; }); c.width = Math.min(m+3, 42); });
    return ws;
  }

  // Summary sheet
  const wsSumm = wb.addWorksheet('Resumen');
  wsSumm.mergeCells('A1:E1');
  const tc = wsSumm.getCell('A1');
  tc.value = `家計簿 Kakeibo — ${from} → ${to}`; tc.font = { bold:true, size:15, color:{ argb: GREEN_D } }; tc.alignment = { horizontal:'center', vertical:'middle' }; wsSumm.getRow(1).height = 30;
  wsSumm.mergeCells('A2:E2'); wsSumm.getCell('A2').value = `${profile.name||''} | ${cur} | Generado: ${new Date().toLocaleDateString('es-ES')}`; wsSumm.getCell('A2').font = { color:{ argb:'FF6B6760' }, size:10 }; wsSumm.getCell('A2').alignment = { horizontal:'center' };
  wsSumm.addRow([]);
  const allExp = [...expenses, ...bankExpenses];
  const totalExp = allExp.reduce((s,e)=>s+e.amount,0), totalInc = incomes.reduce((s,i)=>s+i.amount,0), bal = totalInc - totalExp;
  [['Concepto','Monto'],['Total ingresos',totalInc],['Total gastos',totalExp],['Balance',bal]].forEach((row,i) => {
    const r = wsSumm.addRow(row);
    if (i===0) { r.eachCell(c=>{ c.fill=mkHeader(GREEN_D); c.font=hFont; }); r.height=20; }
    else { r.getCell(2).numFmt=moneyFmt; if(i===3){ r.getCell(2).font={bold:true,color:{argb:bal>=0?TEAL:'FF8B2020'}}; r.getCell(1).font={bold:true}; } }
  });
  wsSumm.addRow([]);
  const ch = wsSumm.addRow(['Categoría','Tipo','Total']); ch.eachCell(c=>{ c.fill=mkHeader(GREEN_D); c.font=hFont; }); ch.height=20;
  const byCat = {}; allExp.forEach(e=>{ byCat[e.category]=(byCat[e.category]||0)+e.amount; });
  Object.entries(byCat).sort((a,b)=>b[1]-a[1]).forEach(([cat,amt],i) => {
    const r = wsSumm.addRow([CAT_LABELS[cat]||cat, ['renta','servicios','tarjeta_credito'].includes(cat)?'Fijo':'Variable', amt]);
    r.getCell(3).numFmt = moneyFmt;
    if (i%2===1) r.eachCell(c=>{ c.fill=altFill; });
  });
  wsSumm.columns = [{width:30},{width:12},{width:20}];

  // Expenses, Incomes, Bank sheets
  const freqMult = { unico:1, diario:30, semanal:4.3, quincenal:2, mensual:1 };
  addSheet('Gastos',
    [{header:'Fecha',key:'date'},{header:'Descripción',key:'desc'},{header:'Categoría',key:'cat'},{header:'Tipo',key:'tipo'},{header:'Monto',key:'amt',money:true},{header:'Nota',key:'note'}],
    expenses.map(e=>[ e.date, e.desc, CAT_LABELS[e.category]||e.category, ['renta','servicios','tarjeta_credito'].includes(e.category)?'Fijo':'Variable', e.amount, e.note||'' ]), GREEN_D);
  addSheet('Ingresos',
    [{header:'Fecha',key:'date'},{header:'Fuente',key:'desc'},{header:'Tipo',key:'type'},{header:'Frecuencia',key:'freq'},{header:'Monto',key:'amt',money:true},{header:'Equiv/mes',key:'monthly',money:true},{header:'Nota',key:'note'}],
    incomes.map(i=>[ i.date, i.desc, i.type, i.freq, i.amount, Math.round(i.amount*(freqMult[i.freq]||1)), i.note||'' ]), TEAL);
  addSheet('Gastos bancarios',
    [{header:'Fecha',key:'date'},{header:'Descripción',key:'desc'},{header:'Tipo cargo',key:'bt'},{header:'Banco/Tarjeta',key:'card'},{header:'Categoría',key:'cat'},{header:'Monto',key:'amt',money:true},{header:'Nota',key:'note'}],
    bankExpenses.map(b=>[ b.date, b.desc, b.bank_type, b.card_name||'', CAT_LABELS[b.category]||b.category, b.amount, b.note||'' ]), PURPLE);

  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="kakeibo-${from}-${to}.xlsx"`);
  await wb.xlsx.write(res); res.end();
});

// PDF
app.get('/api/export/pdf', requireAuth, async (req, res) => {
  const now = new Date();
  const from = req.query.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const to = req.query.to || now.toISOString().split('T')[0];
  const { expenses, incomes, bankExpenses, profile } = await getExportData(req.user.id, from, to);
  const cur = profile.currency || 'JPY';
  const sym = { JPY:'¥', PEN:'S/', MXN:'MX$' }[cur] || '';
  const fa = n => `${sym}${Math.round(n).toLocaleString()}`;

  const doc = new PDFDocument({ margin:40, size:'A4', bufferPages:true, info:{ Title:'Kakeibo Report', Author:profile.name||'Kakeibo' } });
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="kakeibo-${from}-${to}.pdf"`);
  doc.pipe(res);

  const G='#2D5016', GL='#EAF3DE', GR='#6B6760', RE='#8B2020', W=515;
  const allExp = [...expenses,...bankExpenses];
  const totalExp=allExp.reduce((s,e)=>s+e.amount,0), totalInc=incomes.reduce((s,i)=>s+i.amount,0), bal=totalInc-totalExp;

  // Cover header
  doc.rect(40,40,W,56).fill(G);
  doc.fillColor('#fff').fontSize(20).font('Helvetica-Bold').text('家計簿 Kakeibo',55,52);
  doc.fontSize(10).font('Helvetica').text(`${from} → ${to}  ·  ${profile.name||''}  ·  ${cur}`,55,77);

  // KPI boxes
  doc.y = 112;
  const bw = (W-20)/3;
  [['Ingresos',totalInc,'#2A6B3C'],['Gastos',totalExp,RE],['Balance',Math.abs(bal),bal>=0?'#2A6B3C':'#BA7517']].forEach((kpi,i)=>{
    const x=40+i*(bw+10), y=doc.y;
    doc.rect(x,y,bw,54).fill('#F7F5F0').stroke('#E0DDD6');
    doc.fillColor(GR).fontSize(9).font('Helvetica').text(kpi[0],x+10,y+8);
    doc.fillColor(kpi[2]).fontSize(17).font('Helvetica-Bold').text(fa(kpi[1]),x+10,y+22);
    doc.fillColor(GR).fontSize(8).font('Helvetica').text(i===2?(bal>=0?'sobrante':'déficit'):'',x+10,y+42);
  });
  doc.y += 70;

  // Category breakdown
  doc.fillColor(G).fontSize(12).font('Helvetica-Bold').text('Gastos por categoría',40,doc.y);
  doc.moveDown(0.4);
  const byCat={}; allExp.forEach(e=>{byCat[e.category]=(byCat[e.category]||0)+e.amount;});
  const sorted=Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const maxC=sorted[0]?.[1]||1;
  doc.fontSize(9).font('Helvetica');
  sorted.forEach(([cat,amt],i)=>{
    if(doc.y>770){doc.addPage();doc.y=40;}
    const y=doc.y; const bw2=Math.round(amt/maxC*220); const pct=totalExp>0?Math.round(amt/totalExp*100):0;
    if(i%2===0) doc.rect(40,y-2,W,17).fill('#F7F5F0').stroke();
    doc.fillColor('#333').text(CAT_LABELS[cat]||cat,45,y,{width:120});
    doc.rect(170,y+3,bw2,9).fill(cat==='renta'||cat==='servicios'?'#185FA5':G).stroke();
    doc.fillColor(GR).text(`${fa(amt)} (${pct}%)`,400,y,{width:115,align:'right'});
    doc.moveDown(0.75);
  });

  // Expenses table
  const addTable=(title,headers,rows,hColor)=>{
    doc.addPage();
    doc.fillColor(G).fontSize(12).font('Helvetica-Bold').text(title,40,40); doc.y=60;
    doc.rect(40,doc.y,W,18).fill(hColor).stroke();
    doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
    headers.forEach(h=>doc.text(h.text,h.x,doc.y-13,{width:h.w,align:h.align||'left'}));
    doc.moveDown(0.4);
    rows.forEach((row,i)=>{
      if(doc.y>760){doc.addPage();doc.y=40;}
      if(i%2===0) doc.rect(40,doc.y-2,W,15).fill('#F7F5F0').stroke();
      doc.fontSize(8).font('Helvetica');
      row.cells.forEach(c=>{ doc.fillColor(c.color||'#333').text(String(c.text||'').substring(0,c.max||999),c.x,doc.y,{width:c.w,align:c.align||'left'}); });
      doc.moveDown(0.72);
    });
    const total=rows.reduce((s,r)=>{ const mc=r.cells.find(c=>c.isTotal); return s+(mc?Number(mc.raw)||0:0); },0);
    doc.rect(40,doc.y,W,18).fill(GL).stroke();
    doc.fillColor(G).fontSize(10).font('Helvetica-Bold').text('TOTAL',45,doc.y-13,{width:300});
    doc.text(fa(total),400,doc.y-13,{width:115,align:'right'});
  };

  addTable('Detalle de gastos',
    [{text:'Fecha',x:45,w:65},{text:'Descripción',x:115,w:180},{text:'Categoría',x:300,w:100},{text:'Monto',x:405,w:110,align:'right'}],
    expenses.map(e=>({ cells:[{text:e.date,x:45,w:65},{text:e.desc,x:115,w:180,max:36},{text:CAT_LABELS[e.category]||e.category,x:300,w:100},{text:fa(e.amount),x:405,w:110,align:'right',color:RE,isTotal:true,raw:e.amount}] })),
    G);

  addTable('Detalle de ingresos',
    [{text:'Fecha',x:45,w:65},{text:'Fuente',x:115,w:160},{text:'Tipo',x:280,w:80},{text:'Frecuencia',x:365,w:60},{text:'Monto',x:430,w:85,align:'right'}],
    incomes.map(i=>({ cells:[{text:i.date,x:45,w:65},{text:i.desc,x:115,w:160,max:32},{text:i.type,x:280,w:80},{text:i.freq,x:365,w:60},{text:fa(i.amount),x:430,w:85,align:'right',color:'#2A6B3C',isTotal:true,raw:i.amount}] })),
    '#2A6B3C');

  // Page numbers
  const range=doc.bufferedPageRange();
  for(let i=0;i<range.count;i++){
    doc.switchToPage(range.start+i);
    doc.fillColor(GR).fontSize(8).font('Helvetica').text(`家計簿 Kakeibo — Pág. ${i+1}/${range.count} — ${new Date().toLocaleDateString('es-ES')}`,40,810,{width:W,align:'center'});
  }
  doc.end();
});

// Health
app.get('/api/health', (_,res) => res.json({ status:'ok', supabase:!!process.env.SUPABASE_URL, ai:!!process.env.ANTHROPIC_API_KEY }));
app.get('*', (_,res) => res.sendFile(path.join(__dirname,'../kakeibo-app/index.html')));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`\n🌿 Kakeibo → http://localhost:${PORT}`);
  console.log(`   Supabase: ${process.env.SUPABASE_URL?'✓':'✗ MISSING'}`);
  console.log(`   AI key:   ${process.env.ANTHROPIC_API_KEY?'✓':'✗ MISSING'}\n`);
});
