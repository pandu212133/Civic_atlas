/* The sources are read on the server so Safari needs no cross-origin feed access. */
const AIR_ROOT = 'https://newsonair.gov.in';
const DISTRICT_ROOT = 'https://westgodavari.ap.gov.in';
const PIB_ROOT = 'https://www.pib.gov.in';
const AP_REGION = 'Andhra Pradesh';
const EDITION_SOURCES = [
  {name: 'Akashvani · Andhra Pradesh', region: AP_REGION, root: AIR_ROOT, format: 'posts', path: '/wp-json/wp/v2/posts?search=Andhra%20Pradesh&per_page=35&_fields=title,excerpt,link,date_gmt'},
  {name: 'Press Information Bureau', region: 'India', root: PIB_ROOT, format: 'pib', path: '/AllRelease.aspx?reg=3&lang=1'},
  {name: 'Akashvani · National', region: 'India', root: AIR_ROOT, format: 'rss', path: '/category/national/feed/'},
  {name: 'Akashvani · International', region: 'World', root: AIR_ROOT, format: 'rss', path: '/category/international/feed/'},
  {name: 'West Godavari district · తెలుగు', region: AP_REGION, root: DISTRICT_ROOT, format: 'district', path: '/category/news/press-release/'}
];
const AP_PLACES = /\b(andhra pradesh|amaravati|vijayawada|visakhapatnam|tirupati|polavaram|kakinada|rayalaseema|srikakulam|vizianagaram|guntur|nellore|kadapa|kurnool|anantapur)\b/i;
const SYLLABUS_TERMS = [
  ['Environment', /climate|pollution|emissions?|biodiversity|conservation|forest|renewable|wetland|sustainab/i],
  ['Geography', /earthquake|cyclone|river|monsoon|irrigation|rainfall|weather|landslide|reservoir|flood|drought|వరద|తుఫాను/i],
  ['Science', /technology|artificial intelligence|semiconductor|satellite|research|vaccine|space|quantum|science|యాంటీమైక్రోబియల్|సైన్స్/i],
  ['Economy', /economy|economic|inflation|\bgdp\b|banking|production|agricultur|taxation|exports?|employment|budget|వ్యవసాయ|ధాన్యం|పంట|రైతు/i],
  ['International relations', /bilateral|foreign minister|maritime security|treat(?:y|ies)|summit|diplomat|\b(?:unsc|asean|g20|brics)\b|united nations/i],
  ['Ethics', /conflict of interest|integrity|corruption|whistleblower|ethics/i],
  ['History', /archaeolog|heritage|museum|antiquit|ancient|medieval/i],
  ['Governance', /constitution|election|scheme|governance|policy|parliament|legislation|cabinet|supreme court|ఎన్నిక|బ్యాలెట్|నామినేషన్/i]
];
const ENTITIES = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',hellip:'…',rsquo:'’',lsquo:'‘',ldquo:'“',rdquo:'”',ndash:'–',mdash:'—'};
function decodeEntities(value) {
  return String(value || '').replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (match, code) => {
    if (code[0] !== '#') return ENTITIES[code] ?? match;
    const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2),16) : Number(code.slice(1));
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  });
}
function cleanText(value) {
  return decodeEntities(decodeEntities(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
}
function tagBody(xml, tag) {
  return new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(xml)?.[1] || '';
}
function istDay(timestamp) {
  return new Date(timestamp + 19800000).toISOString().slice(0,10);
}
function parseEdition(format, body) {
  if (format === 'posts') {
    const posts = JSON.parse(body);
    if (!Array.isArray(posts)) throw Error('Invalid posts');
    return posts.filter(p => p?.title?.rendered && p.date_gmt).map(p => [p.title.rendered, p.excerpt?.rendered, p.link, p.date_gmt + 'Z']);
  }
  if (format === 'rss') {
    if (!/<rss\b/i.test(body)) throw Error('Invalid RSS');
    return Array.from(body.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi), ([,xml]) =>
      ['title','description','link','pubDate'].map(tag => tagBody(xml,tag)));
  }
  if (format === 'pib') {
    // In the official index each list item contains a release link and its publication date.
    const rows = [];
    for (const [,li] of body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const anchor = /<a\b[^>]*?href=["']([^"']*PressRel(?:ease|ese)Detail\.aspx\?[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(li);
      const date = /Posted on:\s*(\d{1,2} [a-z]{3,9} \d{4})/i.exec(li);
      if (anchor && date) rows.push([anchor[2], '', anchor[1], date[1] + ' 12:00:00 GMT+0530']);
    }
    return rows;
  }
  const rows = [];
  for (const card of body.split(/class=["']pressRelease-content["']/i).slice(1)) {
    const day = /Published on:\s*<\/strong>\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(card);
    const link = /<a\b[^>]*?href=["']([^"']+)["']/i.exec(card);
    if (day && link) rows.push([tagBody(card,'h2'),tagBody(card,'p'),link[1],day[3]+'-'+day[2]+'-'+day[1]+'T00:00:00+05:30']);
  }
  return rows;
}
function checkedUrl(raw, origin) {
  if (!raw) return '';
  try {
    const u = new URL(cleanText(raw),origin);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port ||
        u.hostname.replace(/^www\./,'') !== new URL(origin).hostname.replace(/^www\./,'')) return '';
    u.protocol = 'https:'; u.hostname = u.hostname.replace(/^www\./,''); u.hash = '';
    return u.href;
  } catch { return ''; }
}
async function loadEditionSource(source, today) {
  const info = {name:source.name, region:source.region, status:'unavailable', count:0};
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let body;
    try {
      const response = await fetch(source.root + source.path,{signal:controller.signal, headers:{Accept:'*/*'}});
      if (!response.ok) throw Error('Feed unavailable');
      if (Number(response.headers.get('content-length')) > 4000000) throw Error('Source too large');
      body = await response.text();
      if (body.length > 4000000) throw Error('Source too large');
    } finally {clearTimeout(timeout);}
    const entries = [];
    for (const [headline, excerpt, rawLink, rawDate] of parseEdition(source.format, body)) {
      const title = cleanText(headline).slice(0,350);
      const summary = cleanText(excerpt);
      const url = checkedUrl(rawLink, source.root);
      const timestamp = Date.parse(cleanText(rawDate));
      if (!title || !url || !Number.isFinite(timestamp)) continue;
      const date = istDay(timestamp);
      if (date > today || (source.format === 'posts' && !AP_PLACES.test(title+' '+summary))) continue;
      const region = source.region === 'India' && AP_PLACES.test(title) ? AP_REGION : source.region;
      const topic = SYLLABUS_TERMS.find(([,terms]) => terms.test(title))?.[0] ||
        SYLLABUS_TERMS.find(([,terms]) => terms.test(summary))?.[0] ||
        (region === 'World' ? 'International relations' : 'General studies');
      entries.push({title, summary: summary.length > 340 ? summary.slice(0,340).replace(/\s+\S*$/,'')+'…' : summary,
        url, source:source.name, region, date, topic});
    }
    // The PIB index is ordered by ministry, so retain the newest dated releases across ministries.
    const ranked = entries.sort((a,b) => b.date.localeCompare(a.date) ||
      Number(a.topic === 'General studies') - Number(b.topic === 'General studies'));
    const items = await Promise.all(ranked.slice(0,40).map(async item => {
      const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(item.url));
      item.id = Array.from(new Uint8Array(bytes).slice(0,10),n=>n.toString(16).padStart(2,'0')).join('');
      return item;
    }));
    return {info:{...info,status:items.length ? 'ok':'empty',count:items.length},items};
  } catch {
    return {info,items:[]};
  }
}
function mergeEdition(fresh, old) {
  const counts = new Map(), urls = new Set(), titles = new Set(), items = [];
  for (const item of [...fresh,...old].sort((a,b)=>b.date.localeCompare(a.date))) {
    const titleKey = item.title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu,' ').trim();
    const count = counts.get(item.region) || 0;
    if (urls.has(item.url) || titles.has(titleKey) || count >= 90) continue;
    counts.set(item.region,count+1); urls.add(item.url); titles.add(titleKey); items.push(item);
  }
  return items;
}
function editionResponse(data, ttl) {
  return new Response(JSON.stringify(data), {headers:{'content-type':'application/json; charset=utf-8',
    'cache-control':'public, max-age='+ttl,'x-content-type-options':'nosniff'}});
}
async function readCache(cache, key) {
  try { return await cache?.match(key); } catch { return undefined; }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/edition') return new Response('Not found',{status:404});
    if (request.method !== 'GET') return new Response('Method not allowed',{status:405,headers:{Allow:'GET'}});
    const now = Date.now(), day = istDay(now);
    const cache = globalThis.caches?.default;
    const cacheKey = new Request(url.origin+'/api/edition?day='+day);
    const previousKey = new Request(url.origin+'/api/edition?archive=v1');
    const hit = await readCache(cache,cacheKey);
    if (hit) return hit;
    const [results, previous] = await Promise.all([
      Promise.all(EDITION_SOURCES.map(source=>loadEditionSource(source,day))),
      readCache(cache,previousKey)
    ]);
    let archive = [];
    if (previous) {
      try {archive = (await previous.json()).items || [];} catch { /* Unreadable edge snapshot. */ }
    }
    const items = mergeEdition(results.flatMap(r=>r.items),archive);
    const data = {checkedAt:new Date(now).toISOString(),sources:results.map(r=>r.info),items};
    const untilMidnight = Math.ceil((86400000-(now+19800000)%86400000)/1000);
    const complete = results.every(r=>r.info.status === 'ok');
    const ttl = Math.min(untilMidnight, complete ? 86400 : 900);
    if (cache) {
      const writes = [cache.put(cacheKey,editionResponse(data,ttl))];
      if (items.length) writes.push(cache.put(previousKey,editionResponse(data,7*86400)));
      const stored = Promise.allSettled(writes);
      if (ctx?.waitUntil) ctx.waitUntil(stored); else await stored;
    }
    // The browser may retry after a brief outage; the edge cache controls upstream traffic.
    return editionResponse(data, Math.min(ttl,300));
  }
};
