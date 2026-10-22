# TV Livre MH

A TV própria que roda no navegador (inclusive na Smart TV), com os canais abertos
e gratuitos do Brasil já carregados. Roda 100% local: servidor Bun + página web.

## Pastas e arquivos

| Arquivo | Para que serve |
|---|---|
| `server.ts` | O servidor (Bun): monta e testa a lista de canais, faz o relay das transmissões e entrega a lista para o Kodi |
| `index.html` | A página da TV: grade de canais, player, navegação pelo controle remoto e ajustes |
| `dados/canais.json` | A última lista testada (gerada sozinha a cada 6 horas) |
| `dados/lista.m3u` | A mesma lista em M3U |
| `iniciar-tv.bat` | Atalho do Windows: clique duplo para ligar a TV |
| `logs/` | Saída do servidor quando roda pela tarefa agendada |

## Como ligar

Clique duplo em `iniciar-tv.bat`, depois abra **http://localhost:3001** no navegador.

Na primeira vez, baixe o [Bun](https://bun.sh) (instalador para Windows) — é só ele que falta.

## Endereços do servidor

| Endereço | O que devolve |
|---|---|
| `/` | A TV |
| `/lista.m3u` | Lista para o Kodi (PVR IPTV Simple Client), VLC e outros players |
| `/canais` | Lista em JSON, usada pela própria TV |
| `/check?u=<link>` | Testa um link de transmissão |
| `/revisar` | Força agora a verificação horária dos canais |
| `/falhou?id=<canal>` | A TV avisa que o canal não abriu; o servidor reconfere |
| `/epg` | Guia "Agora / A seguir" dos canais do Pluto TV |
| `/velocidade` | 4 MB aleatórios para o teste de internet da TV |
| `/health` | Responde `ok` quando o servidor está de pé |

Variáveis de ambiente (opcionais): `PORT` (padrão 3001), `TV_DADOS` (pasta da lista,
padrão `./dados`), `PLUTO_IP_BR`, `FONTE_IPTV`, `FONTE_PLUTO`, `FONTE_PLUTO2`,
`FONTE_FAMELACK`, `FREETV_BASE`.

## Como a lista se mantém viva

1. O servidor baixa as listas públicas do [iptv-org](https://github.com/iptv-org/iptv) (Brasil),
   do [Free-TV](https://github.com/Free-TV/IPTV), do Pluto TV Brasil e do
   [Famelack](https://github.com/famelack/famelack-data), mais os canais de dorama gratuitos.
2. Testa cada link, junta os links repetidos do mesmo canal e guarda os que funcionam como reserva.
3. Refaz tudo a cada 6 horas, mesmo sem ninguém assistindo. O guardião do Pluto renova
   os links do Pluto a cada hora, e o guia de programação a cada 30 minutos.
4. **Verificação horária**: a cada hora o servidor testa o link principal de cada canal;
   quem saiu do ar ganha uma busca por link novo nas fontes e volta a funcionar sozinho.
   Só sai da lista quem não tem nenhum link funcionando em lugar nenhum.
5. A última lista testada fica em `dados/` — a TV nunca abre vazia.

## Sobre os canais

Só entram canais que as emissoras transmitem de graça pela internet, a partir das
listas públicas acima. Canais pagos ficam de fora; para eles, use a sua assinatura
IPTV em **Ajustes > Lista IPTV** (fica salva só no navegador da TV).

## Usar no Kodi

Configurações > Add-ons > Instalar do repositório > Clientes PVR > **PVR IPTV Simple Client**
> Configurar > Geral. Em "URL da lista M3U", cole o endereço do servidor + `/lista.m3u`
(ex.: `http://localhost:3001/lista.m3u`, ou o endereço público da TV).
