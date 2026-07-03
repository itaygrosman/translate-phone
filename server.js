const express = require('express');

const app = express();
app.use(express.urlencoded({ extended: true }));

const BASE_URL = process.env.BASE_URL || 'https://translate-phone.onrender.com';
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const MAX_LISTEN_TRIES = 3;

// Twilio's built-in <Say> does NOT support Hebrew. We generate speech audio via
// Google Translate TTS (proxied through our own /tts endpoint) and play it with
// <Play>. lang: 'iw' = Hebrew, 'en' = English.
function speak(text, lang) {
  const t = String(text || '').trim().slice(0, 190); // Google TTS length cap
  if (!t) return '';
  return `<Play>${BASE_URL}/tts?lang=${lang}&amp;text=${encodeURIComponent(t)}</Play>`;
}
const heb = (text) => speak(text, 'iw');

app.get('/tts', async (req, res) => {
  const text = (req.query.text || '').toString().slice(0, 200);
  const lang = (req.query.lang || 'iw').toString();
  if (!text) return res.status(400).end();
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://translate.google.com/'
      }
    });
    if (!r.ok) { console.error('TTS upstream error:', r.status); return res.status(502).end(); }
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(buf);
  } catch (e) {
    console.error('TTS error:', e.message);
    res.status(502).end();
  }
});

// Robust translation: Google's translate_a endpoint with a MyMemory fallback.
async function translateText(text, from, to) {
  const gsl = from === 'he' ? 'iw' : from;
  const gtl = to === 'he' ? 'iw' : to;
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${gsl}&tl=${gtl}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    const out = (data[0] || []).map(seg => seg[0]).filter(Boolean).join('');
    if (out) return out;
    throw new Error('empty');
  } catch (e) {
    const url2 = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;
    const r2 = await fetch(url2);
    const d2 = await r2.json();
    if (d2.responseData && d2.responseData.translatedText) return d2.responseData.translatedText;
    throw new Error('no translation');
  }
}

function spellEnglish(word) {
  return word.toLowerCase().replace(/[^a-z]/g, '').split('').join(' ');
}
function spellHebrew(word) {
  return word.replace(/[^֐-׿]/g, '').split('').join(' ');
}

function buildTranslationSay(translation, toLang) {
  const isSingleWord = !translation.trim().includes(' ');
  const targetTts = toLang === 'en' ? 'en' : 'iw';
  let block = speak(translation, targetTts);
  if (isSingleWord) {
    if (toLang === 'en') {
      const spelled = spellEnglish(translation);
      if (spelled.length > 0) block += `<Pause length="1"/>` + heb('איות:') + speak(spelled, 'en');
    } else {
      const spelled = spellHebrew(translation);
      if (spelled.length > 0) block += `<Pause length="1"/>` + heb('איות: ' + spelled);
    }
  }
  return block;
}

function postTranslateMenu(dir, translation) {
  const encoded = encodeURIComponent(translation);
  return `
    <Gather numDigits="1" action="/post-translate?dir=${dir}&amp;t=${encoded}" method="POST" timeout="12">
      ${heb('לשמוע שוב את התרגום, הקש 1. למילה או משפט חדש, הקש 2. לתפריט הראשי, הקש 3.')}
    </Gather>
    <Redirect method="POST">/post-translate?dir=${dir}&amp;t=${encoded}&amp;reprompt=1</Redirect>
  `;
}

app.post('/voice', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/direction" method="POST" timeout="10">
    ${heb('ברוך הבא למתרגם הטלפוני. לתרגום מעברית לאנגלית, הקש 1. לתרגום מאנגלית לעברית, הקש 2.')}
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
  res.type('text/xml').send(twiml);
});

app.post('/direction', (req, res) => {
  const digit = req.body.Digits;
  if (digit !== '1' && digit !== '2') {
    return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Redirect method="POST">/voice</Redirect></Response>`);
  }
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/input-method?dir=${digit}" method="POST" timeout="10">
    ${heb('להגיד את המילה או המשפט בקול, הקש 1. לאיית את האותיות, הקש 2.')}
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
  res.type('text/xml').send(twiml);
});

app.post('/input-method', (req, res) => {
  const dir = req.query.dir;
  const digit = req.body.Digits;
  if (digit !== '1' && digit !== '2') {
    return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Redirect method="POST">/voice</Redirect></Response>`);
  }
  const mode = digit === '1' ? 'speak' : 'spell';
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Redirect method="POST">/listen?dir=${dir}&amp;mode=${mode}&amp;try=0</Redirect></Response>`;
  res.type('text/xml').send(twiml);
});

// Speech-capture step with retry. Falls through to a retry (up to MAX) instead
// of dumping the caller back to the main menu.
app.post('/listen', (req, res) => {
  const dir = req.query.dir;
  const mode = req.query.mode;
  const tryN = parseInt(req.query.try || '0', 10);

  if (tryN >= MAX_LISTEN_TRIES) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${heb('לא הצלחתי לשמוע. נחזור לתפריט.')}
  <Redirect method="POST">/voice</Redirect>
</Response>`;
    return res.type('text/xml').send(twiml);
  }

  const sourceLang = dir === '1' ? 'he-IL' : 'en-US';
  const promptText = tryN > 0
    ? (mode === 'speak' ? 'לא שמעתי, נסה שוב. דבר עכשיו.' : 'לא שמעתי, נסה שוב. אייית את האותיות עכשיו.')
    : (mode === 'speak' ? 'דבר עכשיו.' : 'אייית את האותיות עכשיו, אות אחר אות.');

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="${sourceLang}" speechModel="phone_call" enhanced="true" speechTimeout="auto" action="/translate?dir=${dir}&amp;mode=${mode}&amp;try=${tryN}" method="POST" timeout="15">
    ${heb(promptText)}
  </Gather>
  <Redirect method="POST">/listen?dir=${dir}&amp;mode=${mode}&amp;try=${tryN + 1}</Redirect>
</Response>`;
  res.type('text/xml').send(twiml);
});

app.post('/translate', async (req, res) => {
  const dir = req.query.dir;
  const mode = req.query.mode;
  const tryN = parseInt(req.query.try || '0', 10);
  const text = (req.body.SpeechResult || '').trim();
  console.log('STT result:', JSON.stringify({ dir, mode, tryN, text, confidence: req.body.Confidence }));

  // No speech captured -> ask again (retry) rather than going to the menu.
  if (!text) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/listen?dir=${dir}&amp;mode=${mode}&amp;try=${tryN + 1}</Redirect>
</Response>`;
    return res.type('text/xml').send(twiml);
  }

  let processedText = text;
  // Spelling: STT returns letters with spaces/periods ("F r. I e n d. S.") —
  // keep only actual letters (English or Hebrew) and join them into the word.
  if (mode === 'spell') processedText = text.replace(/[^A-Za-z֐-׿]/g, '');

  const fromLang = dir === '1' ? 'he' : 'en';
  const toLang = dir === '1' ? 'en' : 'he';

  let translation;
  try {
    translation = await translateText(processedText, fromLang, toLang);
  } catch (e) {
    console.error('Translation error:', e.message);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${heb('הייתה בעיה בתרגום, ננסה שוב.')}
  <Redirect method="POST">/listen?dir=${dir}&amp;mode=${mode}&amp;try=${tryN + 1}</Redirect>
</Response>`;
    return res.type('text/xml').send(twiml);
  }

  const sayBlock = buildTranslationSay(translation, toLang);
  const menu = postTranslateMenu(dir, translation);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  ${heb('שמעתי:')}
  ${speak(text, dir === '1' ? 'iw' : 'en')}
  <Pause length="1"/>
  ${sayBlock}
  <Pause length="1"/>
  ${menu}
</Response>`;
  res.type('text/xml').send(twiml);
});

app.post('/post-translate', (req, res) => {
  const dir = req.query.dir;
  const translation = decodeURIComponent(req.query.t || '');
  const digit = req.body.Digits;
  const toLang = dir === '1' ? 'en' : 'he';

  if (digit === '1') {
    const sayBlock = buildTranslationSay(translation, toLang);
    const menu = postTranslateMenu(dir, translation);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayBlock}
  <Pause length="1"/>
  ${menu}
</Response>`;
    return res.type('text/xml').send(twiml);
  }

  if (digit === '2') {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/input-method?dir=${dir}" method="POST" timeout="10">
    ${heb('להגיד את המילה או המשפט בקול, הקש 1. לאיית את האותיות, הקש 2.')}
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
    return res.type('text/xml').send(twiml);
  }

  if (digit === '3') {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
    return res.type('text/xml').send(twiml);
  }

  // No / invalid input: re-offer the menu once more.
  const menu = postTranslateMenu(dir, translation);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${menu}
</Response>`;
  res.type('text/xml').send(twiml);
});

// Callback flow: caller dials a (US) number; we reject the inbound call (no
// answer = no charge) and call them back to connect to the translator.
app.post('/incoming', async (req, res) => {
  const caller = (req.body.From || '').trim();
  if (caller && TWILIO_SID && TWILIO_TOKEN && TWILIO_NUMBER) {
    const params = new URLSearchParams();
    params.append('To', caller);
    params.append('From', TWILIO_NUMBER);
    params.append('Url', `${BASE_URL}/voice`);
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      if (!r.ok) console.error('Callback create failed:', r.status, await r.text());
    } catch (e) {
      console.error('Callback error:', e.message);
    }
  } else {
    console.error('Missing caller or Twilio credentials; cannot place callback.');
  }
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Reject reason="busy"/></Response>`;
  res.type('text/xml').send(twiml);
});

app.get('/', (req, res) => {
  res.send('Translate Phone is running. Configure Twilio webhook to POST to /voice (or /incoming for callback mode)');
});

app.post('/voice-get', (req, res) => res.redirect(307, '/voice'));
app.get('/voice', (req, res) => {
  res.set('Allow', 'POST');
  res.status(405).send('Use POST');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
