const ACADEMIC_PREFIXES = ['Prof.', 'Dr.', 'Dean', 'Chair', 'Sir', 'Lady'];
const ACADEMIC_SUFFIXES = ['PhD', 'Litt.D.', 'Oxon.', 'MA, MFA', 'Esq., PhD', 'D.Phil.'];
const SILLY_SURNAMES = ['Snodgrass', 'Von Muffin', 'Quibbleton', 'Crumpet', 'Wafflesworth', 'Bumblewick'];

function buildFallbackMeta(poemText, playerName = 'Poet') {
  const cleanPlayer = String(playerName || 'Poet').trim().slice(0, 24) || 'Poet';
  const seedInput = `${cleanPlayer}:${poemText}`;
  let hash = 0;
  for (let i = 0; i < seedInput.length; i++) {
    hash = (hash * 31 + seedInput.charCodeAt(i)) >>> 0;
  }

  const words = poemText
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const keyword = words.length ? words[hash % words.length] : 'Chaos';
  const capWord = keyword.charAt(0).toUpperCase() + keyword.slice(1).toLowerCase();

  const prefix = ACADEMIC_PREFIXES[hash % ACADEMIC_PREFIXES.length];
  const surname = SILLY_SURNAMES[(hash >>> 3) % SILLY_SURNAMES.length];
  const suffix = ACADEMIC_SUFFIXES[(hash >>> 6) % ACADEMIC_SUFFIXES.length];

  return {
    title: `Treatise on ${capWord} & Mild Regret`,
    author: `${prefix} ${cleanPlayer}ius ${surname}, ${suffix}`,
    source: 'fallback',
  };
}

function extractJsonMeta(raw) {
  if (!raw) return null;
  let parsed = null;
  if (typeof raw === 'object') {
    parsed = raw;
  } else if (typeof raw === 'string') {
    const cleaned = raw.replace(/```json|```/gi, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const title = typeof parsed?.title === 'string' ? parsed.title.trim() : '';
  const author = typeof parsed?.author === 'string' ? parsed.author.trim() : '';
  if (title && author) {
    return {
      title: title.slice(0, 120),
      author: author.slice(0, 100),
    };
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/generate-poem-meta' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const lines = Array.isArray(body.lines)
          ? body.lines.map((l) => String(l || '').trim()).filter(Boolean)
          : [];
        const playerName = String(body.playerName || 'Poet').trim().slice(0, 30) || 'Poet';
        const poemText = lines.join('\n').slice(0, 2000);

        if (!poemText) {
          return Response.json(buildFallbackMeta('Silence', playerName));
        }

        if (!env.AI) {
          return Response.json(buildFallbackMeta(poemText, playerName));
        }

        const aiResult = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
          messages: [
            {
              role: 'system',
              content:
                'You are a pretentious literary critic naming absurd collaborative poems. ' +
                'Respond ONLY with valid JSON containing two keys: "title" and "author". ' +
                '"title" must be a unique, funny, witty poem title (3-8 words) inspired by the poem text. ' +
                '"author" must be a silly, overly fancy academic poet pen name that is a funny spoof/pun/aristocratic remix of the given player name, complete with academic titles or initials (for example, if the player is "Chris", "Prof. Christophilius Von Chrizzo, PhD"; if "Sam", "Dr. Samwellian Q. Samsonite, Litt.D.").',
            },
            {
              role: 'user',
              content: `Player name: "${playerName}"\n\nPoem:\n${poemText}\n\nReturn JSON with "title" and "author":`,
            },
          ],
          max_tokens: 130,
          temperature: 0.9,
        });

        const rawText = aiResult?.response || '';
        const parsed = extractJsonMeta(rawText);
        if (parsed) {
          return Response.json({ ...parsed, source: 'workers-ai' });
        }

        return Response.json(buildFallbackMeta(poemText, playerName));
      } catch {
        return Response.json(buildFallbackMeta('Verse', 'Poet'));
      }
    }

    return env.ASSETS.fetch(request);
  },
};
