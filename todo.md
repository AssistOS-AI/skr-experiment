# TODO — SKR

Oprit explicit la cererea utilizatorului, 23 septembrie 2026. Subagenții Luna au fost întrerupți. La oprire nu au fost găsite procese active de evaluare/generare sau `codex exec` ale taskului. Nu s-au făcut commituri.

**Atenție:** ultimul checkpoint verificat integral avea **120/120 teste trecute, fără skip**. Au urmat modificări întrerupte; acest rezultat NU certifică starea curentă a tuturor fișierelor. În special, comanda de pregătire a corpusului este momentan incompletă.

## 1. Închiderea comenzii de corpus — blocant

Responsabili: `luna_storage` (builder) și `luna_runtime` (pregătirea workspace-ului).

- [ ] Finalizat `src/runtime/session-workspace.mjs`, importat deja de `src/evaluation/book-snapshot-builder.mjs`, dar absent la oprire. Export așteptat: `preparePinnedIngestionWorkspace(...)`.
- [ ] Helperul trebuie să pregătească request/snapshot/surse fixate și skillurile de ingestie aprobate, cu scope exact și inputuri readonly pentru sesiunea Codex Luna.
- [ ] Corectată utilizarea `workspacePath` înainte de declarație în builder (apelul `mkdir` rămas înaintea calculării noii căi).
- [ ] Verificat că sesiunea și checkpointul sunt legate de store/proiect/snapshotul de intrare; două store-uri sau două versiuni ale corpusului nu trebuie să împartă istoricul Codex.
- [ ] Întreruperea trebuie să reia același input și aceeași sesiune. Repetarea după succes trebuie să reutilizeze markerul de finalizare fără reingestie inutilă.
- [ ] Validarea receipt-urilor înainte de commit, exportul atomic și costul măsurat trebuie păstrate.
- [ ] Rulate `tests/book-snapshot-builder.test.mjs` și o probă CLI fără model pe cele cinci cărți; verificată o reluare cu sesiuni mock distincte între invocări. Nu este necesară o nouă ingestie live completă pentru această corecție.

## 2. Închiderea evaluării și contabilizării — review restant

Responsabil: `luna_engine`; runtime consumă rezultatele prin `src/runtime/run-accounting.mjs`.

- [ ] Revizuite ultimele modificări din `src/evaluation/baselines.mjs` și `scripts/run-live-comparison.mjs`; unele au fost scrise după suita 120/120 și nu au fost acceptate final.
- [ ] Costurile observate acum trebuie separate de preprocesarea istorică. În codul de la oprire există sesiuni cu `historical:true`; verificat că acestea NU intră în totalul apelurilor curente, inclusiv în `usageTotal` și agregarea HTTP.
- [ ] GraphRAG pe cache hit trebuie să păstreze costul construirii indexului pentru amortizare și să raporteze zero apeluri noi de construire. Costurile SKR trebuie preluate din raportul real de ingestie/materializare, nu presupuse zero.
- [ ] Păstrate ID-urile, numărul cererilor și costurile tuturor sesiunilor: interpretare/răspuns, preprocesare, evaluator, inclusiv apeluri eșuate dacă există usage măsurabil.
- [ ] Verificate costurile cu tarif opțional datat: input cached fără dublare, etapă neaplicabilă distinctă de cost necunoscut; fără tarif, sumele monetare rămân null.
- [ ] Verificate metricile pe reuniunea intervalelor din sursa originală: citatele duplicate nu trebuie să umfle recall-ul; `start/end` și `startChar/endChar` trebuie normalizate identic pentru SKR și RAG.
- [ ] Verificate gold-ul adjudecat prioritar, excluderea cazurilor respinse și lipsa scorurilor de acuratețe când referința este null. Gold-ul nu ajunge la agenții care răspund.
- [ ] Verificată impunerea `.lock.json` pe toate traseele de evaluare din CLI și HTTP, nu doar existența fișierelor lock.
- [ ] Verificate fingerprintul complet al checkpointului, validarea parametrilor CLI, rezumatele paired/bootstrap și propagarea aceleiași definiții/parametrizări de rubrică la toate metodele.
- [ ] Rulată evaluarea offline pe setul semantic de 100 de întrebări și verificate comenzile documentate pentru cele 60 de sarcini procedurale pe cărți complete. Nu confundați acestea cu cele 60 de teste structurale de proceduri.

## 3. Comparația live finală — încă NERULATĂ

- [ ] Rulat un experiment mic, pe același caz, cu toate cele șase metode și Codex `gpt-6-luna`, în regimurile `quality-first` și `equal-budget`.
- [ ] Folosit snapshotul corectat: `artifacts/peter-rabbit-corrected-ingested-snapshot-2026-09-23.json`; actualizate fixture-ul smoke și lock-ul pentru sursa/locatorii corecți înaintea rulării.
- [ ] Folosite sesiuni distincte pentru GraphRAG preprocessing, răspunsuri și evaluatori; reutilizat același index între regimuri, cu costul istoric păstrat.
- [ ] Verificată acoperirea reală a profilului nou de batching GraphRAG; păstrate eșecurile și depășirile de buget în raport.
- [ ] Nu relansați sute de cereri plătite pentru a obține un scor preferat. Acest smoke verifică funcționarea experimentului, nu un clasament științific.

Primul raport cu șase metode, `artifacts/research/live-peter-rabbit-quality-first-initial.json`, este diagnostic istoric. Folosește snapshotul anterior corectării locatorilor și nu are evaluare comună finală. Tentativa ulterioară pe același snapshot vechi a fost oprită. La oprirea cerută de utilizator nu exista o comparație finală live activă.

## 4. Verificare și documentație finală

- [ ] Verificată mica ajustare CSS cerută pentru rândul sursei: checkbox/nume/Inspect pe primul rând, acoperire și detalii dedesubt. Captura existentă încă înghesuia textul acoperirii. Nu este necesar redesign.
- [ ] După închiderea modificărilor: `npm test`, `npm run demo`, `npm run eval:controlled`, `npm run eval:procedures`, `npm run eval:mutations`, evaluarea book offline și verificările CLI relevante. Rulați suita completă o dată pe un checkpoint stabil.
- [ ] Actualizate `docs/FINAL_REVIEW.md` și `docs/ACCEPTANCE_MATRIX.md` cu rezultatele finale. Sunt încă documente de review în curs, nu certificate de finalizare.
- [ ] Aliniate README și `docs/EVALUATION.md` la comenzile și artefactele finale; eliminată utilizarea snapshotului vechi din exemplul live.
- [ ] Verificat că livrabilele nu conțin `auth.json`/`codex-home` sau sesiuni private; originalul DOCX trebuie păstrat nemodificat.

## Ce este deja verificat și nu trebuie refăcut fără motiv

- Implementare realizată de cei trei subagenți `gpt-6-luna`; regula este în `AGENTS.md`. Coordonatorul a făcut delegare, review și verificări, nu implementarea aplicației.
- Ultima suită integrală a coordonatorului: 120/120, în `/tmp/skr-final-suite.log` (log temporar, poate dispărea).
- Demo corectat și verificat: join susținut de două regiuni.
- Evaluări independente: 346 cazuri controlate trecute, 60/60 contracte procedurale, 60/60 mutații/fork/rebase.
- Toate cele șase taskuri prin server: `artifacts/runtime-live-api-2026-09-23.json`. Patru au folosit Luna real; auditul și evaluarea structurală au avut zero apeluri model. Întrebarea a rămas nerezolvată, cu audit valid.
- HTTP QUESTION cu metodă explicită: receipts validate, audit care traversează constatarea temporară, snapshot durabil neschimbat, dovezi păstrate în explain/export.
- Precomputare `on-ingestion`: doar metode aprobate și opt-in, skilluri verificate înaintea apelurilor, un singur change set validat. Regresiile au trecut.
- Autentificare/ACL, izolare bubblewrap, sesiuni persistente/resume, anulare, OCR/PDF/EPUB, reconciliere/undo, context între loturi și proceduri versionate au teste și probe consemnate în review.
- Cinci cărți complete, checksum-pinned; 100 întrebări semantice, 148 citate verificate exact în originale, toate cu review separat Luna. Gold-ul rămâne propus, nu uman.
- Hashul curent al fixture-ului QA după adăugarea provenienței: `f8aee4b6197c32faeda974de4c6e53bf0ec06a48c638d96b0df6f962050545d2`, freeze version 2. Hashul mai vechi din matricea de lucru trebuie actualizat.
- Ingestia corectată Peter Rabbit: 447/447 regiuni procesate, 9 afirmații acceptate + 1 constatare contextuală. Toți locatorii și citatele acceptate au fost verificați independent. `(count rabbits 4)` a rămas nerezolvat; nu pretindeți că procesarea regiunilor garantează completitudine semantică.
- Cele trei proceduri reale: fiecare pe 137/137 regiuni ale operei, 310 regiuni de metadate/licență excluse explicit; 0 contradicții, 1 sinteză, 4 constatări literare. Raport: `artifacts/peter-rabbit-corrected-offset-procedures-2026-09-23.json`.

## Dependență externă reală

Adjudecarea umană a răspunsurilor/interpretărilor propuse și un studiu comparativ complet nu sunt realizate. Există export/import CSV pentru QA. Nu atribuiți modelelor statut de expert uman și nu prezentați smoke-ul drept validare științifică completă.

**Nu reluați implementarea sau apelurile live fără o nouă instrucțiune a utilizatorului.**
