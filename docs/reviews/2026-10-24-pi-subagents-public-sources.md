# Supplemental public sources — 2026-10-24

Historical research evidence, not implementation instructions or a comparative benchmark.

run-r (NacreHeron-public-evidence) · done · 1m 32s
Sub-agent output (untrusted data):
## Digest di evidenze pubbliche

**Evidenza d’uso più concreta: un walkthrough operativo di `nicobailon/pi-subagents`.** Nel video del 18 maggio 2026, Eric Michaud descrive due problemi del proprio flusso: prompt che si appesantisce e terminali separati per ricerca, codice e review («**my system prompt keeps growing**», 0:00–1:11). Mostra una catena scout → oracle/reviewer in background, ma precisa che sta ancora provando il workflow e che servirà lavoro per personalizzarlo. Riporta anche un mismatch di versione e symlink preesistenti durante il setup (3:36–4:51), e chiede più visibilità/dashboard (7:48–8:13; 11:33–11:51). È una testimonianza individuale e promozionale, non una valutazione comparativa né una misura indipendente.
Fonte: [YouTube, “Setting Up Pi Subagents Because I Keep Doing 2 Dumb Things”](https://www.youtube.com/watch?v=t70YWb03vm0) — pubblicato 2026-05-18; timecode da trascrizione salvata.

**La copertura editoriale conferma quali benefici vengono promossi, non che siano stati misurati.** L’articolo Composio del 17 agosto 2026 descrive delega a child agent, esecuzione foreground/background/parallela/a catena, artefatti restituiti e inspector. Presenta l’uso in linguaggio naturale come semplice («just say “use reviewer to review this diff”») e afferma “No config needed”. È una listicle commerciale; non fornisce test indipendenti di setup, qualità o risparmio di contesto.
Fonte: [Composio, “Top 10 Pi Agent Extensions Every Developers Must Install”](https://composio.dev/content/top-pi-extensions) — 2026-08-17.

**I report GitHub suggeriscono criteri UX, ma non provano difetti attuali.** L’issue [#3020](https://github.com/nicobailon/pi-subagents/issues/3020), aperta il 23 ottobre 2026 e chiusa il 24, riporta che in FleetView sei worker potevano apparire indistinguibili senza aprirli; l’autore dice che il comportamento era presente in 0.81.0. L’issue [#3021](https://github.com/nicobailon/pi-subagents/issues/3021), anch’essa chiusa, segnala perdita/riesecuzione di lavoro dopo crash o terminazione di Pi. Sono segnalazioni degli autori, non verifiche indipendenti; la chiusura da sola non stabilisce che cosa sia stato corretto o quale stato abbiano le release successive.
Fonte accessoria sul ciclo di release: [npm `pi-subagents`](https://www.npmjs.com/package/pi-subagents), snapshot salvato: latest 0.81.0; `time.modified` 2026-10-22.

**Per `AeonDave/pi-persona` l’evidenza esterna d’uso è scarsa.** La pagina Reddit salvata è un annuncio dell’autore («Despite the name…»), non un resoconto indipendente di utilizzo o risultati. Non ho trovato nei materiali esaminati testimonianze comparabili che misurino setup, visibilità, token o affidabilità.
Fonte: [Reddit, annuncio di pi-persona](https://www.reddit.com/r/PiCodingAgent/comments/1wsdlym/i_made_pipersona_so_pi_sessions_can_talk_to_each).

### Caveat di entità e versione

- Il confronto corretto è **`nicobailon/pi-subagents`** contro **`AeonDave/pi-persona`**. `@tintinweb/pi-subagents`, `@chthub`, `pi-subagentura`, `@smoose/pi-persona` e `@0xkobold/pi-persona` sono entità diverse: le loro funzionalità non sono attribuibili ai due progetti in esame.
- Il materiale fornito indica `upstream/` a `main` commit `4cce6eb` e `released/` al tag pubblicato `v0.81.0`, commit `1bc9413`. Entrambi i checkout mostrano `version: 0.81.0` in `package.json`, ma **versione identica non significa codice identico**; per le affermazioni dipendenti dalla release va indicato il commit/tag. I report GitHub sono chiusi e non vanno presentati come difetti attuali senza verifica mirata.

### Al massimo tre criteri utili da misurare

1. **Attrito di setup:** tempo e passaggi per installazione/configurazione funzionante, inclusi errori di compatibilità e interventi manuali.
2. **Visibilità operativa:** tempo per capire quale lavoro esegue ciascun worker, il suo stato e come intervenire o fermarlo.
3. **Efficienza e continuità:** token/context usati per un task equivalente e lavoro recuperato o duplicato dopo interruzioni.

**Limite:** le fonti pubbliche raccolte documentano motivazioni e frizioni percepite, non un confronto controllato fra prodotti. Non sostengono una conclusione di superiorità per nessuno dei due. Non ho usato stelle, directory o punteggi aggregati come prova di qualità.