const express = require('express');
const { translate } = require('@vitalets/google-translate-api');

const app = express();
app.use(express.urlencoded({ extended: true }));

const HE_VOICE = 'Polly.Carmit';
const EN_VOICE = 'Polly.Joanna';

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function spellEnglish(word) {
  const letters = word.toLowerCase().replace(/[^a-z]/g, '').split('');
  return letters.join(' ');
}

function spellHebrew(word) {
  const letters = word.replace(/[^\u0590-\u05FF]/g, '').split('');
  return letters.join(' ');
}

function buildTranslationSay(translation, toLang) {
  const isSingleWord = !translation.trim().includes(' ');
  const targetLangCode = toLang === 'en' ? 'en-US' : 'he-IL';
  const targetVoice = toLang === 'en' ? EN_VOICE : HE_VOICE;

  let block = `<Say language="${targetLangCode}" voice="${targetVoice}">${escapeXml(translation)}</Say>`;

  if (isSingleWord) {
    if (toLang === 'en') {
      const spelled = spellEnglish(translation);
      if (spelled.length > 0) {
        block += `<Pause length="1"/>` +
                 `<Say language="he-IL" voice="${HE_VOICE}">איות:</Say>` +
                 `<Say language="en-US" voice="${EN_VOICE}">${escapeXml(spelled)}</Say>`;
      }
    } else {
      const spelled = spellHebrew(translation);
      if (spelled.length > 0) {
        block += `<Pause length="1"/>` +
                 `<Say language="he-IL" voice="${HE_VOICE}">איות: ${escapeXml(spelled)}</Say>`;
      }
    }
  }

  return block;
}

function postTranslateMenu(dir, translation) {
  const encoded = encodeURIComponent(translation);
  return `
    <Gather numDigits="1" action="/post-translate?dir=${dir}&amp;t=${encoded}" method="POST" timeout="10">
      <Say language="he-IL" voice="${HE_VOICE}">
        לשמוע שוב את התרגום, הקש 1.
        למילה או משפט חדש, הקש 2.
        לתפריט הראשי, הקש 3.
      </Say>
    </Gather>
    <Say language="he-IL" voice="${HE_VOICE}">לא קיבלתי בחירה. להתראות.</Say>
  `;
}

app.post('/voice', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/direction" method="POST" timeout="10">
    <Say language="he-IL" voice="${HE_VOICE}">
      ברוך הבא למתרגם הטלפוני.
      לתרגום מעברית לאנגלית, הקש 1.
      לתרגום מאנגלית לעברית, הקש 2.
    </Say>
  </Gather>
  <Say language="he-IL" voice="${HE_VOICE}">לא קיבלתי בחירה. להתראות.</Say>
</Response>`;
  res.type('text/xml').send(twiml);
});

app.post('/direction', (req, res) => {
  const digit = req.body.Digits;
  if (digit !== '1' && digit !== '2') {
    res.set('Location', '/voice');
    return res.status(307).end();
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/input-method?dir=${digit}" method="POST" timeout="10">
    <Say language="he-IL" voice="${HE_VOICE}">
      להגיד את המילה או המשפט בקול, הקש 1.
      לאיית את האותיות, הקש 2.
    </Say>
  </Gather>
  <Say language="he-IL" voice="${HE_VOICE}">לא קיבלתי בחירה. להתראות.</Say>
</Response>`;
  res.type('text/xml').send(twiml);
});

app.post('/input-method', (req, res) => {
  const dir = req.query.dir;
  const digit = req.body.Digits;

  if (digit !== '1' && digit !== '2') {
    res.set('Location', '/voice');
    return res.status(307).end();
  }

  const sourceLang = dir === '1' ? 'he-IL' : 'en-US';
  const mode = digit === '1' ? 'speak' : 'spell';
  const prompt = digit === '1' ? 'דבר עכשיו.' : 'אייית את האותיות עכשיו, אות אחר אות.';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="${sourceLang}" speechTimeout="auto" action="/translate?dir=${dir}&amp;mode=${mode}" method="POST" timeout="15">
    <Say language="he-IL" voice="${HE_VOICE}">${prompt}</Say>
  </Gather>
  <Say language="he-IL" voice="${HE_VOICE}">לא שמעתי. נחזור לתפריט.</Say>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
  res.type('text/xml').send(twiml);
});

app.post('/translate', async (req, res) => {
  const dir = req.query.dir;
  const mode = req.query.mode;
  const text = (req.body.SpeechResult || '').trim();

  if (!text) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="he-IL" voice="${HE_VOICE}">לא קלטתי את הדיבור. נחזור לתפריט.</Say>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
    return res.type('text/xml').send(twiml);
  }

  let processedText = text;
  if (mode === 'spell') {
    processedText = text.replace(/\s+/g, '');
  }

  const fromLang = dir === '1' ? 'he' : 'en';
  const toLang = dir === '1' ? 'en' : 'he';

  let translation;
  try {
    const result = await translate(processedText, { from: fromLang, to: toLang });
    translation = result.text;
  } catch (e) {
    console.error('Translation error:', e.message);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="he-IL" voice="${HE_VOICE}">שגיאה בתרגום. נחזור לתפריט.</Say>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
    return res.type('text/xml').send(twiml);
  }

  const sayBlock = buildTranslationSay(translation, toLang);
  const menu = postTranslateMenu(dir, translation);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="3"/>
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
    <Say language="he-IL" voice="${HE_VOICE}">
      להגיד את המילה או המשפט בקול, הקש 1.
      לאיית את האותיות, הקש 2.
    </Say>
  </Gather>
  <Say language="he-IL" voice="${HE_VOICE}">להתראות.</Say>
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

  const menu = postTranslateMenu(dir, translation);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${menu}
</Response>`;
  res.type('text/xml').send(twiml);
});

// Callback flow: caller dials a (US) number to avoid being charged for an
// answered international call. We reject the incoming call (no answer = no
// charge to the caller) and immediately call them back, which connects them
// to the translation menu. The callback leg is billed to the Twilio account.
const BASE_URL = process.env.BASE_URL || 'https://translate-phone.onrender.com';
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

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
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });
      if (!r.ok) console.error('Callback create failed:', r.status, await r.text());
    } catch (e) {
      console.error('Callback error:', e.message);
    }
  } else {
    console.error('Missing caller or Twilio credentials; cannot place callback.');
  }

  // Reject the incoming call without answering it (caller is not charged).
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
