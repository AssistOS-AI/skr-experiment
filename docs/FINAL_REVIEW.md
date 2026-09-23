# Review de integrare SKR — 23 septembrie 2026

**Stare: review final în curs.** Documentul înlocuiește review-ul vechi al prototipului. Verificările consolidate și comparația live pe snapshotul corectat trebuie închise înaintea verdictului final.

Autoritate: [specificația originală](../vision/Semantic_Knowledge_Resolution_Compact_Specification.docx). Contractul de implementare extins este [COMPLETION_TASKS.md](COMPLETION_TASKS.md).

## Organizarea implementării

Implementarea aparține celor trei subagenți Codex `gpt-6-luna`: storage/ingestie, motor/evaluare și runtime/API/UI. Coordonatorul a analizat documentul, definit taskurile și interfețele, revizuit codul și executat verificări independente. Regula persistentă este în [AGENTS.md](../AGENTS.md). Aplicația fixează modelul `gpt-6-luna`; testele/demo deterministe sunt moduri explicite, fără fallback automat.

## Interpretarea specificației

Documentul cere un sistem de cunoaștere cu proiecte și fork-uri, nu doar interogarea unor fișiere. Contractele centrale sunt snapshotul imuabil per execuție, sursele autorizate, calificările epistemice, identitățile reversibile, dovezile redeschizabile și publicarea tranzacțională validată. Procedurile sunt definiții versionate reutilizabile; constatările lor rămân interpretări cu dovezi și dependențe. Acoperirea tuturor regiunilor nu dovedește extragerea tuturor faptelor.

Evaluarea separă corectitudinea software de eficacitatea semantică: seturile controlate verifică reguli și stări; întrebările literare necesită judecăți independente și adjudecare umană. O comparație pe o întrebare verifică funcționarea experimentului, nu stabilește un clasament general.

## Capabilități verificate

| Domeniu | Implementare și dovezi |
| --- | --- |
| Proiecte | Snapshoturi imuabile, originale cu hash, CAS și blocare între procese, fork-uri izolate, diff/ancestry/rebase, invalidare tranzitivă, aprobare exactă a versiunilor. |
| Runtime | Toate cele șase taskuri, sesiuni Codex persistente, reluare după restart, anulare, skilluri versionate aprobate, validarea modificărilor și publicare controlată. |
| Autorizare/izolare | Autentificare, ACL pe proiecte, teste cu identități distincte și bubblewrap. Proba independentă ascunde fișierul host, refuză scrierea în sursa fixată și permite scratch. |
| Motor | SKE, unificare, join-uri cu variabile comune, reguli relevante, calificări și opoziții, agendă semantică limitată, verificare separată a afirmațiilor și checkpointuri. |
| Surse | Text, formate structurate, DOCX, PDF text/OCR și EPUB; locatori, inventar și ledger; indexuri structurale și BM25; reconciliere/undo și context între loturi. |
| Proceduri | Contradicții, sinteză după relevanță, rubrică literară cu patru criterii. Dovezi și contraexemple, parametri/versiuni exacte, persistență, invalidare și recomputare. |
| UI | Autentificare, proiect/fork, surse și acoperire, metode, aprobări, istoric/reluări, dovezi și export. Fluxul Chrome/Playwright și captura au fost verificate. |
| Evaluare | Șase implementări executabile, embeddings și reranker ONNX reale, fixture-uri fixate prin hash, separarea răspunsurilor de gold, două regimuri, contabilizare și evaluatori separați. Verificarea finală a rapoartelor este în curs. |

## Dovezi independente deja obținute

- `npm run demo`: trecut după corectarea regresiei de autentificare; join susținut de două regiuni distincte.
- `npm run eval:controlled`: trecut pe 346 de cazuri. SKR Full: clasificare 1,00; SKR Direct: 0,7341. Acestea sunt rezultate structurale sintetice.
- `npm run eval:procedures`: 60/60 contracte procedurale trecute.
- `npm run eval:mutations`: 60/60 cazuri trecute, împărțite între surse, proceduri, fork-uri și rebase.
- Suite focalizate independente: 11/11 integrare și 8/8 ingestie/freeze; numărul suitei consolidate va fi consemnat la încheiere.
- Corpus: cinci cărți complete, cu checksum și proveniență; 100 de întrebări semantice și 148 de fragmente verificate exact în originale, fără nepotriviri. Toate întrebările au verificare separată Luna și rămân în așteptarea adjudecării umane. Există și 60 de sarcini procedurale pe cărțile complete.
- [Testul HTTP cu toate taskurile](../artifacts/runtime-live-api-2026-09-23.json): toate terminate; patru taskuri au folosit Luna, auditul și evaluarea structurală au avut zero apeluri model și sunt etichetate ca atare. Întrebarea a rămas nerezolvată, cu audit valid.
- [Proceduri pe Peter Rabbit](../artifacts/peter-rabbit-corrected-offset-procedures-2026-09-23.json): fiecare metodă a procesat 137/137 regiuni ale operei; 310 regiuni de metadate/licență au fost excluse explicit. Rezultate: 0 contradicții, 1 sinteză, 4 constatări literare. Coordonatorul a verificat SHA-256 și 16/16 citate direct în fișierul original.
- [Ingestia corectată](../artifacts/peter-rabbit-corrected-ingestion-2026-09-23.json): 447/447 regiuni procesate, 9 afirmații acceptate și o constatare contextuală. Interogarea structurală `(count rabbits 4)` a rămas nerezolvată; nu este prezentată drept test de acuratețe reușit.

## Corecții cerute de review

Review-ul a identificat și trimis agenților probleme concrete: locatori CRLF raportați în coordonate diferite de original; interpretări confundate cu fapte; relații din subobiective tratate greșit drept răspuns principal; goluri în contextul dintre loturi; versiuni draft care dezactivau metoda curentă; coliziuni la rebase; dovezi procedurale temporare pierdute; reutilizare necorespunzătoare a constatărilor; audit care pierdea raportul la găsirea unei probleme; costuri cumulative duble și costuri de preprocesare omise; diferențe între comenzile documentate și cele executabile. Corecțiile sunt acceptate prin regresii și probe, nu doar prin afirmațiile agenților.

Rapoartele vechi cu locatori normalizați sau limite greșite ale operei sunt păstrate exclusiv ca diagnostice supersedate. Nu intră în validarea finală. Nu au fost inspectate sau publicate credențiale; scanarea artefactelor nu a găsit copii `auth.json`/`codex-home`.

## Verdict

În curs: suita consolidată, integrarea finală a procedurilor temporare/precomputării și comparația live corectată. Adjudecarea umană a interpretărilor și un studiu comparativ complet rămân distincte de acceptarea software; rezultatele modelului nu sunt etichetate drept judecăți experte.
