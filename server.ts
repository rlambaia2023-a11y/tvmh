// TV Livre MH — servidor local da TV (Bun).
//
// O que ele faz:
//  1) entrega a página da TV (index.html ao lado deste arquivo);
//  2) monta sozinho a lista de canais abertos e gratuitos (iptv-org, Free-TV,
//     Pluto TV, Famelack e os canais de dorama), testando cada link;
//  3) faz o relay das transmissões (/p), que resolve bloqueios de origem e
//     perfis exigidos por algumas emissoras (VLC/Kodi);
//  4) serve a lista para o Kodi/VLC (/lista.m3u) e o guia "Agora / A seguir" (/epg).
//
// Só entram canais que as emissoras transmitem de graça pela internet.
// Nada de TV paga: o filtro PAGOS barra retransmissões não oficiais.
//
// Uso:  bun server.ts            (ou ./iniciar-tv.bat no Windows)
//       PORT=3001                (padrão 3001)
//       TV_DADOS=./dados         (pasta onde a lista testada é guardada)

const MARCA = "TV Livre MH";
const PORTA = Number(Bun.env.PORT) || 3001;

// ---------- A página da TV ----------
const PAGINA_SUBINDO = '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>TV Livre MH</title><body style="background:#0b0f14;color:#e9edf2;font:24px system-ui;display:grid;place-items:center;height:100vh;margin:0">Ligando a TV… a página abre sozinha em instantes.</body>';
let HTML = PAGINA_SUBINDO;
async function carregarPagina(): Promise<void> {
  try {
    const f = Bun.file(join(dirname(fileURLToPath(import.meta.url)), "index.html"));
    if (await f.exists()) {
      const t = await f.text();
      if (t.includes("<html")) { HTML = t; console.log(JSON.stringify({ evt: "pagina", origem: "arquivo", bytes: t.length })); return; }
    }
  } catch (e) { console.log(JSON.stringify({ evt: "pagina_erro", erro: String(e) })); }
}

// ---------- Relay de transmissões ----------
// O player pede /p?u=<link> e o servidor busca o vídeo se passando pelo perfil
// que a emissora aceitar. Bloqueia endereços locais para não virar proxy aberto.
const UA_PADRAO = "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0 Safari/537.36";
const BLOQUEADOS = /^(localhost|0\.|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[|metadata\.)|\.internal$|\.local$/i;
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-length, content-range" };

function alvo(s: string | null): URL | null {
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (BLOQUEADOS.test(u.hostname)) return null;
    return u;
  } catch { return null; }
}

// Perfis tentados quando a emissora responde 403/401: muitas só aceitam players
// conhecidos (VLC, Kodi) ou o próprio site como origem. O servidor lembra qual
// perfil funcionou para cada emissora.
const PERFIS: { ua: string; refDoProprio: boolean }[] = [
  { ua: "", refDoProprio: false },
  { ua: "VLC/3.0.21 LibVLC/3.0.21", refDoProprio: false },
  { ua: "Kodi/21.3 (Windows NT 10.0; Win64; x64) App_Bitness/64 Version/21.3", refDoProprio: false },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", refDoProprio: true },
];
const perfilPorHost = new Map<string, number>();

// Condições que venceram o 403/401 de cada emissora no modo teimoso
// (cookies do site dela e/ou IP alternativo). O relay reaplica sozinho
// nas próximas vezes, sem precisar pedir de novo.
const condicaoPorHost = new Map<string, { cookie?: string; xff?: string }>();
// As condições vencedoras do modo teimoso ficam salvas em disco (dados/condicoes-teimoso.json)
// para sobreviver às reinicializações do servidor.
async function salvarCondicoesTeimoso(): Promise<void> {
  try { await guardar("condicoes-teimoso.json", JSON.stringify([...condicaoPorHost])); } catch {}
}
async function carregarCondicoesTeimoso(): Promise<void> {
  try {
    const s = await ler("condicoes-teimoso.json");
    if (!s) return;
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) for (const [h, c] of arr) {
      if (typeof h === "string" && c && (c.cookie || c.xff)) condicaoPorHost.set(h, c);
    }
    if (condicaoPorHost.size) console.log(JSON.stringify({ evt: "teimoso_condicoes_carregadas", total: condicaoPorHost.size }));
  } catch {}
}
const UA_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const IPS_BR = ["189.63.1.1", "187.44.1.1", "177.92.1.1", "201.48.1.1"];

function cabecalhos(ref: string | null, ua: string | null, range?: string | null): Record<string, string> {
  // identity: alguns servidores (Pluto, por exemplo) marcam a chave do vídeo como
  // gzip sem ela estar comprimida, e a descompressão automática quebrava a transmissão.
  const h: Record<string, string> = { "user-agent": ua || UA_PADRAO, accept: "*/*", "accept-encoding": "identity" };
  if (ref) { h.referer = ref; try { h.origin = new URL(ref).origin; } catch {} }
  if (range) h.range = range;
  return h;
}

async function buscar(u: URL, ref: string | null, ua: string | null, range: string | null, ms: number): Promise<Response> {
  // Se o modo teimoso já venceu essa emissora antes, tenta a condição vencedora primeiro.
  const cond = condicaoPorHost.get(u.host);
  if (cond && (cond.cookie || cond.xff)) {
    try {
      const h = cabecalhos(ref || u.origin + "/", ua || UA_CHROME, range);
      if (cond.cookie) h.cookie = cond.cookie;
      if (cond.xff) h["x-forwarded-for"] = cond.xff;
      const rc = await fetch(u.href, { headers: h, redirect: "follow", signal: AbortSignal.timeout(ms) });
      if (rc.status !== 403 && rc.status !== 401) return rc;
      rc.body?.cancel();
      condicaoPorHost.delete(u.host); // venceu: tenta do zero na próxima
      salvarCondicoesTeimoso();
    } catch {}
  }
  // Pluto TV usa chave própria no link; trocar o perfil não muda nada, então vai direto.
  const tentativas = /pluto\.tv$/i.test(u.hostname) ? 1 : PERFIS.length;
  const inicio = perfilPorHost.get(u.host) ?? 0;
  for (let k = 0; k < tentativas; k++) {
    const i = (inicio + k) % PERFIS.length;
    const p = PERFIS[i];
    const r = await fetch(u.href, {
      headers: { ...cabecalhos(ref || (p.refDoProprio ? u.origin + "/" : null), (i === 0 ? ua : null) || p.ua || null, range), ...(/pluto\.tv$|plutotv\.net$|jmp2\.uk$/i.test(u.hostname) ? { "x-forwarded-for": IP_BR } : {}) },
      redirect: "follow", signal: AbortSignal.timeout(ms),
    });
    if (r.status !== 403 && r.status !== 401) {
      if (i !== 0 || perfilPorHost.has(u.host)) perfilPorHost.set(u.host, i);
      return r;
    }
    if (k === tentativas - 1) return r; // a última resposta volta inteira; as anteriores são descartadas
    r.body?.cancel();
  }
  throw new Error("sem tentativas");
}

// Modo teimoso: quando a emissora recusa a conexão (403/401) mesmo com os perfis,
// tenta condições extras e guarda a que funcionar para aquela emissora:
// 1) cookies do site dela (muitas exigem passar pelo site antes de liberar o vídeo);
// 2) IP brasileiro alternativo (simula a conexão vindo de outro lugar, caso o IP
//    do servidor esteja marcado como robô).
async function buscarTeimoso(u: URL, ref: string | null, ua: string | null, range: string | null, ms: number): Promise<Response> {
  const r = await buscar(u, ref, ua, range, ms);
  if (r.status !== 403 && r.status !== 401) return r;
  r.body?.cancel();
  const host = u.host;
  let cookies = "";
  try {
    const home = await fetch(u.origin + "/", { headers: cabecalhos(null, UA_CHROME), redirect: "follow", signal: AbortSignal.timeout(15000) });
    try {
      const gs = (home.headers as any).getSetCookie;
      const sc: string[] = typeof gs === "function" ? gs.call(home.headers) : [];
      cookies = sc.map((c) => c.split(";")[0]).join("; ");
    } catch {}
    home.body?.cancel();
  } catch (e) {
    console.log(JSON.stringify({ evt: "teimoso_cookies_erro", host, erro: String(e).slice(0, 80) }));
  }
  const tentativas: { cookie?: string; xff?: string }[] = [];
  if (cookies) tentativas.push({ cookie: cookies });
  for (const ip of IPS_BR) {
    if (cookies) tentativas.push({ cookie: cookies, xff: ip });
    tentativas.push({ xff: ip });
  }
  for (const t of tentativas) {
    try {
      const h = cabecalhos(u.origin + "/", UA_CHROME, range);
      if (t.cookie) h.cookie = t.cookie;
      if (t.xff) h["x-forwarded-for"] = t.xff;
      const r2 = await fetch(u.href, { headers: h, redirect: "follow", signal: AbortSignal.timeout(ms) });
      if (r2.status !== 403 && r2.status !== 401) {
        condicaoPorHost.set(host, t);
        salvarCondicoesTeimoso();
        console.log(JSON.stringify({ evt: "teimoso_ok", host, comCookie: !!t.cookie, xff: t.xff || "real" }));
        return r2;
      }
      r2.body?.cancel();
    } catch (e) {
      console.log(JSON.stringify({ evt: "teimoso_tentativa_erro", host, erro: String(e).slice(0, 80) }));
    }
  }
  console.log(JSON.stringify({ evt: "teimoso_falhou", host }));
  return new Response("A emissora recusou a conexão", { status: 403, headers: CORS });
}

function viaRelay(abs: string, ref: string | null, ua: string | null): string {
  let q = "/p?u=" + encodeURIComponent(abs);
  if (ref) q += "&r=" + encodeURIComponent(ref);
  if (ua) q += "&a=" + encodeURIComponent(ua);
  return q;
}

// Reescreve uma playlist HLS para que cada endereço passe pelo relay.
function reescrever(texto: string, base: string, ref: string | null, ua: string | null): string {
  return texto.split(/\r?\n/).map((linha) => {
    const l = linha.trim();
    if (!l) return linha;
    if (l.startsWith("#")) {
      return linha.replace(/URI="([^"]+)"/g, (_m, uri) => {
        try { return 'URI="' + viaRelay(new URL(uri, base).href, ref, ua) + '"'; } catch { return _m; }
      });
    }
    try { return viaRelay(new URL(l, base).href, ref, ua); } catch { return linha; }
  }).join("\n");
}

function ehPlaylist(url: string, tipo: string): boolean {
  return /mpegurl|m3u/i.test(tipo) || /\.m3u8?(\?|$)/i.test(url);
}

async function relay(req: Request, q: URLSearchParams): Promise<Response> {
  const u = alvo(q.get("u"));
  if (!u) return new Response("Endereço inválido", { status: 400, headers: CORS });
  const ref = q.get("r"), ua = q.get("a");
  const teimoso = q.get("teimoso") === "1";
  let res: Response;
  try {
    res = teimoso
      ? await buscarTeimoso(u, ref, ua, req.headers.get("range"), 20000)
      : await buscar(u, ref, ua, req.headers.get("range"), 20000);
  } catch (e) {
    console.log(JSON.stringify({ evt: "relay_erro", host: u.hostname, erro: String(e) }));
    return new Response("Não foi possível alcançar a transmissão", { status: 502, headers: CORS });
  }
  const tipo = res.headers.get("content-type") || "";
  if (res.ok && ehPlaylist(res.url || u.href, tipo)) {
    // Lê como bytes: o Pluto manda a chave do vídeo (16 bytes binários) marcada como
    // playlist. Ler isso como texto estragava a chave e o vídeo não abria.
    const bytes = new Uint8Array(await res.arrayBuffer());
    const comeco = new TextDecoder().decode(bytes.subarray(0, 32)).replace(/^\uFEFF/, "").trimStart();
    if (comeco.startsWith("#EXTM3U")) {
      return new Response(reescrever(new TextDecoder().decode(bytes), res.url || u.href, ref, ua), {
        status: 200,
        headers: { ...CORS, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-cache" },
      });
    }
    return new Response(bytes, { status: res.status, headers: { ...CORS, "content-type": "application/octet-stream", "content-length": String(bytes.length) } });
  }
  const h: Record<string, string> = { ...CORS };
  for (const k of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"]) {
    const v = res.headers.get(k);
    if (v) h[k] = v;
  }
  return new Response(res.body, { status: res.status, headers: h });
}

// Baixa uma lista M3U de terceiros e devolve o texto (usado em Ajustes > fonte externa).
async function listaExterna(q: URLSearchParams): Promise<Response> {
  const u = alvo(q.get("u"));
  if (!u) return new Response("Endereço inválido", { status: 400, headers: CORS });
  try {
    const res = await fetch(u.href, { headers: cabecalhos(null, null), redirect: "follow", signal: AbortSignal.timeout(30000) });
    const texto = await res.text();
    return new Response(texto, { status: res.status, headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } });
  } catch {
    return new Response("Não foi possível baixar a lista", { status: 502, headers: CORS });
  }
}

// Free-TV: tenta o arquivo do Brasil; se não existir, filtra a lista geral pelo grupo Brasil.
async function freeTv(): Promise<Response> {
  const base = Bun.env.FREETV_BASE || "https://raw.githubusercontent.com/Free-TV/IPTV/master/";
  const headers = { ...CORS, "content-type": "text/plain; charset=utf-8" };
  for (const nome of ["playlists/playlist_brazil.m3u8", "playlists/playlist_brasil.m3u8"]) {
    try {
      const r = await fetch(base + nome, { signal: AbortSignal.timeout(20000) });
      if (r.ok) { const t = await r.text(); if (t.includes("#EXTINF")) return new Response(t, { headers }); }
    } catch {}
  }
  try {
    const r = await fetch(base + "playlist.m3u8", { signal: AbortSignal.timeout(30000) });
    const linhas = (await r.text()).split(/\r?\n/);
    const out = ["#EXTM3U"];
    for (let i = 0; i < linhas.length; i++) {
      if (linhas[i].startsWith("#EXTINF") && /bra[sz]il/i.test(linhas[i])) {
        let j = i + 1;
        const bloco = [linhas[i]];
        while (j < linhas.length && linhas[j].startsWith("#")) bloco.push(linhas[j++]);
        if (j < linhas.length) { bloco.push(linhas[j]); out.push(...bloco); }
        i = j;
      }
    }
    return new Response(out.join("\n"), { headers });
  } catch {
    return new Response("Não foi possível baixar a lista do Free-TV", { status: 502, headers: CORS });
  }
}

// Diagnóstico de um canal: segue a transmissão como o player faria (lista mestre,
// variante, chave e primeiro pedaço do vídeo) e mostra o que cada etapa respondeu.
async function diagnostico(q: URLSearchParams): Promise<Response> {
  const etapas: Record<string, unknown>[] = [];
  const ref = q.get("r"), ua = q.get("a");
  async function passo(nome: string, url: string, range: string | null) {
    const u = alvo(url);
    if (!u) { etapas.push({ nome, url, erro: "endereço inválido" }); return null; }
    try {
      const r = await buscar(u, ref, ua, range, 15000);
      const tipo = r.headers.get("content-type") || "";
      const texto = ehPlaylist(r.url || u.href, tipo) ? await r.text() : null;
      if (texto === null) r.body?.cancel();
      etapas.push({ nome, url: u.href.slice(0, 160), final: (r.url || "").slice(0, 160), status: r.status, tipo, codificacao: r.headers.get("content-encoding"), tamanho: r.headers.get("content-length"), inicio: texto ? texto.slice(0, 400) : undefined });
      return texto !== null ? { texto, base: r.url || u.href } : null;
    } catch (e) { etapas.push({ nome, url: u.href.slice(0, 160), erro: String(e) }); return null; }
  }
  const primeiraUrl = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  const m = await passo("mestre", q.get("u") || "", null);
  let media = m;
  if (m && m.texto.includes("#EXT-X-STREAM-INF")) {
    const v = primeiraUrl(m.texto);
    if (v) media = await passo("variante", new URL(v, m.base).href, null);
  }
  if (media) {
    const chave = media.texto.match(/#EXT-X-KEY:[^\n]*URI="([^"]+)"/);
    if (chave) await passo("chave", new URL(chave[1], media.base).href, null);
    const seg = primeiraUrl(media.texto);
    if (seg) await passo("pedaco", new URL(seg, media.base).href, "bytes=0-1023");
  }
  return new Response(JSON.stringify({ etapas }, null, 1), { headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

// ---------- Teste de link ----------
async function verificar(url: string | null, ref: string | null, ua: string | null): Promise<{ ok: boolean; motivo: string }> {
  const json = (ok: boolean, motivo: string) => ({ ok, motivo });
  const u = alvo(url);
  if (!u) return json(false, "endereço inválido");
  try {
    const res = await buscar(u, ref, ua, "bytes=0-65535", 8000);
    if (!res.ok && res.status !== 206) { res.body?.cancel(); return json(false, "HTTP " + res.status); }
    const tipo = res.headers.get("content-type") || "";
    if (!ehPlaylist(res.url || u.href, tipo)) {
      res.body?.cancel();
      // Página de site (YouTube, portal da emissora) não é vídeo que a TV consegue tocar.
      if (/text\/html|json/i.test(tipo) || /youtube\.com|youtu\.be/i.test(res.url || u.href)) return json(false, "página, não vídeo");
      return json(true, "arquivo");
    }
    const texto = await res.text();
    if (!texto.trimStart().startsWith("#EXTM3U")) return json(false, "não é transmissão");
    // Se for playlist mestre, confere a primeira variante também.
    if (texto.includes("#EXT-X-STREAM-INF")) {
      const linhas = texto.split(/\r?\n/);
      const i = linhas.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
      const prox = linhas.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
      if (prox) {
        const v = await buscar(new URL(prox.trim(), res.url || u.href), ref, ua, null, 8000);
        v.body?.cancel();
        if (!v.ok) return json(false, "variante HTTP " + v.status);
      }
    }
    return json(true, "no ar");
  } catch (e) {
    return json(false, String(e).includes("timeout") ? "sem resposta" : "erro de conexão");
  }
}

// Verificação profunda (página Doramas): além da playlist, baixa um pedaço real
// do vídeo e mede a velocidade. Só entra na lista quem baixa rápido o bastante
// para tocar sem travar: pelo menos 1.5x o bitrate da variante mais leve.
async function verificarFundo(url: string | null, ref: string | null, ua: string | null): Promise<{ ok: boolean; motivo: string }> {
  const base = await verificar(url, ref, ua);
  if (!base.ok || base.motivo === "arquivo") return base;
  try {
    const u = alvo(url);
    if (!u) return { ok: false, motivo: "endereço inválido" };
    const r0 = await buscar(u, ref, ua, null, 10000);
    const mestre = await r0.text();
    let texto = mestre, baseHref = r0.url || u.href, bw = 0;
    if (mestre.includes("#EXT-X-STREAM-INF")) {
      const linhas = mestre.split(/\r?\n/);
      const i = linhas.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
      const prox = linhas.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
      if (!prox) return { ok: false, motivo: "sem variante" };
      bw = parseInt((linhas[i].match(/BANDWIDTH=(\d+)/) || [])[1] || "0", 10) || 0;
      const vUrl = new URL(prox.trim(), baseHref);
      const rv = await buscar(vUrl, ref, ua, null, 10000);
      if (!rv.ok) { rv.body?.cancel(); return { ok: false, motivo: "variante HTTP " + rv.status }; }
      texto = await rv.text();
      baseHref = rv.url || vUrl.href;
    }
    const seg = texto.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (!seg) return { ok: false, motivo: "sem pedaços" };
    const t0 = Date.now();
    const rs = await buscar(new URL(seg, baseHref), ref, ua, null, 15000);
    if (!rs.ok && rs.status !== 206) { rs.body?.cancel(); return { ok: false, motivo: "pedaço HTTP " + rs.status }; }
    const buf = await rs.arrayBuffer();
    const ms = Math.max(Date.now() - t0, 1);
    const kbps = Math.round(buf.byteLength * 8 / ms);
    const minimo = Math.max(Math.round(bw * 1.5 / 1000), 800);
    if (kbps < minimo) return { ok: false, motivo: "lento (" + kbps + " kbps)" };
    return { ok: true, motivo: "no ar (" + kbps + " kbps)" };
  } catch (e) {
    return { ok: false, motivo: "erro no pedaço" };
  }
}

async function testar(q: URLSearchParams): Promise<Response> {
  const r = await verificar(q.get("u"), q.get("r"), q.get("a"));
  console.log(JSON.stringify({ evt: "check", host: (alvo(q.get("u"))?.hostname) || "?", ok: r.ok, motivo: r.motivo }));
  return new Response(JSON.stringify(r), { headers: { ...CORS, "content-type": "application/json" } });
}

// ---------- Armazenamento local ----------
// A última lista testada fica em ./dados (canais.json e lista.m3u). Quando o
// servidor reinicia, a TV já recebe os canais na hora, sem esperar a rodada de testes.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const PASTA_DADOS = Bun.env.TV_DADOS || join(dirname(fileURLToPath(import.meta.url)), "dados");
await mkdir(PASTA_DADOS, { recursive: true }).catch(() => {});

async function guardar(nome: string, conteudo: string): Promise<void> {
  try { await Bun.write(join(PASTA_DADOS, nome), conteudo); }
  catch (e) { console.log(JSON.stringify({ evt: "disco_erro", acao: "guardar", nome, erro: String(e) })); }
}
async function ler(nome: string): Promise<string | null> {
  try {
    const f = Bun.file(join(PASTA_DADOS, nome));
    if (await f.exists()) return await f.text();
  } catch (e) { console.log(JSON.stringify({ evt: "disco_erro", acao: "ler", nome, erro: String(e) })); }
  return null;
}
async function salvarLista(): Promise<void> {
  await guardar("canais.json", JSON.stringify({ atualizado: estado.atualizado, canais: estado.canais }));
  await guardar("lista.m3u", textoM3U());
}

// ---------- Teste final automático: roda no fim de tudo ----------
// Verifica se o sistema está funcional e rodando limpo após cada operação
// grande (rebuild, verificação rotativa, inicialização). Não mexe em nada,
// só relata: "ok" ou a lista do que está errado.
function testeFinal(origem: string): void {
  const problemas: string[] = [];
  const total = estado.canais.length;
  if (!total) problemas.push("lista de canais vazia");
  const semUrl = estado.canais.filter((c) => !c.url).length;
  if (semUrl) problemas.push(semUrl + " canal(is) sem URL");
  const semGrupo = estado.canais.filter((c) => !c.group).length;
  if (semGrupo) problemas.push(semGrupo + " canal(is) sem grupo");
  const doramas = estado.canais.filter((c) => c.group === "Doramas").length;
  if (!doramas) problemas.push("grupo Doramas vazio");
  const pluto = estado.canais.filter((c) => c.id.startsWith("pluto:")).length;
  if (!pluto) problemas.push("nenhum canal Pluto na lista");
  const vod = canaisVod().length;
  if (!vod) problemas.push("catálogo Filmes e Séries vazio");
  // EPG carrega 1 min após o boot; no teste de início, ausência ainda não é problema.
  if ((!guia || !guia.ts) && origem !== "inicio") problemas.push("guia EPG sem dados");
  const ok = !problemas.length;
  console.log(JSON.stringify({ evt: "teste_final", origem, ok, total, doramas, pluto, vod, problemas: problemas.length ? problemas : undefined }));
}

// ---------- Lista automática: baixa, testa e guarda só o que funciona ----------
const FONTE_IPTV = Bun.env.FONTE_IPTV || "https://iptv-org.github.io/iptv/countries/br.m3u";
// Coreia do Sul (iptv-org): canais abertos coreanos — MBC Drama, EBS, Arirang e emissoras regionais.
// Os de drama entram no grupo Doramas; os demais ficam no grupo Coreia.
const FONTE_COREIA = Bun.env.FONTE_COREIA || "https://iptv-org.github.io/iptv/countries/kr.m3u";
// Pluto TV Brasil (repositório OwnerPlugins/pluto-tv-m3u, refeito a cada 6 horas com os links do dia).
const FONTE_PLUTO = Bun.env.FONTE_PLUTO || "https://raw.githubusercontent.com/OwnerPlugins/pluto-tv-m3u/main/pluto-live-BR.m3u";
// Segunda lista pronta do Pluto Brasil (BuddyChewChew/pluto, refeita a cada 6 horas), usada como reserva.
const FONTE_PLUTO2 = Bun.env.FONTE_PLUTO2 || "https://raw.githubusercontent.com/BuddyChewChew/pluto/main/pluto_br.m3u";
// Famelack (antigo TV.Garden): base pública em JSON, montada a partir do iptv-org e de outras transmissões abertas.
const FONTE_FAMELACK = Bun.env.FONTE_FAMELACK || "https://raw.githubusercontent.com/famelack/famelack-data/main/tv/raw/countries/br.json";
const SEIS_HORAS = 6 * 60 * 60 * 1000;

// Doramas: canais FAST oficiais e gratuitos (Pluto TV América Latina/Espanha e Samsung TV Plus),
// abertos pelo jmp2.uk. O Pluto Brasil não tem canal de dorama, por isso eles vêm de outros países.
// Nada de sites piratas: só canais que o próprio dono distribui de graça com anúncios.
const DORAMAS: { id: string; nome: string; links: string[] }[] = [
  // Arirang TV: canal público internacional da Coreia, em inglês e gratuito (links da CDN da própria emissora).
  { id: "dorama:arirang", nome: "Arirang TV (Coreia, em inglês)", links: [
    "https://amdlive-ch01-ctnd-com.akamaized.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8",
    "https://amdlive-ch02-ctnd-com.akamaized.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8",
    "https://amdlive-ch03-ctnd-com.akamaized.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8",
  ] },
];
function doramaFontes(): Fonte[] {
  return DORAMAS.flatMap((d) => d.links.map((url) => ({ nome: d.nome, logo: "", grupo: "Doramas", chave: d.id, url, ref: "", ua: "" })));
}

// Canais de dorama da Pluto TV (América Latina e Espanha), gerados direto na API da Pluto.
// O jmp2.uk (atalho usado antes) não responde a partir do Brasil, então estes links são montados
// aqui: sessão na região do canal + URL do stitcher com o token fresquinho.
const DORAMAS_PLUTO = [
  { id: "6185a9a88b2ce30007de5128", ip: "187.188.1.1", nome: "Dramas Coreanos (Pluto TV)" },
  { id: "6661d5424b10960008599fa3", ip: "187.188.1.1", nome: "Dramas Coreanos Teen (Pluto TV)" },
  { id: "6475bfec536e0c0008858e9f", ip: "88.1.1.1", nome: "K-Drama (Pluto TV Espanha)" },
];
const sessoesPlutoRegiao = new Map<string, { boot: any; ts: number }>();
async function bootPlutoRegiao(ip: string): Promise<any> {
  const s = sessoesPlutoRegiao.get(ip);
  if (s && Date.now() - s.ts < 2 * 60 * 60 * 1000) return s.boot;
  const hora = encodeURIComponent(new Date().toISOString());
  const boot = await (await fetch("https://boot.pluto.tv/v4/start?appName=web&appVersion=1.0&deviceVersion=1.0&deviceModel=web&deviceMake=Chrome&deviceType=web&clientID=" + CLIENTE_PLUTO + "&clientModelNumber=1.0.0", {
    headers: { ...H_PLUTO, "x-forwarded-for": ip }, signal: AbortSignal.timeout(20000),
  })).json() as any;
  if (!boot?.sessionToken || !boot?.servers?.stitcher) throw new Error("boot sem sessão para " + ip);
  sessoesPlutoRegiao.set(ip, { boot, ts: Date.now() });
  return boot;
}
async function gerarDoramasPluto(): Promise<Fonte[]> {
  const porIp = new Map<string, typeof DORAMAS_PLUTO>();
  for (const c of DORAMAS_PLUTO) {
    const l = porIp.get(c.ip) || [];
    l.push(c);
    porIp.set(c.ip, l);
  }
  const out: Fonte[] = [];
  for (const [ip, lista] of porIp) {
    try {
      const boot = await bootPlutoRegiao(ip);
      const auth = { ...H_PLUTO, "x-forwarded-for": ip, authorization: "Bearer " + boot.sessionToken };
      const ids = lista.map((c) => c.id).join(",");
      const r = await fetch("https://service-channels.clusters.pluto.tv/v2/guide/channels?channelIds=" + ids, {
        headers: auth, signal: AbortSignal.timeout(20000),
      });
      const j = await r.json() as any;
      const porId = new Map<string, any>(((j?.data || []) as any[]).map((c) => [c.id, c]));
      for (const c of lista) {
        const info = porId.get(c.id);
        if (!info?.stitched?.path) continue;
        const url = boot.servers.stitcher + "/v2" + info.stitched.path + "?" + boot.stitcherParams + "&jwt=" + boot.sessionToken + "&masterJWTPassthrough=true";
        // Versão 720p fixa (só IPv4): trava menos com internet fraca ou latência alta; vira link reserva.
        const url720 = "https://ipv4.pluto.tv/api/tn/video/playout/v2/stitch/hls/channel/" + c.id + "/master.m3u8?" + boot.stitcherParams + "&jwt=" + boot.sessionToken + "&quality=720p&includeExtendedEvents=true&masterJWTPassthrough=true";
        const logo = (info.images && info.images[0] && info.images[0].url) || "";
        out.push({ nome: c.nome, logo, grupo: "Doramas", chave: "dorama:" + c.id, url, ref: "", ua: "" });
        out.push({ nome: c.nome, logo, grupo: "Doramas", chave: "dorama:" + c.id, url: url720, ref: "", ua: "" });
      }
    } catch (e) {
      console.log(JSON.stringify({ evt: "dorama_pluto_erro", ip, erro: String(e).slice(0, 120) }));
    }
  }
  if (out.length) console.log(JSON.stringify({ evt: "doramas_pluto_ok", canais: out.length }));
  return out;
}

// ---------- Gerador próprio de links do Pluto TV ----------
// O servidor pede uma sessão nova ao próprio Pluto (boot.pluto.tv) se apresentando
// como um aparelho no Brasil (cabeçalho X-Forwarded-For com um IP brasileiro) e
// monta os links com a chave fresquinha. Assim não dependemos só de listas de terceiros.
const IP_BR = Bun.env.PLUTO_IP_BR || "200.160.2.3";
const CLIENTE_PLUTO = crypto.randomUUID();
const UA_PLUTO = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15";
const H_PLUTO: Record<string, string> = { "x-forwarded-for": IP_BR, "user-agent": UA_PLUTO, accept: "application/json" };
// A sessão do Pluto vale algumas horas; o gerador e o guia de programação usam a mesma.
let sessaoPluto: { boot: any; ts: number } | null = null;
async function bootPluto(): Promise<any> {
  if (sessaoPluto && Date.now() - sessaoPluto.ts < 2 * 60 * 60 * 1000) return sessaoPluto.boot;
  const hora = encodeURIComponent(new Date().toISOString());
  const boot = await (await fetch("https://boot.pluto.tv/v4/start?appName=web&appVersion=7.9.0-a9cca6b89aea4dc0998b92a51989d2adb9a9025d&deviceVersion=16.2.0&deviceModel=web&deviceMake=Chrome&deviceType=web&clientID=" + CLIENTE_PLUTO + "&clientModelNumber=1.0.0&channelID=5a4d3a00ad95e4718ae8d8db&serverSideAds=true&constraints=&drmCapabilities=&blockingMode=&clientTime=" + hora, { headers: H_PLUTO, signal: AbortSignal.timeout(20000) })).json() as any;
  if (!boot?.sessionToken || !boot?.servers?.stitcher) throw new Error("boot sem sessão");
  sessaoPluto = { boot, ts: Date.now() };
  return boot;
}
async function gerarPlutoBR(): Promise<string> {
  sessaoPluto = null; // links novos pedem sessão nova
  const h = H_PLUTO;
  const boot = await bootPluto();
  const auth = { ...h, authorization: "Bearer " + boot.sessionToken };
  const [canais, cats] = await Promise.all([
    fetch("https://service-channels.clusters.pluto.tv/v2/guide/channels?channelIds=&offset=0&limit=1000&sort=number%3Aasc", { headers: auth, signal: AbortSignal.timeout(20000) }).then((r) => r.json() as any),
    fetch("https://service-channels.clusters.pluto.tv/v2/guide/categories", { headers: auth, signal: AbortSignal.timeout(20000) }).then((r) => r.json() as any).catch(() => ({ data: [] })),
  ]);
  const nomeCat = new Map<string, string>(((cats?.data || []) as any[]).map((c) => [c.id, c.name]));
  const linhas = ["#EXTM3U"];
  for (const c of (canais?.data || []) as any[]) {
    if (!c?.id || !c?.stitched?.path) continue;
    const url = boot.servers.stitcher + "/v2" + c.stitched.path + "?" + boot.stitcherParams + "&jwt=" + boot.sessionToken + "&masterJWTPassthrough=true";
    // Endereço alternativo do Pluto (só IPv4 e qualidade fixa em 720p), que trava menos com internet fraca.
    const url720 = "https://ipv4.pluto.tv/api/tn/video/playout/v2/stitch/hls/channel/" + c.id + "/master.m3u8?" + boot.stitcherParams + "&jwt=" + boot.sessionToken + "&quality=720p&includeExtendedEvents=true&masterJWTPassthrough=true";
    const grupo = (c.categoryIDs && nomeCat.get(c.categoryIDs[0])) || "";
    const logo = (c.images && c.images[0] && c.images[0].url) || "";
    const inf = '#EXTINF:-1 tvg-id="' + c.id + '" tvg-logo="' + logo + '" group-title="' + grupo.replace(/"/g, "'") + '",' + c.name;
    linhas.push(inf, url, inf, url720);
  }
  const pais = (String(boot.stitcherParams || "").match(/country=([A-Z]+)/) || [])[1] || "?";
  console.log(JSON.stringify({ evt: "pluto_gerado", canais: (linhas.length - 1) / 4, pais }));
  return linhas.join("\n");
}
// Junta o gerador próprio com as listas de terceiros. Se uma falhar, as outras seguram.
async function textoPluto(): Promise<string> {
  const baixar = (u: string) => fetch(u, { signal: AbortSignal.timeout(30000) }).then((r) => (r.ok ? r.text() : ""));
  const [gerado, owner, buddy] = await Promise.allSettled([gerarPlutoBR(), baixar(FONTE_PLUTO), baixar(FONTE_PLUTO2)]);
  if (gerado.status === "rejected") console.log(JSON.stringify({ evt: "pluto_gerador_erro", erro: String(gerado.reason) }));
  const txt = (x: PromiseSettledResult<string>) => (x.status === "fulfilled" ? x.value : "");
  return txt(gerado) + "\n" + txt(owner) + "\n" + txt(buddy);
}

const GRUPOS: Record<string, string> = {
  news: "Notícias", entertainment: "Entretenimento", kids: "Infantil", animation: "Infantil", sports: "Esportes",
  religious: "Religioso", music: "Música", movies: "Filmes", series: "Séries", education: "Educação", general: "Geral",
  shop: "Compras", documentary: "Documentários", business: "Negócios", culture: "Cultura", lifestyle: "Estilo de vida",
  legislative: "Governo", outdoor: "Campo e natureza", comedy: "Comédia", cooking: "Culinária", travel: "Viagem",
  auto: "Automóveis", classic: "Clássicos", family: "Família", undefined: "Geral", science: "Ciência", weather: "Clima",
  brazil: "TV aberta", brasil: "TV aberta",
  doramas: "Doramas", coreia: "Coreia",
};
// Recusas que podem ser só do servidor (fora do Brasil): o canal fica como reserva em vez de sair.
function talvezFunciona(chave: string, motivo: string): boolean {
  if (motivo === "HTTP 403") return true;
  return chave.startsWith("pluto:") && /HTTP 4(00|01|03|10|51)|variante HTTP 4|não é transmissão/.test(motivo);
}

type Fonte = { nome: string; logo: string; grupo: string; chave: string; url: string; ref: string; ua: string };
type Canal = { id: string; name: string; logo: string; group: string; url: string; ref: string; ua: string; alts: { url: string; ref: string; ua: string }[]; novoEm?: number; ano?: string; tipo?: string };
const estado: { canais: Canal[]; atualizado: number; atualizando: boolean; revisando: boolean; ultimaTentativa: number; plutoTs: number; plutoRodando: boolean } = { canais: [], atualizado: 0, atualizando: false, revisando: false, ultimaTentativa: 0, plutoTs: 0, plutoRodando: false };

function grupoPt(g: string): string {
  const k = (g || "").split(";")[0].trim();
  return GRUPOS[k.toLowerCase()] || k || "Geral";
}
function limparNome(n: string): string {
  return n.replace(/[\u24B6-\u24E9]/g, "").replace(/\s*\(\d+p\)/gi, "").replace(/\s*\[[^\]]*\]/g, "").trim() || n;
}
function chaveDe(tvgId: string, nome: string): string {
  if (tvgId) return tvgId.split("@")[0].toLowerCase();
  return limparNome(nome).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
// ---------- Filmes e Séries (domínio público, Archive.org) ----------
// Catálogo curado e testado em 2026-10-23: todos os 34 links retornam HTTP 200 video/mp4.
// Os itens VOD não entram na verificação rotativa nem na lista M3U: são servidos direto em /canais.
const VOD_CATALOGO: { slug: string; titulo: string; ano: string; tipo: string; poster: string; url: string }[] = [
  { slug: "a-noite-dos-mortos-vivos", titulo: "A Noite dos Mortos-Vivos", ano: "1968", tipo: "filme", poster: "https://archive.org/services/img/NightOfTheLivingDead1968-Restored", url: "https://archive.org/download/NightOfTheLivingDead1968-Restored/Notld1968Restoration-desktop_512kb.mp4" },
  { slug: "plano-9-do-espa-o-sideral", titulo: "Plano 9 do Espaço Sideral", ano: "1959", tipo: "filme", poster: "https://archive.org/services/img/plan.-9.-from.-outer.-space.-1957", url: "https://archive.org/download/plan.-9.-from.-outer.-space.-1957/Plan%209%20From%20Outer%20Space%20%281957%29%2Fmp4%2FPlan.9.From.Outer.Space.1957.mp4" },
  { slug: "a-casa-na-colina-assombrada", titulo: "A Casa na Colina Assombrada", ano: "1959", tipo: "filme", poster: "https://archive.org/services/img/house_on_haunted_hill_ipod", url: "https://archive.org/download/house_on_haunted_hill_ipod/house_on_haunted_hill_512kb.mp4" },
  { slug: "jejum-de-amor-his-girl-friday", titulo: "Jejum de Amor (His Girl Friday)", ano: "1940", tipo: "filme", poster: "https://archive.org/services/img/his_girl_friday", url: "https://archive.org/download/his_girl_friday/his_girl_friday_512kb.mp4" },
  { slug: "o-estranho-the-stranger", titulo: "O Estranho (The Stranger)", ano: "1946", tipo: "filme", poster: "https://archive.org/services/img/TheStranger_0", url: "https://archive.org/download/TheStranger_0/The_Stranger_512kb.mp4" },
  { slug: "de-repente-suddenly", titulo: "De Repente (Suddenly)", ano: "1954", tipo: "filme", poster: "https://archive.org/services/img/suddenly", url: "https://archive.org/download/suddenly/suddenly_512kb.mp4" },
  { slug: "sherlock-holmes-vestida-para-matar", titulo: "Sherlock Holmes: Vestida para Matar", ano: "1946", tipo: "filme", poster: "https://archive.org/services/img/dressed_to_kill", url: "https://archive.org/download/dressed_to_kill/dressed_to_kill_512kb.mp4" },
  { slug: "as-viagens-de-gulliver", titulo: "As Viagens de Gulliver", ano: "1939", tipo: "filme", poster: "https://archive.org/services/img/gullivers_travels1939", url: "https://archive.org/download/gullivers_travels1939/gullivers_travels1939_512kb.mp4" },
  { slug: "minha-morena-favorita", titulo: "Minha Morena Favorita", ano: "1947", tipo: "filme", poster: "https://archive.org/services/img/my_favorite_brunette", url: "https://archive.org/download/my_favorite_brunette/my_favorite_brunette_512kb.mp4" },
  { slug: "abraham-lincoln", titulo: "Abraham Lincoln", ano: "1930", tipo: "filme", poster: "https://archive.org/services/img/abraham_lincoln", url: "https://archive.org/download/abraham_lincoln/abraham_lincoln_512kb.mp4" },
  { slug: "mclintock", titulo: "McLintock!", ano: "1963", tipo: "filme", poster: "https://archive.org/services/img/mclintok_widescreen", url: "https://archive.org/download/mclintok_widescreen/McLintock_512kb.mp4" },
  { slug: "o-flautista-de-hamelin", titulo: "O Flautista de Hamelin", ano: "1957", tipo: "filme", poster: "https://archive.org/services/img/The_Pied_Piper_of_Hamelin", url: "https://archive.org/download/The_Pied_Piper_of_Hamelin/pied_512kb.mp4" },
  { slug: "a-morte-num-beijo-d-o-a", titulo: "A Morte num Beijo (D.O.A.)", ano: "1949", tipo: "filme", poster: "https://archive.org/services/img/doa-1949", url: "https://archive.org/download/doa-1949/DOA%201950.mp4" },
  { slug: "carnaval-das-almas", titulo: "Carnaval das Almas", ano: "1962", tipo: "filme", poster: "https://archive.org/services/img/CarnivalofSouls", url: "https://archive.org/download/CarnivalofSouls/CarnivalOfSouls_512kb.mp4" },
  { slug: "a-morta-viva-white-zombie", titulo: "A Morta-Viva (White Zombie)", ano: "1932", tipo: "filme", poster: "https://archive.org/services/img/white_zombie", url: "https://archive.org/download/white_zombie/white_zombie_512kb.mp4" },
  { slug: "nosferatu-uma-sinfonia-do-horror", titulo: "Nosferatu: Uma Sinfonia do Horror", ano: "1922", tipo: "filme", poster: "https://archive.org/services/img/Nosferatu_most_complete_version_93_mins.", url: "https://archive.org/download/Nosferatu_most_complete_version_93_mins./Nosferatu_1922_Symphony_of_Horror_512kb.mp4" },
  { slug: "o-general-buster-keaton", titulo: "O General (Buster Keaton)", ano: "1926", tipo: "filme", poster: "https://archive.org/services/img/TheGeneral_201312", url: "https://archive.org/download/TheGeneral_201312/The-General-v2.mp4" },
  { slug: "detour-desvio-maldito", titulo: "Detour: Desvio Maldito", ano: "1945", tipo: "filme", poster: "https://archive.org/services/img/detour-1945", url: "https://archive.org/download/detour-1945/Detour%201945.mp4" },
  { slug: "sita-sings-the-blues", titulo: "Sita Sings the Blues", ano: "2008", tipo: "filme", poster: "https://archive.org/services/img/Sita_Sings_the_Blues", url: "https://archive.org/download/Sita_Sings_the_Blues/Sita_Sings_the_Blues_DVD_NTSC4.mp4" },
  { slug: "viagem-ao-planeta-das-mulheres-pr-hist-ricas", titulo: "Viagem ao Planeta das Mulheres Pré-Históricas", ano: "1967", tipo: "filme", poster: "https://archive.org/services/img/VoyagetothePlanetofPrehistoricWomen", url: "https://archive.org/download/VoyagetothePlanetofPrehistoricWomen/VoyagetothePlanetofPrehistoricWomen_512kb.mp4" },
  { slug: "a-balada-sangrenta-a-bucket-of-blood", titulo: "A Balada Sangrenta (A Bucket of Blood)", ano: "1959", tipo: "filme", poster: "https://archive.org/services/img/ABucketofBlood", url: "https://archive.org/download/ABucketofBlood/Bucket_1959_512kb.mp4" },
  { slug: "a-fera-do-mar-the-fast-and-the-furious", titulo: "A Fera do Mar (The Fast and the Furious)", ano: "1955", tipo: "filme", poster: "https://archive.org/services/img/TheFastandtheFuriousJohnIreland1954goofyrip", url: "https://archive.org/download/TheFastandtheFuriousJohnIreland1954goofyrip/TheFastandtheFuriousJohnIreland1954goofyrip_512kb.mp4" },
  { slug: "sherlock-holmes-1954-s01e01-a-heran-a-cunningham", titulo: "Sherlock Holmes (1954) S01E01 — A Herança Cunningham", ano: "", tipo: "serie", poster: "https://archive.org/services/img/SherlockHolmes1954", url: "https://archive.org/download/SherlockHolmes1954/Sherlock%20Holmes%2001%20The%20Case%20of%20the%20Cunningham%20Heritage.mp4" },
  { slug: "sherlock-holmes-1954-s01e02-o-caso-de-lady-beryl", titulo: "Sherlock Holmes (1954) S01E02 — O Caso de Lady Beryl", ano: "", tipo: "serie", poster: "https://archive.org/services/img/SherlockHolmes1954", url: "https://archive.org/download/SherlockHolmes1954/Sherlock%20Holmes%2002%20The%20Case%20Of%20Lady%20Beryl.mp4" },
  { slug: "sherlock-holmes-1954-s01e03-a-arma-da-pensilv-nia", titulo: "Sherlock Holmes (1954) S01E03 — A Arma da Pensilvânia", ano: "", tipo: "serie", poster: "https://archive.org/services/img/SherlockHolmes1954", url: "https://archive.org/download/SherlockHolmes1954/Sherlock%20Holmes%2003%20The%20Case%20of%20the%20Pennsylvania%20Gun.mp4" },
  { slug: "sherlock-holmes-1954-s01e04-a-vaqueira-do-texas", titulo: "Sherlock Holmes (1954) S01E04 — A Vaqueira do Texas", ano: "", tipo: "serie", poster: "https://archive.org/services/img/SherlockHolmes1954", url: "https://archive.org/download/SherlockHolmes1954/Sherlock%20Holmes%2004%20The%20Case%20Of%20The%20Texas%20Cowgirl.mp4" },
  { slug: "sherlock-holmes-1954-s01e05-o-fantasma-briguento", titulo: "Sherlock Holmes (1954) S01E05 — O Fantasma Briguento", ano: "", tipo: "serie", poster: "https://archive.org/services/img/SherlockHolmes1954", url: "https://archive.org/download/SherlockHolmes1954/Sherlock%20Holmes%2005%20The%20Case%20Of%20The%20Belligerent%20Ghost.mp4" },
  { slug: "sherlock-holmes-1954-s01e06-a-bailarina-t-mida", titulo: "Sherlock Holmes (1954) S01E06 — A Bailarina Tímida", ano: "", tipo: "serie", poster: "https://archive.org/services/img/SherlockHolmes1954", url: "https://archive.org/download/SherlockHolmes1954/Sherlock%20Holmes%2006%20The%20Case%20Of%20The%20Shy%20Ballerina.mp4" },
  { slug: "bonanza-s01e19-a-gangue-da-trilha", titulo: "Bonanza S01E19 — A Gangue da Trilha", ano: "", tipo: "serie", poster: "https://archive.org/services/img/Bonanza_pd", url: "https://archive.org/download/Bonanza_pd/Bonanza%20s01e19.mp4" },
  { slug: "bonanza-s01e20-epis-dio-20", titulo: "Bonanza S01E20 — Episódio 20", ano: "", tipo: "serie", poster: "https://archive.org/services/img/Bonanza_pd", url: "https://archive.org/download/Bonanza_pd/Bonanza%20s01e20.mp4" },
  { slug: "bonanza-s01e21-epis-dio-21", titulo: "Bonanza S01E21 — Episódio 21", ano: "", tipo: "serie", poster: "https://archive.org/services/img/Bonanza_pd", url: "https://archive.org/download/Bonanza_pd/Bonanza%20s01e21.mp4" },
  { slug: "bonanza-s01e22-epis-dio-22", titulo: "Bonanza S01E22 — Episódio 22", ano: "", tipo: "serie", poster: "https://archive.org/services/img/Bonanza_pd", url: "https://archive.org/download/Bonanza_pd/Bonanza%20s01e22.mp4" },
  { slug: "bonanza-s01e23-epis-dio-23", titulo: "Bonanza S01E23 — Episódio 23", ano: "", tipo: "serie", poster: "https://archive.org/services/img/Bonanza_pd", url: "https://archive.org/download/Bonanza_pd/Bonanza%20s01e23.mp4" },
  { slug: "bonanza-s01e24-epis-dio-24", titulo: "Bonanza S01E24 — Episódio 24", ano: "", tipo: "serie", poster: "https://archive.org/services/img/Bonanza_pd", url: "https://archive.org/download/Bonanza_pd/Bonanza%20s01e24.mp4" },
];
function canaisVod(): Canal[] {
  return VOD_CATALOGO.map((v) => ({
    id: "vod:" + v.slug, name: v.titulo, logo: v.poster, group: "Filmes e Séries",
    url: v.url, ref: "", ua: "", alts: [], ano: v.ano, tipo: v.tipo,
  }));
}

function lerM3U(texto: string): Fonte[] {
  const out: Fonte[] = [];
  let cur: Fonte | null = null;
  for (const bruto of texto.split(/\r?\n/)) {
    const l = bruto.trim();
    if (!l) continue;
    if (l.startsWith("#EXTINF")) {
      const at = (k: string) => (l.match(new RegExp(k + '="([^"]*)"', "i")) || [])[1] || "";
      const nome = l.slice(l.lastIndexOf(",") + 1).trim() || at("tvg-name") || "Sem nome";
      cur = { nome, logo: at("tvg-logo"), grupo: at("group-title"), chave: chaveDe(at("tvg-id"), nome), url: "", ref: at("http-referrer"), ua: at("http-user-agent") };
    } else if (cur && /^#EXTVLCOPT:http-referr?er=/i.test(l)) cur.ref = l.slice(l.indexOf("=") + 1).trim();
    else if (cur && /^#EXTVLCOPT:http-user-agent=/i.test(l)) cur.ua = l.slice(l.indexOf("=") + 1).trim();
    else if (!l.startsWith("#") && cur) { cur.url = l; out.push(cur); cur = null; }
  }
  return out;
}
// Só canais abertos e gratuitos: retransmissões de canais de TV paga (links não oficiais) ficam de fora.
// Os canais do Pluto (jmp2.uk / pluto.tv) são gratuitos e nunca passam por este filtro.
const PAGOS = /\b(a&e|adult swim|amc|axn|arte 1|cartoon network|cinemax|combate|discovery|disney|espn|film ?& ?arts|fox|globonews|gloob|gnt|hbo|history|lifetime|megapix|multishow|music box brazil|national geographic|nat ?geo|nickelodeon|paramount|premiere|sony (channel|movies)|space|sportv|studio universal|syfy|telecine|tlc|tnt|travel box brazil|universal tv|canal viva|warner|woohoo|box kids)\b/i;
function naoPago(f: Fonte): boolean {
  if (/jmp2\.uk|pluto\.tv/i.test(f.url)) return true;
  return !PAGOS.test(f.nome);
}
// Lê o JSON do Famelack e devolve só os links de vídeo direto (os de YouTube não tocam no player).
async function famelack(): Promise<Fonte[]> {
  const r = await fetch(FONTE_FAMELACK, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("famelack HTTP " + r.status);
  const dados = await r.json();
  const out: Fonte[] = [];
  for (const c of Array.isArray(dados) ? dados : []) {
    const nome = typeof c?.name === "string" ? c.name.trim() : "";
    const links = Array.isArray(c?.sources?.streams) ? c.sources.streams : [];
    if (!nome) continue;
    for (const u of links) if (typeof u === "string" && /^https?:\/\//i.test(u) && !/youtube|youtu\.be/i.test(u)) out.push({ nome, logo: "", grupo: "", chave: chaveDe("", nome), url: u.trim(), ref: "", ua: "" });
  }
  return out;
}
// Famelack só serve de reserva: o link entra apenas em canal que já veio das outras fontes (mesmo nome).
// Canal que só existe no Famelack fica de fora, porque a origem de alguns links não é garantida.
function juntarPorNome(base: Fonte[], extras: Fonte[]): Fonte[] {
  const porNome = new Map<string, Fonte>();
  for (const f of base) { const k = chaveDe("", f.nome); if (!porNome.has(k)) porNome.set(k, f); }
  const out: Fonte[] = [];
  for (const f of extras) { const m = porNome.get(f.chave); if (m) out.push({ ...f, chave: m.chave, nome: m.nome, logo: m.logo, grupo: m.grupo }); }
  return out;
}
async function emLotes<T, R>(itens: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(itens.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < itens.length) { const k = i++; out[k] = await f(itens[k]); } }));
  return out;
}

async function atualizar(): Promise<void> {
  if (estado.atualizando || estado.revisando) return;
  estado.atualizando = true;
  estado.ultimaTentativa = Date.now();
  const inicio = Date.now();
  try {
    const [free, iptv, coreia, pluto, fame, doramasPluto] = await Promise.allSettled([
      freeTv().then((r) => (r.ok ? r.text() : "")),
      fetch(FONTE_IPTV, { signal: AbortSignal.timeout(30000) }).then((r) => (r.ok ? r.text() : "")),
      fetch(FONTE_COREIA, { signal: AbortSignal.timeout(30000) }).then((r) => (r.ok ? r.text() : "")),
      textoPluto(),
      famelack(),
      gerarDoramasPluto(),
    ]);
    if (fame.status === "rejected") console.log(JSON.stringify({ evt: "famelack_erro", erro: String(fame.reason) }));
    if (coreia.status === "rejected") console.log(JSON.stringify({ evt: "coreia_erro", erro: String(coreia.reason) }));
    // Canais coreanos: os de drama vão para o grupo Doramas, os demais para o grupo Coreia.
    const fontesCoreia = (coreia.status === "fulfilled" ? lerM3U(coreia.value) : []).map((f) => ({
      ...f,
      grupo: /drama|novela/i.test(f.nome) ? "Doramas" : "Coreia",
    }));
    // Free-TV primeiro: são as emissoras abertas oficiais, entram no topo da numeração.
    const principais = [
      ...lerM3U(free.status === "fulfilled" ? free.value : "").map((f) => ({ ...f, grupo: f.grupo || "TV aberta" })),
      ...lerM3U(iptv.status === "fulfilled" ? iptv.value : ""),
      ...fontesCoreia,
      ...doramaFontes(),
      ...(doramasPluto.status === "fulfilled" ? doramasPluto.value : []),
    ];
    // Famelack por último: só dá links reserva aos canais que já existem, sem trazer canais novos.
    const fontes = [...principais, ...juntarPorNome(principais, fame.status === "fulfilled" ? fame.value : [])].filter(naoPago);
    // Pluto TV não passa pelo teste (o servidor fica fora do Brasil e sempre leva recusa).
    // Se a fonte do Pluto falhar, os canais Pluto que já estavam na lista continuam.
    const fontesPluto = plutoFontes(pluto.status === "fulfilled" ? pluto.value : "");
    const canaisPluto = fontesPluto.length ? montarPluto(fontesPluto) : estado.canais.filter((c) => c.id.startsWith("pluto:"));
    if (!fontes.length && !canaisPluto.length) throw new Error("listas vazias");
    const urls = [...new Set(fontes.map((f) => f.url))];
    const porUrl = new Map<string, Fonte>();
    for (const f of fontes) if (!porUrl.has(f.url)) porUrl.set(f.url, f);
    const resultados = await emLotes(urls, 24, async (u) => {
      const f = porUrl.get(u)!;
      // Página Doramas: teste profundo (baixa um pedaço real e mede a velocidade).
      const fundo = f.grupo === "Doramas" || f.grupo === "Coreia";
      return { u, r: await (fundo ? verificarFundo(u, f.ref || null, f.ua || null) : verificar(u, f.ref || null, f.ua || null)) };
    });
    const status = new Map(resultados.map((x) => [x.u, x.r]));
    // Agrupa links do mesmo canal: o primeiro que funciona vira o principal, os outros viram reserva.
    const grupos = new Map<string, Fonte[]>();
    for (const f of fontes) { const g = grupos.get(f.chave) || []; if (!g.some((x) => x.url === f.url)) g.push(f); grupos.set(f.chave, g); }
    const canais: Canal[] = [];
    // Canais novos: só ganha a data de hoje quem NÃO estava na lista anterior (seção "Novos" na página).
    // Quem já estava continua com a data antiga (ou 0 = anterior ao rastreamento, nunca é "novo").
    const antes = new Map(estado.canais.map((c) => [c.id, c.novoEm || 0]));
    const agora = Date.now();
    for (const [chave, lista] of grupos) {
      // 403 fica como reserva: pode ser bloqueio de região que só libera para quem está no Brasil.
      const bons = lista.filter((f) => status.get(f.url)?.ok);
      const talvez = lista.filter((f) => talvezFunciona(chave, status.get(f.url)?.motivo || ""));
      // Página Doramas: só entra quem passou no teste profundo (no ar E sem travar).
      const usar = lista.some((f) => f.grupo === "Doramas" || f.grupo === "Coreia") ? bons : [...bons, ...talvez];
      if (!usar.length) continue;
      const p = usar[0];
      const eraConhecido = antes.has(chave);
      canais.push({
        id: chave, name: limparNome(p.nome), logo: (lista.find((f) => f.logo) || p).logo, group: grupoPt(p.grupo),
        url: p.url, ref: p.ref, ua: p.ua, alts: usar.slice(1).map((f) => ({ url: f.url, ref: f.ref, ua: f.ua })),
        novoEm: eraConhecido ? antes.get(chave)! : agora,
      });
    }
    // Se o teste das outras fontes deu errado de vez (internet do servidor, por exemplo), mantém os canais antigos.
    const abertos = canais.length ? canais : estado.canais.filter((c) => !c.id.startsWith("pluto:"));
    const todos = [...abertos, ...canaisPluto];
    if (todos.length) { estado.canais = todos; estado.atualizado = Date.now(); estado.plutoTs = Date.now(); await salvarLista(); }
    console.log(JSON.stringify({ evt: "lista_atualizada", pluto: canaisPluto.length, plutoDaFonte: fontesPluto.length > 0, fontes: fontes.length, famelack: fame.status === "fulfilled" ? fame.value.length : 0, links: urls.length, canais: todos.length, ms: Date.now() - inicio }));
    testeFinal("atualizar");
  } catch (e) {
    console.log(JSON.stringify({ evt: "lista_erro", erro: String(e), mantidos: estado.canais.length }));
  } finally {
    estado.atualizando = false;
  }
}

// ---------- Verificação horária: todos os canais sempre rodando ----------
// A cada hora o servidor testa o link principal de cada canal. Quem saiu do ar
// ganha uma busca por link novo nas fontes (mesmo canal, outro endereço); só
// sai da lista quem não tem nenhum link funcionando em lugar nenhum.
// Canais do Pluto ficam de fora daqui: o guardião do Pluto já renova eles a cada hora.
/* Núcleo da verificação: testa os links dos canais-alvo e, para quem caiu,
   busca link novo nas fontes (ou remove se não houver). Usado pela rodada
   completa (horária) e pela rotativa (a cada 10 min, 1/6 dos canais por vez). */
async function verificarLote(alvos: Canal[], rotulo: string): Promise<void> {
  const inicio = Date.now();
  try {
    if (!alvos.length) return;
    const testes = await emLotes(alvos, 24, async (c) => {
      const fundo = c.group === "Doramas" || c.group === "Coreia";
      return { c, r: await (fundo ? verificarFundo(c.url, c.ref || null, c.ua || null) : verificar(c.url, c.ref || null, c.ua || null)) };
    });
    // 403/401 (a emissora recusou a conexão) conta como morto em TODOS os canais para
    // entrar na recuperação: o modo teimoso tenta abrir com cookies do site + IP
    // brasileiro antes de qualquer decisão. Doramas/Coreia têm filtro estrito e saem
    // da lista se nada funcionar; os demais ficam (podem voltar sozinhos).
    const mortos = testes.filter((x) => {
      if (x.r.ok) return false;
      const fundo = x.c.group === "Doramas" || x.c.group === "Coreia";
      if (/403|401/.test(x.r.motivo)) return true;
      return fundo || !talvezFunciona(x.c.id, x.r.motivo);
    }).map((x) => x.c);
    // Busca links novos nas fontes para os canais que caíram (doramas da Pluto
    // ganham links fresquinhos aqui também, para a chave não vencer entre as rodadas).
    // Roda mesmo sem mortos: é aqui que os canais NOVOS das fontes são detectados.
    const [free, iptv, fame, doramasFrescos] = await Promise.allSettled([
      freeTv().then((r) => (r.ok ? r.text() : "")),
      fetch(FONTE_IPTV, { signal: AbortSignal.timeout(30000) }).then((r) => (r.ok ? r.text() : "")),
      famelack(),
      gerarDoramasPluto().catch(() => [] as Fonte[]),
    ]);
    if (fame.status === "rejected") console.log(JSON.stringify({ evt: "famelack_erro", onde: "verificacao_" + rotulo, erro: String(fame.reason) }));
    const principais = [
      ...lerM3U(free.status === "fulfilled" ? free.value : "").map((f) => ({ ...f, grupo: f.grupo || "TV aberta" })),
      ...lerM3U(iptv.status === "fulfilled" ? iptv.value : ""),
      ...doramaFontes(),
      ...(doramasFrescos.status === "fulfilled" ? doramasFrescos.value : []),
    ];
    const fontes = [...principais, ...juntarPorNome(principais, fame.status === "fulfilled" ? fame.value : [])].filter(naoPago);
    const porChave = new Map<string, Fonte[]>();
    for (const f of fontes) { const g = porChave.get(f.chave) || []; if (!g.some((x) => x.url === f.url)) g.push(f); porChave.set(f.chave, g); }
    let recuperados = 0;
    const removidos: string[] = [];
    // Em paralelo (8 por vez): cada canal testa o link atual, as reservas e os
    // links novos da fonte; o primeiro que funcionar vira o principal.
    await emLotes(mortos, 8, async (c) => {
      const urlAntiga = c.url;
      const vistos = new Set([c.url, ...c.alts.map((a) => a.url)]);
      const novos = (porChave.get(c.id) || []).filter((f) => !vistos.has(f.url)).map((f) => ({ url: f.url, ref: f.ref, ua: f.ua }));
      const candidatos = [{ url: c.url, ref: c.ref, ua: c.ua }, ...c.alts, ...novos];
      const fundo = c.group === "Doramas" || c.group === "Coreia";
      const res = await Promise.all(candidatos.map((l) => fundo ? verificarFundo(l.url, l.ref || null, l.ua || null) : verificar(l.url, l.ref || null, l.ua || null)));
      const bons = candidatos.filter((_, i) => res[i].ok || (!fundo && talvezFunciona(c.id, res[i].motivo)));
      // Modo teimoso em TODOS os canais: se algum link caiu com 403/401 (a emissora
      // recusou a conexão — geralmente bloqueio geográfico ou exigência de passar pelo
      // site dela), tenta uma vez abrir com cookies do site + IP brasileiro. Se vencer,
      // a condição fica salva em disco e o relay reaplica sozinho nas próximas vezes.
      if (res.some((r) => /403|401/.test(r.motivo))) {
        const u = alvo(c.url);
        if (u) {
          try {
            const rt = await buscarTeimoso(u, c.ref || null, c.ua || null, null, 15000);
            const ok = rt.ok && rt.status !== 403 && rt.status !== 401;
            rt.body?.cancel();
            if (ok) {
              console.log(JSON.stringify({ evt: "teimoso_recuperou", id: c.id }));
              if (fundo) return; // doramas: já estava condenado; agora fica
            }
          } catch {}
        }
      }
      if (!bons.length) { removidos.push(c.id); return; }
      c.url = bons[0].url; c.ref = bons[0].ref; c.ua = bons[0].ua;
      c.alts = bons.slice(1);
      if (bons[0].url !== urlAntiga) recuperados++;
    });
    if (removidos.length) {
      const fora = new Set(removidos);
      estado.canais = estado.canais.filter((c) => !fora.has(c.id));
    }
    // Canais novos nas fontes: testa e sobe para a lista automaticamente quem estiver no ar.
    const idsExistentes = new Set(estado.canais.map((c) => c.id));
    const nomesExistentes = new Set(estado.canais.map((c) => limparNome(c.name).toLowerCase()));
    const chavesNovas = [...porChave.keys()].filter((k) => !idsExistentes.has(k));
    let novosAdicionados = 0;
    await emLotes(chavesNovas.slice(0, 20), 8, async (chave) => {
      const lista = porChave.get(chave)!;
      const p = lista[0];
      const nomeLimpo = limparNome(p.nome).toLowerCase();
      if (nomesExistentes.has(nomeLimpo)) return; // mesmo canal com outra chave
      const ehFundo = (p.grupo || "") === "Doramas" || (p.grupo || "") === "Coreia";
      for (const f of lista.slice(0, 3)) {
        const r = ehFundo ? await verificarFundo(f.url, f.ref || null, f.ua || null) : await verificar(f.url, f.ref || null, f.ua || null);
        if (r.ok || (!ehFundo && talvezFunciona(chave, r.motivo))) {
          const alts: { url: string; ref: string; ua: string }[] = [];
          for (const f2 of lista.slice(1, 4)) {
            if (f2.url === f.url) continue;
            const r2 = await verificar(f2.url, f2.ref || null, f2.ua || null);
            if (r2.ok) alts.push({ url: f2.url, ref: f2.ref, ua: f2.ua });
          }
          estado.canais.push({
            id: chave, name: limparNome(p.nome), logo: p.logo || "",
            group: grupoPt(p.grupo), url: f.url, ref: f.ref, ua: f.ua,
            alts, novoEm: Date.now(),
          });
          nomesExistentes.add(nomeLimpo);
          novosAdicionados++;
          console.log(JSON.stringify({ evt: "canal_novo_adicionado", rotulo, id: chave, nome: limparNome(p.nome) }));
          break;
        }
      }
    });
    estado.atualizado = Date.now();
    await salvarLista();
    console.log(JSON.stringify({ evt: "verificacao_" + rotulo, canais: alvos.length, mortos: mortos.length, recuperados, removidos: removidos.length, novos: novosAdicionados, ms: Date.now() - inicio }));
    testeFinal("verificacao_" + rotulo);
  } catch (e) {
    console.log(JSON.stringify({ evt: "verificacao_" + rotulo + "_erro", erro: String(e) }));
  }
}

async function verificacaoHoraria(): Promise<void> {
  if (estado.atualizando || estado.revisando || estado.plutoRodando) return;
  estado.revisando = true;
  try {
    await verificarLote(estado.canais.filter((c) => !c.id.startsWith("pluto:")), "horaria");
  } finally {
    estado.revisando = false;
  }
}

/* Verificação rotativa a cada 20 min: testa 1/6 dos canais por vez, então cada
   canal é verificado pelo menos 1x a cada 2 horas, mas canal que cai é pego em
   até ~20 min e ganha link novo na hora. Não mexe nos canais do Pluto (o guardião
   deles já renova de hora em hora). */
let loteRotativo = 0;
async function verificacaoRotativa(): Promise<void> {
  if (estado.atualizando || estado.revisando || estado.plutoRodando) return;
  estado.revisando = true;
  try {
    const todos = estado.canais.filter((c) => !c.id.startsWith("pluto:"));
    const n = loteRotativo % 6;
    loteRotativo++;
    const lote = todos.filter((_, i) => i % 6 === n);
    await verificarLote(lote, "rotativa_lote" + (n + 1));
  } finally {
    estado.revisando = false;
  }
}

// ---------- Guardião do Pluto TV ----------
// Os links do Pluto trazem uma chave que vence em poucas horas. O guardião busca links novos
// a cada hora e nunca tira um canal Pluto da lista: se a fonte falhar, os canais de antes ficam.
// Cada canal ganha também um link reserva pelo jmp2.uk, que gera a sessão do Pluto na hora
// e não depende de chave nenhuma.
const PLUTO_ID = /^[0-9a-f]{24}$/;
const UMA_HORA = 60 * 60 * 1000;
function plutoFontes(texto: string): Fonte[] {
  const out: Fonte[] = [];
  for (const f of lerM3U(texto)) {
    const base = { ...f, chave: "pluto:" + f.chave, grupo: "Pluto TV" + (f.grupo ? " · " + f.grupo.split(";")[0].trim() : "") };
    // O link do jmp2.uk vem primeiro: ele foi conferido do servidor e responde "no ar".
    // O link com chave fica de reserva logo atrás.
    if (PLUTO_ID.test(f.chave)) out.push({ ...base, url: "https://jmp2.uk/plu-" + f.chave + ".m3u8", ref: "", ua: "" });
    out.push(base);
  }
  return out;
}
function montarPluto(fontes: Fonte[]): Canal[] {
  const grupos = new Map<string, Fonte[]>();
  for (const f of fontes) { const g = grupos.get(f.chave) || []; if (!g.some((x) => x.url === f.url)) g.push(f); grupos.set(f.chave, g); }
  const out: Canal[] = [];
  for (const [chave, lista] of grupos) {
    const p = lista[0];
    out.push({
      id: chave, name: limparNome(p.nome), logo: (lista.find((f) => f.logo) || p).logo, group: grupoPt(p.grupo),
      url: p.url, ref: p.ref, ua: p.ua, alts: lista.slice(1).map((f) => ({ url: f.url, ref: f.ref, ua: f.ua })),
    });
  }
  return out;
}
async function atualizarPluto(): Promise<void> {
  if (estado.atualizando || estado.plutoRodando) return;
  estado.plutoRodando = true;
  try {
    const fontes = plutoFontes(await textoPluto());
    if (!fontes.length) throw new Error("fonte sem canais");
    const novos = montarPluto(fontes);
    if (estado.atualizando) return; // a atualização completa já cuida do Pluto
    // Canais que saíram da fonte ficam por mais um tempo, com os links antigos, até a próxima rodada completa.
    const ids = new Set(novos.map((c) => c.id));
    const antigos = estado.canais.filter((c) => c.id.startsWith("pluto:") && !ids.has(c.id));
    estado.canais = [...estado.canais.filter((c) => !c.id.startsWith("pluto:")), ...novos, ...antigos];
    estado.plutoTs = Date.now();
    await salvarLista();
    // Amostra: confere 3 links reserva do jmp2.uk para saber se continuam respondendo.
    const amostra = novos.slice(0, 3).map((c) => [c, ...c.alts].find((a) => a.url.includes("jmp2.uk"))?.url).filter(Boolean) as string[];
    const testes = await Promise.all(amostra.map((u) => verificar(u, null, null)));
    console.log(JSON.stringify({ evt: "pluto_renovado", canais: novos.length, mantidos: antigos.length, reservaJmp2: testes.map((t) => t.motivo) }));
  } catch (e) {
    console.log(JSON.stringify({ evt: "pluto_erro", erro: String(e), mantidos: estado.canais.filter((c) => c.id.startsWith("pluto:")).length }));
  } finally {
    estado.plutoRodando = false;
  }
}

// Amostra de 4 MB de bytes aleatórios para o teste de internet da TV (aleatórios para não serem comprimidos no caminho).
const AMOSTRA = new Uint8Array(4 * 1024 * 1024);
for (let i = 0; i < AMOSTRA.length; i += 65536) crypto.getRandomValues(AMOSTRA.subarray(i, i + 65536));

// ---------- Guia de programação (Agora / A seguir) do Pluto TV ----------
// Usa a mesma sessão do gerador e pede ao Pluto a grade das próximas horas, em lotes de canais.
// A TV recebe só o essencial: título, início e fim de até 3 programas por canal.
type Programa = { t: string; s: number; e: number; d?: string };
const guia: { porCanal: Record<string, Programa[]>; ts: number; rodando: boolean } = { porCanal: {}, ts: 0, rodando: false };
async function atualizarGuia(): Promise<void> {
  if (guia.rodando) return;
  guia.rodando = true;
  const inicio = Date.now();
  try {
    const ids = estado.canais.filter((c) => c.id.startsWith("pluto:")).map((c) => c.id.slice(6)).filter((x) => PLUTO_ID.test(x));
    if (!ids.length) throw new Error("sem canais Pluto");
    const boot = await bootPluto();
    const auth = { ...H_PLUTO, authorization: "Bearer " + boot.sessionToken };
    const agora = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const lotes: string[][] = [];
    for (let i = 0; i < ids.length; i += 80) lotes.push(ids.slice(i, i + 80));
    const novo: Record<string, Programa[]> = {};
    let erros = 0;
    await emLotes(lotes, 3, async (lote) => {
      try {
        const r = await fetch("https://service-channels.clusters.pluto.tv/v2/guide/timelines?start=" + encodeURIComponent(agora) + "&channelIds=" + lote.join(",") + "&duration=300", { headers: auth, signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json() as any;
        for (const c of (j?.data || []) as any[]) {
          const progs: Programa[] = [];
          for (const t of (c?.timelines || []) as any[]) {
            const s = Date.parse(t.start), e = Date.parse(t.stop);
            if (!s || !e) continue;
            const serie = t.episode?.series?.name, ep = t.episode?.name;
            const titulo = String(t.title || serie || ep || "").trim();
            if (!titulo) continue;
            const d = String(t.episode?.description || "").trim().slice(0, 220);
            progs.push(d ? { t: titulo, s, e, d } : { t: titulo, s, e });
          }
          if (progs.length) novo["pluto:" + String(c.channelId).toLowerCase()] = progs.sort((a, b) => a.s - b.s);
        }
      } catch (e) { erros++; console.log(JSON.stringify({ evt: "guia_lote_erro", erro: String(e) })); }
    });
    if (Object.keys(novo).length) { guia.porCanal = novo; guia.ts = Date.now(); }
    console.log(JSON.stringify({ evt: "guia_atualizado", canais: Object.keys(novo).length, lotes: lotes.length, erros, ms: Date.now() - inicio }));
  } catch (e) {
    console.log(JSON.stringify({ evt: "guia_erro", erro: String(e) }));
  } finally {
    guia.rodando = false;
  }
}
function guiaRota(): Response {
  if (Date.now() - guia.ts > 30 * 60 * 1000 && !guia.rodando) atualizarGuia();
  const agora = Date.now();
  const out: Record<string, Programa[]> = {};
  for (const [id, progs] of Object.entries(guia.porCanal)) {
    const vivos = progs.filter((p) => p.e > agora).slice(0, 3);
    if (vivos.length) out[id] = vivos;
  }
  return new Response(JSON.stringify({ atualizado: guia.ts, guia: out }), {
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
  });
}

function canaisRota(q: URLSearchParams): Response {
  const velha = Date.now() - estado.atualizado > SEIS_HORAS;
  const forcar = q.get("forcar") === "1" && Date.now() - estado.ultimaTentativa > 10 * 60 * 1000;
  if ((velha || forcar) && !estado.atualizando) atualizar();
  const todos = [...estado.canais, ...canaisVod()];
  return new Response(JSON.stringify({ atualizado: estado.atualizado, atualizando: estado.atualizando, total: todos.length, canais: todos }), {
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
  });
}

// A TV avisa quando um canal não abriu; o servidor reconfere os links dele na hora.
const reconferido = new Map<string, number>();
async function falhou(q: URLSearchParams): Promise<Response> {
  const id = q.get("id") || "";
  const resp = (removido: boolean) => new Response(JSON.stringify({ removido }), { headers: { ...CORS, "content-type": "application/json" } });
  const c = estado.canais.find((x) => x.id === id);
  if (!c || Date.now() - (reconferido.get(id) || 0) < 5 * 60 * 1000) return resp(false);
  reconferido.set(id, Date.now());
  // Pluto TV nunca sai da lista por falha: o servidor busca links novos do Pluto na hora.
  if (id.startsWith("pluto:")) {
    console.log(JSON.stringify({ evt: "falha_relatada", id, acao: "renovar pluto" }));
    if (Date.now() - estado.plutoTs > 10 * 60 * 1000) atualizarPluto();
    return resp(false);
  }
  const links = [{ url: c.url, ref: c.ref, ua: c.ua }, ...c.alts];
  const fundo = c.group === "Doramas" || c.group === "Coreia";
  const testes = await Promise.all(links.map(async (l) => ({ l, r: await (fundo ? verificarFundo(l.url, l.ref || null, l.ua || null) : verificar(l.url, l.ref || null, l.ua || null)) })));
  const bons = testes.filter((t) => t.r.ok).map((t) => t.l).concat(fundo ? [] : testes.filter((t) => !t.r.ok && talvezFunciona(id, t.r.motivo)).map((t) => t.l));
  console.log(JSON.stringify({ evt: "falha_relatada", id, links: links.length, bons: bons.length, motivos: testes.map((t) => t.r.motivo) }));
  const j = estado.canais.findIndex((x) => x.id === id);
  if (j < 0) return resp(false);
  if (!bons.length) { estado.canais.splice(j, 1); await salvarLista(); return resp(true); }
  estado.canais[j] = { ...c, url: bons[0].url, ref: bons[0].ref, ua: bons[0].ua, alts: bons.slice(1) };
  return resp(false);
}

// Lista no formato M3U para o Kodi (PVR IPTV Simple Client) e outros players.
function textoM3U(): string {
  const q = (t: string) => t.replace(/"/g, "'");
  const linhas = ["#EXTM3U"];
  estado.canais.forEach((c, i) => {
    linhas.push('#EXTINF:-1 tvg-chno="' + (i + 1) + '" tvg-id="' + q(c.id) + '" tvg-logo="' + q(c.logo) + '" group-title="' + q(c.group) + '",' + c.name);
    if (c.ref) linhas.push("#EXTVLCOPT:http-referrer=" + c.ref);
    if (c.ua) linhas.push("#EXTVLCOPT:http-user-agent=" + c.ua);
    linhas.push(c.url);
  });
  return linhas.join("\n") + "\n";
}
function listaM3U(): Response {
  return new Response(textoM3U(), { headers: { ...CORS, "content-type": "audio/x-mpegurl; charset=utf-8", "cache-control": "no-cache" } });
}

// ---------- Servidor HTTP ----------
Bun.serve({
  port: PORTA,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { ...CORS, "access-control-allow-headers": "range, content-type", "access-control-allow-methods": "GET, OPTIONS" } });
    }
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/v") return new Response(String(Bun.hash(HTML)));
    if (url.pathname === "/p") return relay(req, url.searchParams);
    if (url.pathname === "/list") return listaExterna(url.searchParams);
    if (url.pathname === "/freetv") return freeTv();
    if (url.pathname === "/lista.m3u") { if (Date.now() - estado.atualizado > SEIS_HORAS && !estado.atualizando) atualizar(); return listaM3U(); }
    if (url.pathname === "/canais") return canaisRota(url.searchParams);
    if (url.pathname === "/falhou") return falhou(url.searchParams);
    if (url.pathname === "/epg") return guiaRota();
    if (url.pathname === "/velocidade") return new Response(AMOSTRA, { headers: { ...CORS, "content-type": "application/octet-stream", "cache-control": "no-store", "content-length": String(AMOSTRA.length) } });
    if (url.pathname === "/check") return testar(url.searchParams);
    if (url.pathname === "/diagnostico") return diagnostico(url.searchParams);
    if (url.pathname === "/revisar") { if (!estado.revisando && !estado.atualizando) verificacaoHoraria(); return new Response(JSON.stringify({ revisando: estado.revisando || estado.atualizando }), { headers: { ...CORS, "content-type": "application/json" } }); }
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  },
});

// Ao ligar: carrega a página e a última lista guardada em ./dados;
// só refaz os testes se a lista tiver mais de 6 horas.
{
  await carregarPagina();
  await carregarCondicoesTeimoso();
  const salvo = await ler("canais.json");
  if (salvo) {
    try {
      const j = JSON.parse(salvo);
      if (Array.isArray(j.canais) && j.canais.length) {
        estado.canais = j.canais.filter((c: Canal) => c.id.startsWith("pluto:") || naoPago({ nome: c.name, url: c.url } as Fonte));
        estado.atualizado = j.atualizado || 0;
      }
    } catch {}
  }
  console.log(JSON.stringify({ evt: "inicio", marca: MARCA, porta: PORTA, dados: PASTA_DADOS, canaisCarregados: estado.canais.length }));
  testeFinal("inicio");
}
console.log(MARCA + " no ar em http://localhost:" + PORTA);
if (Date.now() - estado.atualizado > SEIS_HORAS) atualizar();
// Confere a cada 30 minutos se a lista passou de 6 horas e, se passou, refaz os testes sozinho,
// mesmo que ninguém esteja assistindo.
setInterval(() => { if (Date.now() - estado.atualizado > SEIS_HORAS && !estado.atualizando) atualizar(); }, 30 * 60 * 1000);
// Guardião do Pluto: renova os links ao ligar (se a lista completa não estiver rodando) e depois a cada hora.
setTimeout(() => { if (!estado.atualizando) atualizarPluto(); }, 30 * 1000);
setInterval(() => { if (Date.now() - estado.plutoTs > UMA_HORA - 60 * 1000) atualizarPluto(); }, 15 * 60 * 1000);
// Guia de programação do Pluto: primeira busca 1 minuto depois de ligar, depois a cada 30 minutos.
setTimeout(atualizarGuia, 60 * 1000);
setInterval(() => { if (Date.now() - guia.ts > 25 * 60 * 1000) atualizarGuia(); }, 10 * 60 * 1000);
// Verificação rotativa dos canais: primeira 2 minutos depois de ligar, depois a cada 20 minutos
// (1/6 dos canais por vez, cobertura total a cada 2h). Testa cada canal; quem saiu do ar ganha
// busca de link novo e só sai da lista se não houver nenhum link funcionando.
// Canais novos nas fontes entram sozinhos. O Pluto fica de fora (o guardião já cuida dele a cada hora).
// No fim de cada rodada roda o testeFinal(), que confere se está tudo limpo.
setTimeout(() => { if (!estado.atualizando) verificacaoRotativa(); }, 2 * 60 * 1000);
setInterval(verificacaoRotativa, 20 * 60 * 1000);
