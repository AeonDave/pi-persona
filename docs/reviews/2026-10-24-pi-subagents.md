# Studio comparativo: pi-persona / nicobailon pi-subagents

Data dello studio: 24 ottobre 2026. Il rapporto conserva le conclusioni e il perimetro originali.

**Decisione successiva (24 ottobre, 21:41 UTC):** il proprietario ha autorizzato il pacchetto essenziale; ambito e stato sono riepilogati nella [roadmap](../../ROADMAP.md), mentre le prove finali sono nel [rapporto di verifica](2026-10-25-current-host-cleanup.md). Le formule «nessuna implementazione autorizzata» nel rapporto descrivono lo stato al termine dello studio, non la decisione successiva.

## Integrazione del supervisore Astra 6

Il panel comprende quattro lenti Astra6 e una sintesi Astra6. Luna ha svolto soltanto ricerca supplementare sulle fonti pubbliche recuperate con Tavily.

### Verifica indipendente dei due rilievi

Dopo il panel ho riletto sorgenti e chiamanti e riprodotto entrambi i percorsi con il codice locale di pi-persona. Risultati archiviati: [evidenza delle due riproduzioni](2026-10-24-pi-subagents-evidence.json). Il riproduttore e gli snapshot completi sono nello studio locale `C:/Users/novad/AppData/Local/Temp/pi-subagents-study-20261024/`.

1. **Worktree, gravità alta condizionata al worker che committa.** Repository Git temporaneo reale: modifica A committata, modifica B non committata, nuovo file C. L'export restituisce successo e un diff applicabile contenente B+C ma non A. Dopo l'applicazione alla baseline, A rimane al contenuto iniziale; il worktree temporaneo è rimosso. L'oggetto commit è ancora presente: non è stato dimostrato che ogni possibilità di recupero Git venga immediatamente distrutta.
2. **Decisione senza risposta, gravità media.** Esecuzione diretta della factory con bus non bloccante, timeout e disconnessione simulata: il risultato contiene davvero “proceed using your best judgement”. Il campo delivered può essere true pur senza una risposta. È una contraddizione nel protocollo di supervisione, non un bypass dei permessi OS/tool né una prova che un modello eseguirà un'azione non autorizzata.

Non ho eseguito codice, install/build hook o test del repository esterno. Nessuna modifica ai due sorgenti. Hash di tutti i 407 file tracciati di pi-persona verificati immutati rispetto all'inizio dello studio; le sei modifiche locali precedenti sono conservate.

### Contesto pubblico

I risultati Tavily contengono omonimi diversi: @tintinweb/pi-subagents, pi-subagentura, @smoose/pi-persona non sono i progetti confrontati. Il walkthrough YouTube e l'articolo Composio sostengono soprattutto il valore percepito di onboarding semplice, meno contesto superfluo e visibilità dei worker; non costituiscono un benchmark comparativo. L'annuncio Reddit di pi-persona è dell'autore, non una verifica indipendente. Digest salvato: [fonti pubbliche e limiti](2026-10-24-pi-subagents-public-sources.md). Le estrazioni raw `tavily-*.json` restano nella directory temporanea dello studio; gli URL delle fonti sono conservati nel digest.

### Mia proposta

Prima correggere i due problemi verificati. Poi un pacchetto piccolo: thinking per-leg realmente supportato e dichiarato, risultati terminali bounded recuperabili dopo reload, qualifica del tarball sugli host promessi. Guida/onboarding e contratti strutturati annidati sono le successive opportunità di prodotto. Non importare subito daemon, scheduler, runtime JavaScript o l'intero ecosistema di adapter. Non è supportata né la superiorità generale di pi-persona né una pretesa di prestazioni migliori.

---

## Rapporto completo del panel (fonti e limiti)

Il testo seguente è analisi del panel. Le affermazioni del panel relative a test non eseguiti rimangono corrette per il suo lavoro; le due riproduzioni del supervisore sono documentate sopra.

run-q (council-synthesize) · done · 11m
Sub-agent output (untrusted data):
# Verdetto: **2 issues**

**No: «pi-persona è molto migliore» non è sostenibile.** Pi-persona ha un percorso convincente per il lavoro **supervisionato nella sessione corrente**: deleghe interattive non bloccanti, completion aggregate, intervento sui worker e strategie di review già definite. Ma pi-subagents **già nella versione pubblicata 0.81.0** risolve meglio diversi problemi quotidiani: effort per singola delega, onboarding, amministrazione degli agenti, risultati durevoli, continuazione del lavoro e integrazione programmatica.

Non sono soltanto funzionalità aggiunte per fare volume. Alcune eliminano workaround che abbiamo incontrato realmente, soprattutto **effort per-leg e recupero degli output**.

La raccomandazione non è copiarne l’architettura: **correggere due comportamenti nostri, introdurre effort per-leg e conservare i risultati già pagati; qualificare meglio ciò che distribuiamo.** Processi persistenti, runtime di script e schedulazione rimangono decisioni separate.

## Riferimenti e criterio di lettura

- **P/**: `D:/Sources/pi-persona/`, working tree effettivo: HEAD `c858210e551ad8749d5655f7ee646e6b8fd8b969`, versione 1.17.3, più le sei modifiche locali dichiarate.
- **R/**: pi-subagents **pubblicato 0.81.0**, commit [`1bc941363cb62fc23c94c5519364b03dc150be3e`](https://github.com/nicobailon/pi-subagents/tree/1bc941363cb62fc23c94c5519364b03dc150be3e).
- **M/**: pi-subagents **main non pubblicato**, commit [`4cce6ebf5d4c6d0e45d22549aa687ea28562e4a9`](https://github.com/nicobailon/pi-subagents/tree/4cce6ebf5d4c6d0e45d22549aa687ea28562e4a9), snapshot del 24 ottobre 2026. Il suo `package.json` indica ancora 0.81.0: **non significa che quelle modifiche siano pubblicate**.
- R e M sono negli snapshot `released/` e `upstream/` sotto `C:/Users/novad/AppData/Local/Temp/pi-subagents-study-20261024/`.

Le conclusioni descrivono capacità e percorsi riscontrati, non superiorità della qualità delle risposte dei modelli. **Nessun benchmark comparativo è disponibile.**

---

## 1. Contraddizioni risolte

### «LGTM» delle altre lenti contro i due problemi di affidabilità

**Accolgo i due rilievi RELIABILITY**, non una media dei verdetti. Ho riletto direttamente implementazione, chiamante e test:

1. l’export del worktree usa davvero l’`HEAD` finale;
2. una richiesta `decision` rimasta senza risposta può davvero restituire «proceed using your best judgement».

I verdetti PRODUCT, WORKFLOWS e PERFORMANCE significano che quelle lenti non avevano dimostrato difetti bloccanti nel proprio perimetro. Non confutano questi percorsi concreti. I due problemi non derivano dalle modifiche locali a `/persona none` e restore.

### «Upstream recupera dopo reload» contro «il crash recovery è solo su main»

**Entrambe le affermazioni sono vere, ma riguardano eventi diversi.**

- **R** ha già runner background separati, sessioni persistite e riuso/riaggancio dei child dopo sostituzione ordinata del runtime, rilanciando lo stesso workflow con le condizioni previste.
- **M** aggiunge gestione dell’owner morto, adozione delle completion, resume per ID, claim e auto-resume.

La distinzione è visibile in `R/src/workflows/workflow-reuse.ts:14–24,94–141` e nel delta che introduce `workflow-auto-resume.ts`, `workflow-resume-claim.ts` e le modifiche alla delivery ownership. **Non attribuisco a R le nuove garanzie post-crash di M.**

### «Abbiamo un limite globale di concorrenza»

Questa formulazione è troppo forte. **Il codice e `docs/STRATEGIES.md` sostengono la precisazione di RELIABILITY**:

- il pool esterno ammette deleghe singole oppure interi council/flow;
- un council occupa **un solo slot**;
- i suoi membri usano un semaphore distinto, per SDK/run.

Quattro council ammessi possono quindi avere ciascuno quattro leg attivi, se i rispettivi limiti lo consentono. Non è necessariamente un bug: evita contesa/deadlock fra i due livelli. Ma `maxConcurrency` **non va presentato come tetto universale alle sessioni worker**.
Evidenza: `P/src/tools/background-run.ts:9–16,106–116`; `P/src/orchestration/sdk.ts:245–253`.

### «Il suffisso `:xhigh` è già un workaround nostro»

**Non è un supporto pubblico uniforme.** Il child adapter conserva un suffisso, ma il resolver in-process cerca il riferimento letterale e la normalizzazione pubblica non garantisce quel percorso. Il valore ordinario deriva dalla configurazione comune.

Upstream R separa invece modello e thinking e passa quest’ultimo alla factory SDK. Quindi accolgo la conclusione concorde delle lenti: **effort per-leg è una lacuna reale nostra**, non una capacità semplicemente poco documentata.

---

## 2. Matrice dei percorsi quotidiani

**Nativo** significa supportato dal prodotto; **workaround** significa ottenibile con operazioni manuali o strumenti generici, senza contratto equivalente.

| Percorso | Pi-subagents | Pi-persona attuale | Conclusione ed evidenza |
|---|---|---|---|
| **Installazione → prima review** | **R:** agenti builtin immediatamente disponibili. | Bundled come sorgente di seed, non discovery live; il percorso consigliato passa da `/persona seed` e scelta della persona. | **Perdiamo sullo zero-setup**, non sulla possibilità di fare review. `R/src/agents/agents.ts:2454`; `P/README.md:29–38`; `P/src/extension.ts:953–962`. |
| **Tre specialisti → una completion** | Workflow e aggregazione tramite `runs.all`; background e consegna raggruppata. | `delegate.tasks`: ricevuta immediata in interattivo, una completion dopo tutti gli esiti terminali. | **Nostro percorso ordinario più diretto**, non capacità esclusiva. `P/src/tools/delegate-tool.ts:660–682`; `P/src/engine/async.ts:342–348`; `R/src/runs/background/completion-replay.ts:185–234`. |
| **Effort diverso per ogni specialista** | **R:** nativo mediante `model: "provider/id:xhigh"` e configurazione agente. | `childThinking` comune, altrimenti livello concreto del supervisor, altrimenti `high`; nessun campo per-leg uniforme. | **Vantaggio upstream netto.** `R/src/shared/model-info.ts:72–81`; `R/src/runs/shared/child-session.ts:563–572`; `P/src/extension/engine.ts:91–95`; `P/src/engine/inproc.ts:254–262`. |
| **Passare contesto senza sprecarlo** | **R:** fresh/fork/profile e output `file-only`. | Fresh e brief esplicito; completion bounded, ma le fasi dei flow incorporano integralmente gli output precedenti. | **Parziale nostro, non controllo end-to-end dei token.** Fork è deliberatamente differito; gli artefatti selettivi sono un miglioramento meno invasivo. `M/docs/tool-reference.md:131`; `P/src/orchestration/flow-run.ts:127–134`; `P/docs/ARCHITECTURE.md:948`. |
| **Chiedere chiarimenti durante il lavoro** | Canale supervisor; **M** corregge l’ask irraggiungibile dietro workflow bloccante, distinguendo errore da risposta. | Bus e broker con ask, timeout e cancellazione; ma alcuni fallimenti invitano a procedere autonomamente. | **Problema nostro da correggere**, senza accreditare la correzione M a R. `P/src/bus/contact.ts:67–132`; `M/src/intercom/native-supervisor-channel.ts:824–845`. |
| **Ispezionare e intervenire** | **R:** FleetView, transcript, thinking, contatori `window`/`spent`, steer e stop. | F9, alias/ruoli, output, waiting/stall, steer/stop e protezione del target selezionato. | **Entrambi seri.** Upstream espone più dimensioni; noi abbiamo un percorso più vincolato. `R/src/tui/fleet-status.ts:54–85,117–126`; `P/src/ui/agent-overlay.ts:209–306`. |
| **Recuperare report lunghi dopo reload** | **R:** output persistito e riferimento compatto `file-only`, anche con salvataggio runtime del risultato di un worker readonly. | Completion automatica limitata; `intercom result` recupera il completo finché resta nel tracker volatile. | **Perdiamo sulla durabilità.** La cronologia visibile non equivale a un servizio di recupero integrale. `R/src/runs/shared/single-output.ts:318–374`; `P/src/engine/async.ts:396–461`; `P/src/core/session-runs.ts:75–86`. |
| **Reload/crash del parent con figli attivi** | **R:** runner separato e riaggancio nei casi supportati di runtime replacement. **M:** ulteriori meccanismi post-crash. | Shutdown annulla i run e segnala il lavoro perso; non è un servizio riagganciabile. | **Vantaggio upstream materiale, qualificato per versione.** `R/src/runs/background/async-execution.ts:765–799`; `R/src/workflows/workflow-reuse.ts:94–141`; `P/src/extension/hooks.ts:283–309`. |
| **Riprendere lavoro precedente** | **R:** retained child/sessioni persistite e continuazione; workflow riutilizzabili. | Journal dei flow: riusa fasi completate, identità flow/task/cwd e checkpoint registrati. Per continuare un writer serve una nuova delega con contesto. | **Non siamo senza resume:** abbiamo resume di fasi, non conversazioni worker generali. `M/docs/tool-reference.md:180,377`; `P/src/orchestration/flow-run.ts:140–157`; `P/src/orchestration/flow-journal.ts:47`. |
| **Creare/modificare agenti e workflow** | **R:** editor, comandi amministrativi, CRUD; script e risorse workflow personalizzate. | Modelli nei settings, definizioni Markdown e reload; DAG configurabili, ma strategie registrate solo nei builtin. | **Perdiamo in authoring e flessibilità.** Configurare un flow non equivale a installare una nuova strategia. `R/src/slash/subagents-admin.ts:386–458`; `R/src/agents/agent-management.ts:1150–1269`; `P/src/orchestration/strategy.ts:1–35`. |
| **Trovare la guida della versione installata** | **R:** guida con topic/sezioni, slash e tool. | Documenti, descrizioni tool e `/doctor`; nessun equivalente richiamabile trovato nel percorso esaminato. | **Perdiamo nella scoperta contestuale.** Doctor diagnostica, non sostituisce una guida operativa. `R/src/extension/subagent-guide.ts:107–132`; `P/src/extension.ts:2217–2293,2704–2710`. |
| **Passare dati strutturati fra step** | **R:** JSON Schema, `structured_output` dedicato e validazione separata dalla prosa. | Contratti dichiarabili scalari: string/number/boolean/enum; estrazione dalla risposta testuale. | **Perdiamo per inventari e findings annidati**, non necessariamente per un voto. `R/src/runs/shared/structured-output.ts:142,380,404`; `P/src/core/contract.ts:12,304,349`. |
| **Isolare e applicare modifiche** | **R:** patch confrontata con `baseCommit`, tramite indice temporaneo. | Worktree fail-closed e applicazione lasciata al supervisor; export rispetto a HEAD finale. | **Buon confine nostro, ma export difettoso:** vedi issue 1. `R/src/runs/shared/worktree.ts:306–342`; `P/src/engine/worktree.ts:54–145`. |
| **Dimostrare l’esecuzione delle verifiche** | **R:** acceptance ledger, comandi host, exit status, output e gate tipizzati. | Contratti di report, reviewer, `map.verify` e checkpoint umano. | **Upstream più completo nella prova runtime.** Una stringa `proof` o un reviewer non equivalgono a una receipt di esecuzione. `R/src/runs/shared/acceptance.ts:1476,1539–1633`; `P/contracts/finding.contract.json:1`; `P/src/orchestration/strategies/map.ts:339`. |
| **Usare CLI esterne** | **R:** adapter espliciti; alcune capacità, fra cui steer/resume/structured output nativo, non sono supportate dal contratto generico. | Shell/monitor come workaround; nessun adapter agente equivalente trovato negli engine/spec esaminati. | **Vantaggio upstream se serve davvero quella CLI**, non motivo sufficiente per una nuova piattaforma. `R/src/runs/shared/external-cli-contract.ts:95–119`; `P/src/extension/engine.ts:148,168`. |
| **Integrare estensioni/MCP** | **R:** API pubbliche di delegazione/registrazione; sessioni SDK con `bindExtensions`. Capability ceilings e piani tool approfonditi anche in M. | Telemetria e settings companion, non API pubblica equivalente di spawn/control; MCP tramite `mcp:true` instradato al child engine. | **Upstream più componibile.** La nostra alternativa MCP esiste, ma richiede opt-in e processo separato. `R/src/api/delegation.ts:6–43`; `R/src/runs/shared/child-session.ts:567–599`; `P/src/extension/engine.ts:268–276`; `P/src/telemetry/contract.ts:1–37`. |
| **Memoria, missioni, scheduler, review automatica** | **R:** memoria agente, missioni, schedule persistenti e watchdog opt-in. | Memoria tramite Mind companion; timer/monitor session-scoped; Exocom per peer indipendenti; review esplicita. | **Differente e parzialmente mancante**, non “noi non abbiamo memoria”. Nudges/stall non sono reviewer automatici; Exocom non è un mission scheduler. `M/src/agents/agent-memory.ts:23,166`; `M/src/runs/background/scheduled-runs.ts:924`; `M/src/watchdog/register-main.ts:380–425`; `P/docs/ARCHITECTURE.md:639–765`. |

**Confidenza alta** sulle differenze di tipi, registri e percorsi letti; **media** sull’ergonomia percepita, sull’intero comportamento distribuito e sulle assenze estese a tutto l’ecosistema.

---

## 3. I due problemi nostri da correggere

### 1 — Export worktree incompleto dopo un commit del worker

**`P/src/engine/worktree.ts:83–109,115–145` · high**

`captureWorktreeArtifact` esegue `git diff HEAD`, ma il worker può aver spostato HEAD creando un commit.

Scenario:

1. modifica A e la committa;
2. modifica B senza committarla;
3. l’export contiene B, ma non A;
4. il chiamante può accettare quel diff non vuoto come risultato del lavoro;
5. il worktree viene rimosso.

Il percorso di accettazione è in `P/src/extension/engine.ts:238–260`. Il rischio dimostrato è **un artefatto incompleto e perdita del percorso ordinario di recupero**, non necessariamente l’immediata eliminazione di ogni oggetto Git del commit.

**Correzione minima:** fissare lo SHA di partenza prima dell’esecuzione e usarlo come baseline dell’export, senza dipendere dall’HEAD finale.

**Test richiesto:** repository Git temporaneo reale; modifica committata + modifica non committata + file nuovo. Applicando il diff alla baseline originale si deve ricostruire l’intero stato finale. Il test attuale dell’export usa fake Git e non dimostra questo scenario: `P/test/unit/engine/worktree.test.ts:55–76`.

Upstream R offre un riferimento concreto, non soltanto una promessa: [`worktree.ts:306–342`](https://github.com/nicobailon/pi-subagents/blob/1bc941363cb62fc23c94c5519364b03dc150be3e/src/runs/shared/worktree.ts#L306).

### 2 — Decisione senza risposta trasformata in invito a procedere

**`P/src/bus/contact.ts:67–70,87–99,110–132` · medium**

Il tool descrive `decision` come una scelta che spetta al supervisor. Eppure nel percorso non bloccante, su timeout e su diversi errori restituisce un invito a usare il proprio giudizio.

**Non è un bypass tecnico dei permessi.** È un comportamento permissivo nel protocollo di supervisione: quando una decisione non è stata ottenuta, il runtime suggerisce autonomia proprio sull’incertezza appena dichiarata. `delivered` non distingue adeguatamente consegna e risposta. Lo stesso tool viene riutilizzato dal bridge child: `P/src/bridge.ts:104–111`.

**Correzione minima:** esiti espliciti `answered | unavailable | timed-out | cancelled`; per una `decision` irrisolta nessun invito ad assumere la decisione. Consentire soltanto lavoro indipendente già autorizzato e restituzione del blocco/risultato parziale. **Non introdurre attesa bloccante nel percorso headless**, che creerebbe un deadlock.

**Test richiesto:** headless, timeout, disconnessione broker e cancellazione non devono produrre approvazioni sintetiche o istruzioni a risolvere autonomamente la decisione. Il test corrente del downgrade consolida invece il comportamento: `P/test/unit/bus/contact.test.ts:82–94`.

Il confronto utile è la correzione **M, non R**, in [`native-supervisor-channel.ts:824–845`](https://github.com/nicobailon/pi-subagents/blob/4cce6ebf5d4c6d0e45d22549aa687ea28562e4a9/src/intercom/native-supervisor-channel.ts#L824); verificata anche nel `post-release.diff:656–695`.

---

## 4. Pacchetto vicino termine: cinque interventi, non una riscrittura

Le priorità delle lenti differivano. **Scelgo prima correttezza, poi i due attriti d’uso già concreti, infine qualificazione distributiva.** Guida, editor e ottimizzazioni non vengono negati: vengono dopo, invece di gonfiare il primo pacchetto.

| Ordine | Intervento minimo e patrimonio esistente | Rischio principale | Criterio di accettazione |
|---|---|---|---|
| **1 · P1** | **Baseline stabile dell’export worktree.** Conservare isolamento fail-closed e applicazione manuale del diff. | Alterare cattura/cleanup; non serve ridisegnare Git isolation. | Il test applicativo dell’issue 1 ricostruisce tutte le modifiche senza toccare il checkout principale. |
| **2 · P1** | **Ask irrisolto ≠ autorizzazione.** Riutilizzare bus, timeout, correlazione e abort; cambiare esplicitamente il contratto dell’esito. | È un cambiamento comportamentale, non un refactor. Evitare nuovi deadlock. | I casi dell’issue 2 mantengono diagnosi e parziali, senza risposta inventata né via libera implicito, su entrambi i backend. |
| **3 · P1** | **Thinking per-leg.** Campo tipizzato in agente/run-spec/delegate/roster, con una sola precedenza documentata e parità dei due engine. | Divergenza tra schema, resolver e capacità provider. Nessun cambio provider/billing. | Batch `low/high/xhigh`: entrambe le factory ricevono i valori corretti; omissione conserva il comportamento attuale; valore invalido rifiutato prima dello spawn; livello non supportato non dichiarato applicato. |
| **4 · P1** | **Archivio bounded dei risultati terminali.** Un owner, riferimenti versionati, recupero per porzioni; partire dal principio già usato da `monitor/archive.ts`, non da un daemon. | Privacy, budget disco/sessione, ID, corruzione e cleanup. Non fingere che “risultato salvato” significhi “worker vivo”. | Tre reviewer readonly producono report grandi: una completion resta bounded; i report sono recuperabili dopo reload senza modello, respawn o seconda completion. Storage pieno/troncamento non producono riferimenti falsi. La modalità riferimento dei flow non ricopia il corpo completo. |
| **5 · P1 di verifica** | **Qualificare il pacchetto installato su floor e host corrente.** Integrare lo smoke isolato esistente; provider faux per i percorsi delega/stop/shutdown. | Costo della matrice CI; selezionare confini reali, non ogni combinazione possibile. | Tarball installato in profilo pulito, Pi minimo promesso e corrente, peer provenienti dall’host, entrambi i backend e shutdown. Nessuna chiamata provider reale. |

### Perché effort e archivio prima delle funzionalità più ambiziose

**Effort:** upstream R lo supporta già nel normale dispatch, tramite suffisso del modello — non un generico campo top-level `thinking` del tool ordinario. L’API extension-to-extension ha una propria forma strutturata. Il nostro `childThinking=xhigh` risolve solo il caso in cui tutti i figli debbano usare lo stesso livello. Supportare la selezione non garantisce comunque che ogni provider implementi `xhigh`.

**Archivio:** noi abbiamo già notifiche bounded, `intercom result`, journal flow e archivio monitor. Il problema non è “aggiungere persistenza ovunque”, ma separare chiaramente:

- contenuto completo;
- riferimento stabile;
- presentazione compatta;
- disponibilità e retention.

Oggi la completion bounded non impedisce l’amplificazione successiva: `buildPhaseTask` concatena integralmente gli output upstream (`P/src/orchestration/flow-run.ts:127–134`). Inoltre un diff oltre 1.000.000 di caratteri fallisce l’export e il worktree viene comunque eliminato (`P/src/engine/worktree.ts:32,87,125`). Sono motivi concreti per migliorare gli artefatti, **non per rendere subito persistenti i processi**.

---

## 5. Passi successivi, subordinati a bisogno o misura

| Proposta | Minimo utile / perché non subito | Esperimento decisivo |
|---|---|---|
| **Guida contestuale e onboarding** | `/persona help [topic]` dai documenti distribuiti, senza secondo manuale. Rendere seed, scelta e prima review trovabili dentro Pi; non auto-installare per imitare upstream. | Profilo vuoto: un utente ottiene tutti i passi senza cercare sul web. Guida/doctor non scrivono né avviano modelli. |
| **Editor leggero delle definizioni** | `show/edit/clone`, provenienza e scope espliciti, file come unica fonte. Non tutto il CRUD model-callable. Upstream stesso distingue update, eject e override settings. | Annullare non cambia byte; input invalido preserva il file; shadowing project/user visibile; worker attivi conservano lo snapshot; restore conserva `pippo`/`pluto`. |
| **Contratti strutturati annidati** | Estensione versionata e bounded per array/oggetti, mantenendo i contratti scalari. Non promettere “JSON Schema completo” senza definirne il sottoinsieme. | Array di findings con campi richiesti/enum/limiti; invalido non accettato dal reducer; pinning invariato durante il run; parità backend. |
| **Check host con receipt** | Comando nominato in configurazione fidata, invocazione esplicita, cwd/exit status/output bounded. Non interpolare prosa worker nel comando. | Il worker dichiara successo ma il comando fallisce: resta fallimento. Cancellazione non è successo; verifica nel worktree corretto; cambi degli input rendono vecchia la prova. |
| **Budget misurati di schema e prompt** | Harness SDK faux che osservi il payload reale prima di alleggerirlo. Upstream ha test con soglie di 500/5.500 caratteri, ma non vanno copiate senza baseline nostra. | Misure separate per schema, brief e altri blocchi; nessuna crescita su turni identici; permessi, billing e discovery preservati. |
| **Catalogo flow riusato** | Il nostro brief rilegge/riparsa i flow prima di limitarne la lista. Snapshot con una sola regola di invalidazione; chiarire prima se si perde visibilità immediata delle modifiche esterne. | Due turni invariati non ripetono letture/parsing completi; reload/add/remove/override aggiornano il catalogo; esecuzione valida comunque il flow. |
| **Un’API di delegazione o un adapter CLI** | Solo per un consumer concreto; una seam versionata request/status/cancel/result, oppure una CLI effettivamente usata. | Consumer reale, ownership e teardown testati, capacità non supportate dichiarate. Non esposizione indiscriminata degli interni. |

Evidenze principali: `P/src/extension.ts:1906–1943,2177–2189` per il catalogo flow; `M/test/smoke/tool-activation.test.ts:75–143` per il test del payload upstream; `P/src/monitor/archive.ts:7–33,109–116` per il precedente di archivio.

Va chiarito anche il linguaggio pubblico: **agenti e DAG sono configurabili senza modificare il pacchetto; una nuova strategia eseguibile oggi richiede registrazione nel core**. Il loader di strategie utente è futuro, come dichiara `P/src/orchestration/strategy.ts:1–5`.

---

## 6. Le nostre forze difendibili

Non sono esclusive né prove che i modelli producano risultati migliori.

- **Percorso interattivo poco ambiguo.** `delegate` non espone la scelta sync/async; un fan-out attende tutti gli esiti terminali prima della completion aggregata. Ask e completions hanno gestione distinta.
  `P/src/extension.ts:1132–1180`; `P/test/unit/engine/async.test.ts:1293–1331`.

- **Topologie di review con regole nel runtime.** Critic-loop richiede `approve`, conserva il dissenso e non restituisce come approvata una revisione finale mai verificata. Il giudice riceve candidati rietichettati e riordinati. I checkpoint umani bloccano i dipendenti senza cancellare l’output utile.
  `P/src/orchestration/strategies/critic-loop.ts:103–173`; `P/src/orchestration/judge.ts:52–78`; `P/src/orchestration/flow-run.ts:252–320`.

- **Controlli UI mirati.** La selezione F9 è ancorata all’identità; se il target scompare, il primo comando diretto viene consumato per ri-orientare la selezione, non applicato a un altro worker. Coalescing a 16 ms e deduplica delle proiezioni sono implementati e testati.
  `P/src/ui/agent-overlay.ts:220–265`; `P/src/extension.ts:747–855`; `P/test/integration/extension.test.ts:5935–5982`.

- **Cancellazione difensiva durante la costruzione in-process.** Una factory tardiva viene smaltita e il guard ref-counted resta valido fino alla sua conclusione. **Questo libera il controllo, non garantisce l’arresto fisico di codice arbitrario nello stesso processo.**
  `P/src/engine/inproc.ts:437–474,590–650`; `P/test/unit/engine/inproc.test.ts:1549–1612`.

- **Provenienza esplicita dell’output.** Fence condiviso, rimozione dei controlli terminale e attribuzione fuori dal corpo non fidato; il percorso di completion lo usa. **Mitigazione, non barriera assoluta alla prompt injection.**
  `P/src/core/fence.ts:114–149`; `P/src/extension.ts:1156`.

- **Distribuzione e configurazione più contenute.** Nessuna dipendenza runtime, peer dell’host e nessun build; registro settings comune e owner persistente unico. Il workflow CI esaminato usa Action fissate a SHA completi, permessi read-only e checkout senza credenziali persistite.
  `P/package.json:34–60,73–119`; `P/src/core/settings.ts:40–66`; `P/.github/workflows/test.yml:7–28`.

Due limiti importanti a questa lista:

1. **Upstream non ha una UI ingenua:** possiede caching del rendering e widget persistenti (`M/src/tui/render.ts:2947–3030,3118–3150`). I nostri test nativi Markdown sono un punto forte specifico, non una vittoria sull’intera TUI.
2. **Noi non siamo “senza infrastruttura”.** Telemetria con storage/heartbeat, broker, Exocom e due engine hanno costi e lifecycle propri (`P/src/extension/hooks.ts:237–280`; `P/src/telemetry/producer.ts:38–43`). Poche dipendenze non dimostrano minore latenza o memoria.

---

## 7. Cosa non copiare, e perché

### Non trasformare subito Persona in un servizio persistente

Upstream gestisce owner, identità processo/boot, claim esclusivi, journal, replay, deduplicazione e retention. È il costo necessario per una capacità utile, non complessità gratuita.

Prima di adottarla dobbiamo decidere chi possa fermare il lavoro dopo la chiusura, chi risponda agli ask, quando cessi la spesa e come evitare doppie scritture dopo due riaperture concorrenti. **Archivio dei risultati e sopravvivenza dei worker sono due progetti diversi.**

Riferimenti: `M/src/runs/background/result-delivery-ownership.ts:21–57`; `M/src/workflows/workflow-auto-resume.ts:31–108`. Anche una retention dichiarata di 30 giorni non è necessariamente un hard cap disco: i riferimenti protetti possono sopravvivere (`M/src/runs/background/async-retention.ts:17–35,189–205`).

### Non copiare i badge di acceptance senza la semantica

Upstream distingue meglio attestazione e verifica, ma:

- `checked` può comprendere controlli sulla presenza delle dichiarazioni;
- un typed gate tecnicamente verificato può restituire `verdict: "blocked"`;
- la cache delle verifiche considera lo stato Git tracked: il test conferma il riuso dopo una modifica untracked.

Quindi **esecuzione riuscita, schema valido, verifica eseguita e approvazione sono stati distinti**. Se aggiungiamo check host, partirei senza caching delle verifiche.

Evidenza: `M/src/runs/shared/acceptance.ts:1071–1098`; `M/test/unit/typed-gate-output.test.ts:89–97`; `M/test/unit/acceptance.test.ts:1369–1397`.

### Non rendere fork il default

Riduce la fatica di preparare un brief, ma può trasferire storia irrilevante, dati sensibili e istruzioni vecchie, anche verso un altro provider. **Fresh resta un default ragionevole; il costo del confezionamento del contesto rimane però reale.** Prima artefatti selettivi; eventuale fork solo esplicito, approvato e misurato.

### Non importare insieme script runtime, missioni, scheduler e watchdog

Un runtime JavaScript model-authored richiede parsing, isolamento operativo, osservazione delle promise, cancellation, replay e grants. Uno scheduler o reviewer continuo introduce ulteriore autorità e consumo. Mind, timer e monitor non sono equivalenti, ma non giustificano automaticamente un secondo owner permanente. Valutare companion quando emerge un uso ricorrente.

### Non aggiungere build, lazy loading o quindici API per simmetria

- Il packaging bundled upstream è **già in R**, non una promessa futura.
- Il nostro grafo statico viene caricato prima del guard disabled/bridge: no-build non implica startup più rapido.
- Un entrypoint leggero può avere senso **solo dopo una misura**.
- Lazy tool activation upstream è adattiva: `auto` può scegliere eager; non è gratis né sempre applicabile.
- Cache del catalogo modelli, cache del provider e risparmio token sono tre cose diverse.

Evidenza: `R/scripts/build-package.mjs:67–118`; `R/src/extension/tool-activation.ts:45–130`; `P/src/extension.ts:14–140,311–325,2108–2135`.

Non copierei neppure la nuova task preview di M nelle nostre card collassate: è post-release e contrasta con la preferenza locale per identità/stato compatti.

---

## 8. Limiti, decisioni richieste e caso “non fare altro”

### Cosa è verificato e cosa no

Questa è una **sintesi critica con ricontrolli mirati di sorgenti e test**, non un audit completo dei due repository. Ho ricontrollato direttamente i due must-fix, la concorrenza, il percorso thinking, il passaggio di contesto dei flow, il riuso pubblicato, il salvataggio output e parti del delta post-release.

- Nessuna modifica, installazione, build, test, benchmark o chiamata provider eseguita.
- Nessun agente aggiuntivo avviato.
- I test citati sono evidenza delle asserzioni presenti, **non esiti riprodotti qui**.
- Il risultato locale comunicato — **2.554 test, 2.552 pass, 2 skip Windows intenzionali** — e i precedenti smoke live restano evidenza fornita, non nuova verifica comparativa.
- La CI del main upstream fissato è **cancelled**; il verde precedente riguarda un altro commit (`upstream-ci.json:1`).
- Il test M di parent ucciso è POSIX-only e usa child simulati; quello di adozione delle completion verifica importanti controlli negativi, ma non prova “exactly once” universale: `M/test/integration/workflow-owner-killed.test.ts:117–166`; `M/test/integration/result-watcher.test.ts:272–302`.
- RPC, watchdog, scheduler, fork, adapter esterni, Exocom e companion non sono stati auditati integralmente.
- Issue chiuse, stelle, fork, conteggi di file/test e screenshot non sono stati usati come prova di correttezza o prestazioni.

La nostra CI Windows/Linux è utile, ma non sostituisce uno smoke del tarball sul **floor Pi 1.0 dichiarato**; upstream qualifica invece anche host reali/clean install e standalone in percorsi dedicati. Questo è un gap di verifica, **non prova che siamo incompatibili**.

Le modifiche locali restano rispettate: viene rimosso l’alias `/persona none`, non `/persona off`; restore sovrascrive le destinazioni bundled senza eliminare file aggiuntivi come `pippo` e `pluto`.

### Decisioni che richiedono approvazione

Prima di implementare servono scelte esplicite su:

- precedenza e diagnostica dell’effort per-leg;
- retention/privacy dell’archivio;
- nuovo comportamento delle decisioni senza risposta;
- eventuale autorità dei check host;
- qualunque fork, processo persistente, auto-resume o API pubblica.

Non propongo nuovi `wake_on`, favorites/recents, fallback provider silenziosi o cambiamenti impliciti di billing.

### Il caso serio per non fare altro

Se il lavoro è breve, resta nella sessione aperta, usa effort uniforme, report piccoli e definizioni raramente modificate, **pi-persona soddisfa già bene il bisogno**. In quel caso è ragionevole correggere i due problemi e rinviare le espansioni.

Se invece il lavoro è lungo, produce artefatti importanti o richiede riprendere il medesimo worker, **pi-subagents oggi offre un vantaggio concreto, anche fermandosi alla release pubblicata**. Definirlo soltanto “più grosso” nasconderebbe problemi nostri reali.

**Decisione finale consigliata:** mantenere il nostro modello di supervisione, correggere i due difetti, aggiungere effort per-leg e archivio terminale bounded, poi qualificare il pacchetto su host reali. **Nessuna riscrittura e nessuna implementazione autorizzata da questo studio.**
